# Keyword Playbook

How to research a market before writing keywords, and how to build and qualify
the list once you do. Written against what this tracker actually measures, with
worked examples from live Snore Timeline data (US, Aug 2026).

---

## Part 1: What to know before building anything

### 1. How the App Store actually indexes you

Four fields rank on iOS. Nothing else does.

| Field | Limit | Weight |
|---|---|---|
| App name | 30 chars | Highest |
| Subtitle | 30 chars | High |
| Keyword field | 100 chars | Moderate |
| In-app purchase names | 30 each | Low, often ignored |

The description does **not** rank on iOS. This is the single most common mistake
carried over from Google Play, where it does. Writing keyword-stuffed iOS
descriptions is wasted effort; write those for conversion instead.

**Apple recombines words across all four fields into phrases.** If "snore" is in
your name and "tracker" is in your keyword field, you are indexed for "snore
tracker" without spending characters on the phrase. Three rules follow:

- Never repeat a word that already appears in your name or subtitle. Every
  repeat is a wasted character.
- Never use multi-word phrases in the keyword field when the individual words
  can combine. Store `snore,tracker,recorder`, not `snore tracker,snore recorder`.
- No spaces after commas. Each space costs a character and buys nothing.

Also skip: your developer name, category names, "app", "free" (Apple handles
price separately), stop words, and plurals of words you already hold. Apple's
stemming covers most singular/plural pairs, imperfectly but well enough that
duplicating them is a poor use of 100 characters.

### 2. Localization is a character multiplier, not a translation task

Each storefront indexes **more than one locale**. In the US, Apple indexes both
`en-US` and `es-MX`. Fill both keyword fields and you have 200 characters of
index in a single storefront, not 100. The `es-MX` field does not have to be
Spanish; it is simply a second indexed field for that storefront.

The same trick applies elsewhere: `en-GB` covers the UK, Australia, and much of
the English-speaking world; Canada indexes `en-CA` and `fr-CA`.

Before writing a market's keywords, answer:

- Which locales does this storefront index, and are we filling all of them?
- Do people here search in English, or in the local language, or both? (In
  Germany and the Nordics, English search terms are common. In France, Japan,
  and China, far less so.)
- Does the terminology differ? "Snoring" versus "snore" versus regional slang
  changes what you should target.

### 3. Understand your demand signal and its floor

This tracker reports **Pop** (5 to 100), Apple's search-popularity proxy derived
from how early and how high a phrase surfaces in autocomplete.

Two things about Pop that change decisions:

- **5 is the noise floor, not "a little demand."** It means demand is not
  measurable. In the US set, 18 of 81 tracked keywords sit at Pop 5. Ranking
  #1 on those is worth approximately nothing.
- **The scale is roughly logarithmic.** The gap between Pop 80 and Pop 90 is far
  larger than between 40 and 50. Chase the top of the scale.

Pop is per-storefront. A term with Pop 88 in the US may be Pop 40 in Canada.
Never carry a keyword list between markets without re-checking demand.

### 4. Understand who you are fighting

For every target term, ask who holds the top 10 and whether you can displace
them. This tracker computes it: in the US, Sleep Cycle holds a top-10 slot on
**75 of 81** tracked keywords and ShutEye on **73 of 81**, with 27k and 349k
ratings respectively.

That tells you two useful things:

- The category is dominated by broad sleep apps, not snore-specific ones. Broad
  head terms like "sleep tracker" are defended by apps with 100x your rating
  count.
- Ratings volume is the moat. With 349 ratings worldwide, you win on specificity
  and relevance, not authority.

Ask: are the incumbents on this term actually relevant to it, or are they
generic giants ranking on brand strength? The second case is where a specific
app can win.

### 5. Understand your product truth

Ranking for a term you do not satisfy is actively harmful. Apple feeds
tap-through and conversion back into rankings, so a term that brings users who
bounce will decay, and can drag neighbouring terms with it.

Two sources of ground truth:

- **What the product does.** Snore Timeline records and analyses snoring, tracks
  sleep, and is free with no ads.
- **What users call it.** Mine your own reviews for vocabulary. Current reviews
  use "analysing snoring patterns", "record my sleeping quality", "no ads".
  Those are keyword candidates in your users' own words, and they convert
  because they describe what the app genuinely is.

### 6. Establish a baseline you can measure against

Before changing anything, record:

- Current rank and best-ever rank for every tracked term
- Which terms moved in the last 30 days, and what shipped at the same time
- Current rating count and velocity per storefront

Then change **one thing at a time** and allow **7 to 14 days** for ranks to
settle. Shipping a new title, subtitle, and keyword field together tells you
nothing about which one worked.

### Pre-flight checklist

