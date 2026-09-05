# Snore Timeline Ratings Tracker

App Store ratings and keyword-rank dashboard for [Snore Timeline](https://snoretimeline.com): GitHub Actions collect the data, GitHub Pages serves it. No server, no database.

**Dashboard**: https://mtuck063.github.io/snore-ratings-tracker/

Nothing here is app-specific by nature. Point it at any App Store app and it
tracks that one instead; [Run it for your own app](#run-it-for-your-own-app)
below is the checklist.

## What it collects

| Pipeline | Script | Runs | Writes |
| --- | --- | --- | --- |
| Ratings, star histograms, written reviews | `scripts/collect.mjs` | hourly | `latest.json`, `history.json`, `histograms.json`, `events.json`, `reviews.json` |
| Search rank and demand per keyword per market | `scripts/keywords.mjs` | 4x daily | `keywords.json`, `kw-events/` |
| Website visitors, optional | `scripts/pageviews.mjs` | with ratings | `pageviews.json` |
| Intent, coverage and priority per keyword | `scripts/aso.mjs` | with keywords | `aso.json`, `metadata.json` |
| What a release changed, and what it did | `scripts/release.mjs` | by hand, then with keywords | `releases.json` |
| Apple's popularity index, optional | `scripts/popularity.mjs` | by hand | `popularity.json` |
| Freshness check | `scripts/check-freshness.mjs` | 4x daily | opens an issue |

Two more scripts are manual, for growing the keyword list rather than tracking
it: `kw-harvest.mjs` pulls candidate phrases out of Apple's autocomplete, and
`kw-discover.mjs` relevance-tests them with real searches.

Every source is public and unauthenticated: the iTunes lookup and search APIs,
the storefront web page, the search-hints autocomplete endpoint, and the
customer-reviews RSS feed. The only credential in any scheduled workflow is an
optional GoatCounter token.

One script sits outside that and is run by hand:
[Apple's popularity index](#apples-own-popularity-index-optional) needs an Apple
Ads session cookie. It is deliberately not wired into any workflow, for reasons
worth reading before you reach for it.

## Health

[![Collect ratings](https://github.com/mtuck063/snore-ratings-tracker/actions/workflows/collect.yml/badge.svg)](https://github.com/mtuck063/snore-ratings-tracker/actions/workflows/collect.yml)
[![Track keywords](https://github.com/mtuck063/snore-ratings-tracker/actions/workflows/keywords.yml/badge.svg)](https://github.com/mtuck063/snore-ratings-tracker/actions/workflows/keywords.yml)
[![Watchdog](https://github.com/mtuck063/snore-ratings-tracker/actions/workflows/watchdog.yml/badge.svg)](https://github.com/mtuck063/snore-ratings-tracker/actions/workflows/watchdog.yml)

Each badge shows that workflow's last run. The watchdog is the one that matters:
the collectors carry previous values forward rather than fail, so a run that
fetched nothing still passes. The watchdog checks that
[`status-ratings.json`](docs/data/status-ratings.json) and
[`status-keywords.json`](docs/data/status-keywords.json) are actually advancing —
ratings within 12 hours, keywords within 16 — and opens an issue if not. One
heartbeat file per collector, because a shared one gave the two workflows a
rebase conflict the first time they overlapped.

The dashboard shows the same thing, and says nothing at all while healthy: a
red "Collector stalled" appears in the header line only when a heartbeat has
gone quiet or fetches are failing.

Failures raise a GitHub issue rather than only an email, one open issue per
failure kind with repeat occurrences as comments. Closing the issue is how you
acknowledge it; the next failure opens a fresh one.

Known gap: the watchdog is itself a scheduled workflow, so it can't report
Actions being disabled for the repo. Nothing inside GitHub can.

## Run it for your own app

Budget an hour. Steps 1 to 5 are mechanical, step 6 is where the thinking is.

### 1. Copy the repo

Fork it, or clone and push to a fresh repo. A fresh repo is easier to live with:
forks start with Actions disabled, and their issue notifications route oddly.

Clear the previous app's data, which is checked in:

```sh
rm -rf docs/data/kw-events
rm docs/data/{latest,history,events,reviews,keywords,histograms,pending,pageviews,glossary,aso}.json
rm docs/data/status-*.json
```

`scripts/metadata.json` describes the previous app's listing, so empty its
`markets` entries down to `{}` each. The next `--fetch` refills title and
subtitle; the keyword fields are yours to paste in.

Every script treats a missing data file as a cold start, so nothing else needs
resetting.

### 2. Point it at your app

Your app id is the number in its App Store URL: `apps.apple.com/us/app/…/id6751759381`.

The id appears in both collectors, the discovery probe and the dashboard, so
replace it everywhere at once:

```sh
grep -rl 6751759381 scripts docs | xargs sed -i '' 's/6751759381/YOUR_APP_ID/g'   # GNU sed: -i
grep -rl mtuck063/snore-ratings-tracker docs | xargs sed -i '' 's|mtuck063/snore-ratings-tracker|YOUR_USER/YOUR_REPO|g'
```

The repo slug matters because the dashboard's "Record now" button dispatches
workflows through the GitHub API.

Then the human-readable parts, which no search-and-replace will catch:

| File | What to change |
| --- | --- |
| `docs/index.html` | `<title>`, the `<h1>`, and the website-traffic blurb |
| `docs/keyword-log.html` | `<title>` |
| `README.md` | this file, including the three badge URLs |

### 3. Choose your markets

`scripts/keywords.json` holds one entry per market. The `storefront` value is
the `X-Apple-Store-Front` header the autocomplete endpoint wants: a numeric
storefront id, an optional language index, then `,29` for the API version.

The eleven already configured:

| | | | |
| --- | --- | --- | --- |
| us `143441-1,29` | ca `143455-1,29` | gb `143444-2,29` | au `143460,29` |
| fr `143442,29` | es `143454,29` | mx `143468,29` | de `143443,29` |
| nl `143452,29` | jp `143462,29` | cn `143465,29` | |

For anything else, take Apple's numeric storefront id and confirm it by asking
for suggestions in that market's language. Italy, checking that a local word
comes back:

```sh
curl -s -H 'X-Apple-Store-Front: 143450,29' \
  'https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=russ'
```

Suggestions in the right language mean the code is right. The two-letter
country code beside it (`it`) is what the search and RSS endpoints use, and is
the key your market entry is filed under.

Start with two or three markets. Every added market is another set of jobs on
every run, and the ranking work only pays off where you actually have listings
worth tuning.

### 4. Seed the keyword list

Three lists per market, and they do different jobs:

- **`keywords`** (or the global list plus `extraKeywords`) is what gets ranked
  and scored every run. Thirty to fifty phrases is a healthy start. Write the
  phrases a buyer would type, not the words you would use for your own feature.
- **`watchPrefixes`** are the autocomplete prefixes diffed for new suggestions
  every run, five or so, chosen so their suggestion lists are mostly your
  category. `snore`, `snoring`, `sleep t` here.
- **`seedTokens`** gates auto-discovery: a newly suggested phrase joins the
  tracked list only if it contains one of these. Keep them short and central to
  the category, since this is the only thing standing between your config and
  every phrase Apple decides to suggest.

Non-English markets can carry their own `keywords`, `watchPrefixes` and
`seedTokens`; they fall back to the global lists when absent.

### 5. Turn on Actions and Pages

In repo settings:

- **Actions → General → Workflow permissions**: read and write. The bot commits
  collected data back to the repo, and it cannot without this.
- **Pages → Build and deployment**: deploy from a branch, `main`, folder
  `/docs`.
- **Actions**, on a fork: enable them, then enable scheduled workflows.

Nothing needs a secret unless you want website traffic on the dashboard, which
takes a [GoatCounter](https://www.goatcounter.com) site, its API token as the
`GOATCOUNTER_TOKEN` repo secret, and your site name in `SITE` in
`scripts/pageviews.mjs`. Skip all three and the step logs that it is skipping
and exits clean.

### 6. Adapt the relevance filters

This is the part that is genuinely about your app rather than your ids, and
skipping it is what fills a keyword list with junk.

`scripts/kw-discover.mjs` decides whether a candidate phrase belongs to your
category by looking at what a real search for it returns:

- `NAMEY` and `NAMEY_CJK` match the word stems a competitor's app name is built
  from. `snor`, `ronfl`, `schnarch`, `いびき`. If a search returns apps whose
  names look like this, the phrase is in your category.
- `FREEDIVE` is the counterweight: terms that hijack your vocabulary in some
  languages. "Apnea" means sleep apnea in a sleep app and breath-hold training
  in a diving one, and in French and Spanish the divers win the query outright.
  Every niche has one of these collisions. Find yours before it fills the list.

`scripts/intents.json` needs the same treatment in miniature. Its `offtarget`
list encodes decisions about one niche and one app, and carrying somebody
else's over means grouping your terms by their category boundaries.

`scripts/kw-harvest.mjs` carries a `HARVEST` block per non-English market:
category stems, plus the modifiers buyers append ("kostenlos", "無料"). Seed
every register the language actually uses, not just the one your English term
translates into. Chinese has a plain word for sleep and a clinical one; German
builds compounds no word-by-word translation reaches.

### 7. First run

Dispatch **Collect ratings** and **Track keywords** by hand from the Actions
tab, in that order, and expect the first run to be quieter than the steady
state:

- Ratings seed silently. No deltas, no events, because there is no previous
  reading to compare against.
- Written reviews only get fetched for storefronts that already showed a rating
  in the previous run, so reviews start arriving on the second run.
- Keywords record rank and demand immediately, but Δ columns, movement events
  and the newly-tracked badge all need a previous run to mean anything.
- The watchdog fails until both heartbeat files exist. Run both collectors
  before it next fires, or close the issue it raises.

Give it a day. The dashboard is honest about young data, and most columns fill
themselves in on the second and third runs.

### 8. Grow the list

Once ranks are flowing, `kw-harvest.mjs` and the **Keyword discovery** workflow
are how the tracked list grows deliberately rather than only through
auto-discovery:

```sh
node scripts/kw-harvest.mjs de nl        # autocomplete -> scripts/kw-candidates.json
```

Then run the discovery workflow, which searches each candidate and reports how
many known category apps its results contain. Terms with three or more are
worth tracking. It commits nothing; results come back as an artifact.

## Which keyword to act on

Ranking every phrase is not the same as knowing which one to spend the next
metadata change on, so `scripts/aso.mjs` adds the three things the rank table
cannot answer on its own.

**Intent.** Every term is grouped by what the searcher is doing: naming a
problem (`symptom`), naming a tool (`category`), naming one capability
(`feature`), a neighbouring need (`adjacent`), somebody else's app (`brand`),
or nothing this app serves (`offtarget`). Rules run on the English form of the
term, translated through `glossary.json`, so one rule set covers every market.
Corrections go in `scripts/intents.json` and beat the rules.

**Coverage.** Apple can only rank you for a phrase whose words are somewhere in
your title, subtitle or keyword field, and it pools all three: `night` and
`recorder` in the field is what makes "night recorder" rankable. Coverage tests
that pool, and a phrase it cannot build is flagged `no words` in the table.
That is a different problem from ranking badly and has a much cheaper fix.

Japanese and Chinese are tested by segmentation rather than word membership,
since their queries have no spaces: 睡眠記録アプリ is covered when the listing
carries 睡眠, 記録 and アプリ across any of its fields.

Some words are free. Apple matches articles, prepositions, conjunctions and
pronouns without your carrying them, which was measured rather than assumed:
of the tracked phrases whose only gap was one of these, every one was already
ranking without the word, in five languages. "sleep tracker and sleep recorder"
sits at #21 in the US with `and` nowhere in the listing. The lists live in
`FUNCTION_WORDS`, one per language and never pooled, because "die" is a German
article and an English verb. Closed classes only: a word that is also a real
search term is left out, since a guess here reads as a verdict.

The same list governs what the field recommendation will buy. It did not
always, and the gap was expensive: the recommendation read a much smaller set
and went on packing `and`, `do`, `i` and `my` into fields while the coverage
column beside it reported those phrases as already covered. Eight characters
per English market, spent on nothing.

**Priority.** Demand alone puts the unwinnable at the top, so the score weights
it by how much rank is left to win (a phrase at #2 has none), how hard the apps
in the way are to pass, whether the searcher is one this app converts, and
whether the words are there at all.

**Difficulty.** How much rank is left is not the same question as what it would
cost: #40 is #40 whether the thirty-nine above are dormant hobby projects or
Calm. Each phrase is graded 0-100 against the apps it would actually have to
pass — the ones directly above you, not the head of the list — on five signals,
each dropped rather than guessed when its input is missing:

| Signal | Reads | From |
| --- | --- | --- |
| Authority | their rating counts against yours, log-scaled | `stats` |
| Relevance | how many of them rank without naming the phrase | app names |
| Tenure | how long they have been on the store | release dates |
| Stasis | how often the top ten turns over | `turn`, per keyword |
| Momentum | whether their ratings are growing faster than yours | `statsLog` |

Rating count is the load-bearing proxy, and it earns the position: across the
US phrases inside the top ten, the apps above outweigh the apps below on
ratings in ten cases out of eleven. The exception is "sleep talking tracker",
where a smaller app outranks larger ones because the phrase names what it does.
That split is the model — authority sets the wall, relevance is what gets over
it.

**Freshness.** A phrase naming a year is demand with an expiry date, and the
demand score cannot see the cliff coming: Apple's autocomplete reads what is
being searched today, so "sleep talking recorder 2025" still scores 53 in 2026.
Its weight is halved for each year elapsed, floored at 15%. Like difficulty,
this discounts rather than excludes, so the recommendation drops the year where
it can no longer pay for its characters and keeps it where the demand is heavy
enough to still be worth them.

Nothing here is a probability. Apple publishes no ranking weights, no search
volume and no competitor installs, so every input is a public stand-in. It
ranks phrases against each other, and it discounts a hard phrase by at most 60%
rather than ruling it out, because heavy demand behind a hard phrase can still
beat an easy phrase nobody searches.

Two of the five need history to say anything. Stasis needs five day-boundaries
of turnover before it reports, and momentum needs the growth series to span
twenty hours. Both start empty on a fresh install and fill themselves in.

The dashboard turns this into a field builder: start from the recommendation,
drop a word to see what it was holding up, add one to see what it buys, and
watch characters, phrases covered, total Pop and the intent mix move as you
edit.

It also names the characters that are buying nothing, in four kinds, ordered by
how sure it is:

| The word | Why it buys nothing | How sure |
| --- | --- | --- |
| already in the title or subtitle | Apple pools all three fields and indexes the word once | certain |
| is a function word | Apple matches it without your buying it | measured |
| no tracked phrase can use it | may be earning on a phrase nobody thought to track | unmeasurable here |
| names a year that has passed | the demand is real today and dated | a forecast |

Only the first two are faults. The last two are prompts, and the panel says so
rather than presenting all four as one number to fix.

That third test is run against the same unit-sets coverage uses, which is what
makes it mean anything in Japanese and Chinese. Built the obvious way, by
splitting tracked phrases on spaces, it produced an empty set for a language
whose queries have no spaces, and reported every JP and CN field word as
useless.

Coverage is recomputed in the browser, but none of the language rules are: each
phrase ships with the unit-sets that would satisfy it, so the page does set
arithmetic and cannot drift from the rules in `aso.mjs`.

```sh
node scripts/aso.mjs --fetch        # refresh live listings, rebuild aso.json
node scripts/aso.mjs --report us    # coverage, gaps and chase list for a market
node scripts/aso.mjs --csv          # the chase list, every market, as CSV
node scripts/aso.mjs --field us     # propose a 100-char keyword field
```

Title and subtitle come from the storefront pages on every run, so coverage is
graded against the live listing. The keyword field is private to App Store
Connect and cannot be read from anywhere, so it is the one value kept by hand:
paste it into `scripts/metadata.json` whenever you change it. A market whose
field is not recorded is reported as judged on title and subtitle alone rather
than silently graded as if the field were empty.

`scripts/intents.json` also carries an `offtarget` list: whole neighbourhoods
the app does not serve, scored to zero so they stay out of the chase list and
out of the field recommendation. It is what keeps white noise and insomnia
phrases from being recommended to a snoring app.

## Did the release work

A metadata change is the only thing here you can act on, so the release that
carries it is the one event worth measuring against. `scripts/release.mjs`
records what shipped and reads the result.

The ordering is the whole trick. `metadata.json` holds the current listing and
only the current listing: the moment you paste the new keyword field in, the
old one exists nowhere except the git history. So the baseline is taken first.

```sh
node scripts/release.mjs --record 4.14   # BEFORE editing metadata.json
# paste the shipped keyword fields into scripts/metadata.json, set fieldUpdated
node scripts/aso.mjs --fetch             # pull the live title, subtitle, screenshots
node scripts/release.mjs --seal          # capture the after side
node scripts/release.mjs --report us     # read it, any day after
```

Three things come out of it, and they arrive at different speeds.

**Coverage, immediately.** Which phrases the listing can rank for at all is
arithmetic: it is true the second the release goes live and no waiting makes it
truer. It is also the only check that catches a field that shipped with a typo,
came back truncated, or traded six phrases for six others while the count sat
still. `gained` and `lost` are the lines to read.

It only reads if both sides were graded the same way. A market whose keyword
field was never written down was graded on title and subtitle alone, so writing
the field down at the same moment as shipping it makes coverage leap from 10 to
56 for reasons that have nothing to do with the release. The report and the
panel both refuse that comparison rather than printing the flattering number,
and the refusal spreads: with almost every phrase reading as "changed", the
cohort split below has no control group either, so the lift is withheld too.

**Rank, over days.** Every rank in the table moves whether or not you ship
anything, so the phrases whose coverage changed are compared against the
phrases nothing touched, over the same days, and the difference between the two
is the report's `lift`. If both cohorts gained eight places, Apple moved and
you did not. Medians of daily closes, never single days, because the 24h column
already shows phrases swinging fifty places inside one day. Phrases that move
more than 30 places on their own are counted and held out, since nothing a
release does to them would be visible over that. Apple re-indexes over days,
so the report labels itself `indexing` for two days, `provisional` to a week,
and `settled` after that.

Phrases crossing from unranked to ranked are reported separately, and they are
the cleanest evidence a field change ever produces: an indexed word does not
walk a phrase up the list, it puts the phrase on the list.

**Conversion, nowhere.** Screenshots move the impression-to-download rate, and
nothing in this repo can see impressions or downloads. The screenshot half of a
release is judged in App Store Connect (Analytics, then Impressions, Product
Page Views and Conversion Rate by territory) or not at all. Ratings per day is
the only proxy here and at one or two a day it cannot separate a good release
from a quiet week for months, so it is shown with that caveat attached. If
screenshots are the point of the change, ship them as a Product Page
Optimization test instead: a build that changes screenshots and keywords at
once has confounded the two beyond any later untangling.

The dashboard reads the same file: a dashed rule at the release on every rank
and rating chart, a panel above the keyword table, and the release inline in
the movement log where the moves it caused sit under it. `--effect` reruns on
every keyword workflow and rewrites only the computed block, so the panel keeps
up on its own.

Screenshots are recorded from the lookup API on every `--fetch`, so the git
history of `metadata.json` becomes a log of when the visuals changed. Apple
serves the current set and only the current set, so a release recorded after it
went live reports its screenshot change as unknown rather than guessing.

## Apple's own popularity index, optional

Every popularity number described above is a proxy. `keywords.mjs` scores demand
by prefix-probing Apple's autocomplete: the shorter the prefix at which a term
surfaces and the higher it sits, the more people search it. That is ordinal and
uncalibrated. It answers "busier than yesterday" and never "how busy".

Apple publishes the real index, 5 to 100, inside Apple Ads. `popularity.mjs`
fetches it, for all eleven markets.

**It is not wired into any workflow, and that is deliberate.** Two measurements
decided it. The Apple Ads session cookie carries a four-hour expiry against a
six-hour cron, so a repo secret would be stale before nearly every run and no
token exists that could renew it. And Apple answers for 25 of the 602 tracked
terms, none of them the English snoring vocabulary this app lives on. A
credential in the secrets, plus an asterisk on every "nothing here needs
authentication" claim, to refresh 4% of one column, is not a trade worth making.
Read [what it actually returns](#what-it-actually-returns-measured) before
reaching for it.

What is left is a hand-run tool, useful for the handful of head terms Apple will
speak to. Two things to know:

- The endpoint is undocumented. It is the private call the Apple Ads web page
  makes, not part of the Campaign Management API, which has no popularity data
  at all. Apple can change or withdraw it without notice.
- Nothing else depends on the file. Ranks, coverage and the chase list all work
  exactly as before if you never set this up.

### Setting it up

1. Create an Apple Ads account at [searchads.apple.com](https://searchads.apple.com),
   signing in with the Apple ID that owns App Store Connect. Pick United States
   if your country is not offered.
2. Open the Advanced tier at [searchads.apple.com/advanced](https://searchads.apple.com/advanced).
   Basic does not expose this data.
3. Link App Store Connect: account name top-left, then Settings under Campaign
   Groups, then Link Accounts. You need Account Holder, App Manager, Admin or
   Marketer in App Store Connect, and the same email on both sides. Clear your
   browser cache and sign back in afterwards, which Apple's own instructions
   call for and which makes a successful link look failed if you skip it.
4. Ignore the missing-billing warning. No campaign, no card, no spend. Do not
   create a campaign; nothing here needs one and a live one costs money.
5. Capture the session cookie. With Apple Ads open and signed in, open DevTools,
   go to Network, click a request whose `:authority` is `app-ads.apple.com`,
   find `Cookie` under Request Headers, and copy the whole value. It must come
   from that host: an App Store Connect cookie looks similar and is rejected.
6. Keep it out of the repo and out of your shell history:

```sh
pbpaste > ~/.asa-cookie && chmod 600 ~/.asa-cookie
ASA_COOKIE="$(cat ~/.asa-cookie)" node scripts/popularity.mjs --check
```

Skip Apple's Campaign Management API documentation entirely. It will route you
through API roles and OAuth credentials that this endpoint does not use.

### How long the cookie lasts

About four hours, which is the single fact that kept this out of the workflow.

The `Cookie` header itself carries no expiry: the lifetime was in the
`Set-Cookie` that created it and is gone by the time it reaches your clipboard.
But the `itctx` value inside it is base64 JSON with an explicit `ex` field, and
on the session measured here it read `2026-8-5 6:0:14` against an issue time of
01:58 UTC. Four hours and two minutes.

The collector measures it independently as a check. Each cookie is identified by
a short digest of its value, never the value itself, and `popularity.json`
records when that session first worked and last worked; paste a new one and the
old one's lifetime lands in `sessionHistory`.

```sh
ASA_COOKIE="$(cat ~/.asa-cookie)" node scripts/popularity.mjs --check
```

reports how long the current session has been alive and what previous ones
managed. In practice you capture a fresh cookie each time you want a reading,
which for a hand-run tool is no burden at all.

### What it actually returns, measured

All eleven markets work. Storefronts are honoured and want two-letter country
codes, not the numeric ids the rest of this repo passes around: `143441` is
rejected as "Invalid storefront name". `sleep tracker` measured 62 in the US,
54 in GB, 53 in AU, 49 in CA and 41 in DE, so these are genuinely per-market
figures rather than eleven copies of one number.

The catch is coverage of this app's vocabulary, and it is severe. Apple returns
its floor of 5 for nearly every English snoring phrase while answering normally
for neighbouring terms in the same request:

| | |
| --- | --- |
| `sleep tracker` 62, `sleep cycle` 56, `snore lab` 50, `sleep recorder` 46 | measured |
| `snore`, `snoring`, `snore recorder`, `snoring app`, `sleep apnea`, `cpap`, `sleep sounds`, `sleep monitor` | all 5 |

First full run: 25 of 602 tracked terms above the floor. US 4/82, GB 4/75,
AU 4/70, CA 4/67, JP 5/58, CN 2/54, DE 1/39, FR 1/45, and nothing at all in ES,
MX or NL.

No cause established, and the obvious explanations are all ruled out. It is not
the account, which returns 100 for `instagram` and 96 for `facebook`. It is not
the App Store Connect link, since an `adamId` you do not own is rejected outright
with `NO_USER_OWNED_APPS_FOUND_CODE`. It is not casing, pluralisation, batching,
match type or storefront: `snore`, `Snore`, `snores`, `snoring` and `snorer` all
return 5 alone or together, in US and CA. It is not the subject matter either,
because the Japanese snoring terms work fine, `いびき` scoring 60. Whatever the
rule is, English snoring vocabulary sits below it.

So treat this as competitive context for a handful of head terms, not as demand
data for the keyword list. The prefix-probe score in `keywords.mjs` remains the
only signal that covers all 602 terms.

Floor values are counted, never stored. A 5 that means "we cannot tell you" must
not enter the file as though it meant "nobody searches this", because from there
it flows into charts and averages that read as findings. Each market records
`asked` and `measured` so the gap stays visible.

The collector also re-checks every run that storefronts are still being honoured,
rather than trusting one probe. Three control phrases ride along in each market's
existing call, and any market whose control values match the reference market to
the digit is labelled `mirrors` instead of being passed off as its own data. The
controls are `sleep tracker`, `sleep cycle` and `alarm clock` deliberately:
snoring terms would compare equal everywhere by sitting on the floor together,
and every market would look like a mirror of every other.

```sh
ASA_COOKIE='...' node scripts/popularity.mjs --probe
```

re-runs that comparison on demand.

A market Apple refuses carries its previous values forward rather than blanking
them, the same rule the rank collectors follow, and the run reports
`POP_SESSION=partial` rather than calling the cookie dead. A run where the US
answered and Mexico did not is a storefront limitation, not an expired session.

### Once it is collecting

```sh
node scripts/popularity.mjs --report
```

compares Apple's index against ours by Spearman correlation, per market, and
lists the terms the two disagree about most. Both are ordinal, so agreement on
ordering is the only claim worth testing.

This was the main reason for setting the whole thing up, and it does not
currently work: with four measured terms per market the correlation swings from
-0.21 to 0.90 across storefronts, which is sampling noise rather than a finding.
Calibrating `popScore` against Apple needs Apple to answer for more than 4% of
the list. Worth re-running if coverage ever improves.

A full pass over all eleven markets takes about thirteen seconds and eleven
calls. The script still gates itself to one fetch per market per day, so
re-running it in the same session costs nothing; use `--force` when you want to
override that.

## Working on it locally

```sh
node scripts/collect.mjs                 # ratings, reviews, histograms
node scripts/keywords.mjs                # every market in-process
node scripts/keywords.mjs --collect us   # one market, writes partials/
node scripts/keywords.mjs --merge        # partials -> data files
node scripts/aso.mjs --report us         # which keywords are worth chasing
node scripts/release.mjs --report        # what the last release did
node scripts/check-freshness.mjs         # what the watchdog runs

ASA_COOKIE='...' node scripts/popularity.mjs --check    # is the session alive
ASA_COOKIE='...' node scripts/popularity.mjs --probe    # do non-US storefronts answer
ASA_COOKIE='...' node scripts/popularity.mjs --force    # fetch now, skip the daily gate
node scripts/popularity.mjs --report                    # Apple's index vs ours

python3 -m http.server -d docs 8000      # the dashboard at localhost:8000
```

Node 22, no dependencies, no install step. Local runs write to `docs/data` the
same way CI does, so check `git diff` before committing anything a script
touched.

Both HTML files cache-bust with a query string (`app.js?v=98`). Bump it when you
change the JS or CSS, or your own browser will keep serving you the old file.

## Data files

Everything under `docs/data` is served to the browser, so size is a real
constraint there. Working state that no page reads lives in `scripts/` instead.

| File | Holds |
| --- | --- |
| `latest.json` | current count and average per storefront |
| `history.json` | one row per day per storefront |
| `events.json` | every rating change the hourly check caught |
| `histograms.json` | per-star breakdown per storefront |
| `pending.json` | unconfirmed rating decreases, held 48h before they stick |
| `reviews.json` | written reviews, kept indefinitely; one absent from Apple's feed for a full day of checks is flagged `removed` (never deleted) and hidden from the page |
| `keywords.json` | current rank and demand per keyword, the apps holding the places above you, top-ten turnover, plus 30-day history |
| `kw-events/` | rank and autocomplete movements, one shard per month |
| `aso.json` | intent, coverage and priority per keyword, plus each market's chase list and the characters its field is wasting |
| `releases.json` | one entry per release: the listing before and after, per market, and the before-and-after read on rank |
| `popularity.json` | Apple's own 5-100 demand index per keyword, when the optional Apple Ads collector is set up, plus how long each session cookie survived |
| `glossary.json` | localized keyword to English, for the dashboard |
| `status-*.json` | collector heartbeats |
| `scripts/keywords.json` | the config, which auto-discovery also writes to |
| `scripts/hints.json` | last autocomplete state, diffed for new suggestions |
| `scripts/kw-candidates.json` | harvested phrases awaiting a relevance test |
| `scripts/metadata.json` | what the listing claims; title, subtitle and screenshots fetched, keyword field by hand |
| `scripts/intents.json` | intent corrections and off-target neighbourhoods |

## Limits worth knowing

Apple throttles the search API per IP, and GitHub runner IPs are a lottery:
some are already exhausted when your job starts. The keyword workflow works
around it by generating its job matrix from the config and splitting any market
past 50 keywords across runners, so no single IP makes more calls than that. A
run that still comes back with more than 20 failures requeues itself once for
fresh runners, then fails loudly rather than quietly serving carried-forward
ranks as current.

Scheduled workflows are best-effort. The hourly ratings cron actually fires
about 13 of its 24 slots, and observed gaps reach four hours, which is why the
freshness thresholds sit at 12 and 16 hours rather than close to the cadence.

Actions minutes are free on a public repo, which is what this cadence assumes.
A private one would spend a couple of hours of quota a day, almost all of it
the keyword matrix: eleven markets currently split into 19 jobs per run, four
runs a day, and GitHub bills every job a minimum of one minute however fast it
finishes. Fewer markets or two runs a day brings that back inside the free
allowance.
