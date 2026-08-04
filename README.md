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
| Freshness check | `scripts/check-freshness.mjs` | 4x daily | opens an issue |

Two more scripts are manual, for growing the keyword list rather than tracking
it: `kw-harvest.mjs` pulls candidate phrases out of Apple's autocomplete, and
`kw-discover.mjs` relevance-tests them with real searches.

Every source is public and unauthenticated: the iTunes lookup and search APIs,
the storefront web page, the search-hints autocomplete endpoint, and the
customer-reviews RSS feed. The only credential anywhere is an optional
GoatCounter token.

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
list and `vetoWords` encode decisions about one niche and one app, and carrying
somebody else's over means grouping your terms by their category boundaries.

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

**Priority.** Demand alone puts the unwinnable at the top, so the score weights
it by how much rank is left to win (a phrase at #2 has none), whether the
searcher is one this app converts, and whether the words are there at all.

The dashboard turns this into a field builder: start from the recommendation,
drop a word to see what it was holding up, add one to see what it buys, and
watch characters, phrases covered, total Pop and the intent mix move as you
edit. Coverage is recomputed in the browser, but none of the language rules
are — each phrase ships with the unit-sets that would satisfy it, so the page
does set arithmetic and cannot drift from the rules in `aso.mjs`.

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

Two lists in `scripts/intents.json` keep it from re-proposing decisions you
have already made: `offtarget` for whole neighbourhoods the app does not serve,
and `vetoWords` for words the field will never carry whatever the demand behind
them.

## Working on it locally

```sh
node scripts/collect.mjs                 # ratings, reviews, histograms
node scripts/keywords.mjs                # every market in-process
node scripts/keywords.mjs --collect us   # one market, writes partials/
node scripts/keywords.mjs --merge        # partials -> data files
node scripts/aso.mjs --report us         # which keywords are worth chasing
node scripts/check-freshness.mjs         # what the watchdog runs

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
| `reviews.json` | written reviews, kept indefinitely |
| `keywords.json` | current rank and demand per keyword, plus 30-day history |
| `kw-events/` | rank and autocomplete movements, one shard per month |
| `aso.json` | intent, coverage and priority per keyword, plus each market's chase list |
| `glossary.json` | localized keyword to English, for the dashboard |
| `status-*.json` | collector heartbeats |
| `scripts/keywords.json` | the config, which auto-discovery also writes to |
| `scripts/hints.json` | last autocomplete state, diffed for new suggestions |
| `scripts/kw-candidates.json` | harvested phrases awaiting a relevance test |
| `scripts/metadata.json` | what the listing claims; title and subtitle fetched, keyword field by hand |
| `scripts/intents.json` | intent corrections, off-target neighbourhoods, vetoed words |

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