- [ ] Which storefronts matter, and by what measure (downloads, revenue, ratings)?
- [ ] Which locales does each storefront index, and are all of them filled?
- [ ] Do users here search in English, the local language, or both?
- [ ] What is our current rank and best-ever rank for each candidate?
- [ ] Who owns the top 10, and how many ratings do they have?
- [ ] Does the product genuinely satisfy each term we are targeting?
- [ ] What vocabulary do our reviews use?
- [ ] What is our baseline, and what single change are we testing?

---

## Part 2: Building and qualifying the list

### Phase 1: Harvest wide

Collect candidates from every source before filtering any of them. Aim for
5 to 10 times more candidates than you will ship.

| Source | What it gives you |
|---|---|
| Product features | The terms you obviously satisfy |
| Competitor metadata | Their titles and subtitles are their highest-conviction bets |
| Autocomplete expansion | Real phrases users type, with demand attached (this repo's `kw-discover.mjs`) |
| Review mining | Your users' actual vocabulary |
| Category browse | Terms that define the neighbourhood you compete in |
| Long-tail combination | Modifier stacking: free, app, recorder, monitor, tracker, detector |

### Phase 2: Qualify against four gates

Every candidate passes all four gates or is rejected. Order matters, and
relevance comes first because it is the only gate that can hurt you.

**Gate 1: Relevance (binary, ruthless).** Would someone searching this be
satisfied by our app within one session? If no, reject regardless of demand.
"cpap tracker" has Pop 87 in the US, which is tempting, but if the app does not
track CPAP therapy, that traffic bounces and the ranking decays.

**Gate 2: Demand.** Pop >= 40 for head terms. Below that, only accept long-tail
phrases where intent is unusually high and specific.

**Gate 3: Winnability.** Compare current rank against who holds the top 10:

- Ranked 1 to 10 already: you hold it
- Ranked 11 to 60: reachable with metadata work alone
- Ranked 61 to 200: needs metadata plus rating velocity
- Unranked: only worth targeting if relevance is perfect and the term is specific

**Gate 4: Intent value.** Transactional beats informational. "snore recorder app"
signals someone about to download. "why do i snore" signals someone reading an
article. Prefer the first.

### Phase 3: Segment into actions

Sort every survivor into one of five buckets. Live US data:

**DEFEND — high demand, already top 10.** You already own these. Do not spend
keyword-field characters on words that are earning this rank via your title.

```
snore tracker free  r5  p83      free snoring app     r4  p71
snore recorder app  r5  p82      sleep talking tracker r5 p70
snore timeline      r1  p72      sleep monitor free   r7  p69
```

**PUSH — high demand, rank 11 to 60. This is where the ROI is.** Close enough to
move with metadata alone, valuable enough to matter.

```
snore lab            r16 p88     sleep talking recorder r29 p81
snoring tracker      r17 p84     snoring recorder       r26 p72
sleep quality tracker r17 p83    snore monitor          r31 p70
```

**ASPIRATIONAL — high demand, rank 60+ or unranked.** Target only where
relevance is perfect. Everything here needs rating velocity, not just words.

```
rem sleep tracker r87 p88    sleep tracker  r61 p80
sleep cycle       r-  p84    auto sleep tracker r123 p74
cpap tracker      r192 p87   (relevance gate: does the app do CPAP? If not, reject)
```

**VANITY — rank 1 to 10, Pop 5.** Three US keywords sit here. Ranking well on
unmeasurable demand. Harmless but worthless; never spend characters defending them.

**REJECT — failed the relevance gate at any demand level.**

### Phase 4: Allocate the character budget

Spend from the highest-weight field down, and never repeat a word.

1. **App name (30):** one or two highest-value terms you can genuinely win, plus
   the brand.
2. **Subtitle (30):** the next tier, phrased as a benefit so it also converts.
   This field is read by humans as well as the index.
3. **Keyword field (100):** everything else, as single words, deduplicated
   against name and subtitle, no spaces after commas.
4. **Second locale (100 more):** the same exercise for the storefront's other
   indexed locale.

Weight the mix roughly 70% PUSH and 30% ASPIRATIONAL. DEFEND terms mostly do not
need field space because your name and subtitle are already earning them.

### Phase 5: Measure and iterate

- Wait 7 to 14 days before drawing conclusions
- Compare rank deltas on the terms you added against the ones you removed
- Watch for cannibalization: gaining on one term while a neighbouring term drops
  usually means you moved relevance rather than added it
- Re-run the harvest quarterly; Pop scores drift and new competitors enter
- Record what you changed and when, so the next person can attribute movement

---

## Quick reference: the decision matrix

| Rank \ Demand | Pop 5-39 | Pop 40-69 | Pop 70+ |
|---|---|---|---|
| **1-10** | Vanity, ignore | Defend via title | Defend, protect at all costs |
| **11-60** | Low priority | Push | **Push first, best ROI** |
| **61-200** | Reject | Aspirational if relevant | Aspirational, needs ratings |
| **Unranked** | Reject | Reject | Only if relevance is perfect |

Relevance failure overrides every cell in this table.
