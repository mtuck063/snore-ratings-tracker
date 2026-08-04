#!/usr/bin/env node
// Keyword prioritisation: turns the rank table into a short list worth acting on.
//
// The rank collector answers "where do I place for this phrase". It cannot
// answer "which phrase should I spend the next metadata change on", because
// that needs three things it doesn't track:
//
//  - INTENT. "do i snore" and "snore recorder app" are different searchers.
//    One has a problem, the other already knows the tool exists and is picking
//    between them. Terms are grouped so a market can be read as a funnel
//    instead of a flat list.
//  - COVERAGE. Apple can only rank you for a phrase whose words appear in your
//    title, subtitle or keyword field. A high-demand phrase you have no words
//    for is not a ranking problem, it's a metadata problem, and the fix is a
//    one-word edit rather than anything to do with the algorithm.
//  - PRIORITY. Demand alone ranks the unwinnable at the top. A phrase already
//    sitting at #2 has nothing left to gain; one at #30 with real demand does.
//
// Title and subtitle are read from the live storefront pages (--fetch), so
// coverage is always graded against what the listing actually says. The
// keyword field is not public anywhere, so it is the one hand-maintained
// value in scripts/metadata.json.
//
//   node aso.mjs                write docs/data/aso.json
//   node aso.mjs --fetch        refresh live title/subtitle, then write
//   node aso.mjs --report [cc]  human summary: coverage, gaps, chase list
//   node aso.mjs --csv [cc]     chase list as CSV on stdout
//   node aso.mjs --field <cc>   propose a 100-char keyword field
//
// Reads only files other scripts already write, and (with --fetch) one page
// per market. Never exits non-zero: a bad fetch keeps the stored value, the
// same carry-forward rule the collectors use.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(repoRoot, "scripts", "keywords.json");
const metadataFile = path.join(repoRoot, "scripts", "metadata.json");
const intentsFile = path.join(repoRoot, "scripts", "intents.json");
const kwDataFile = path.join(repoRoot, "docs", "data", "keywords.json");
const glossaryFile = path.join(repoRoot, "docs", "data", "glossary.json");
const outFile = path.join(repoRoot, "docs", "data", "aso.json");

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

const config = JSON.parse(await readFile(configFile, "utf8"));
const metadata = await readJson(metadataFile, { markets: {} });
const overrides = await readJson(intentsFile, { intents: {}, offtarget: [] });
const kwData = await readJson(kwDataFile, { latest: {}, history: [] });
const glossary = await readJson(glossaryFile, {});

const { markets } = config;
const kwFor = (cc) =>
  markets[cc].keywords ?? [...new Set([...config.keywords, ...(markets[cc].extraKeywords ?? [])])];

// --- text handling -----------------------------------------------------------

// Accent folding, so "apnée" and "apnee" are one word. Only Latin diacritics
// are stripped: dakuten is a combining mark too, and folding it away turns
// アプリ into アフリ and いびき into いひき, which is a different word rather
// than the same one spelled loosely.
const fold = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC");
const hasCJK = (s) => /[぀-ヿ一-鿿]/.test(s);
// Two tokenizers on purpose. Matching has to fold, or "apnée" never finds
// "apnee" in the field. Advice has to not: telling someone to add
// "schlafgerausche" to their German listing is telling them to misspell it.
const tokens = (s) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Apple matches word forms, not exact strings, so comparing raw tokens said
// the listing had no word for "snoring" while carrying "snore", and none for
// "my sleep talks" while carrying "talk". Both were ranking at the time.
//
// Deliberately shallow: plurals, -ing, -ed, -er, and a trailing "e" so snore
// and snoring meet at "snor". Anything more aggressive starts merging words
// that are genuinely different, and a false match is worse here than a missed
// one — it would claim coverage the listing does not have.
const stem = (w) => {
  let s = fold(w);
  if (s.length <= 3) return s;
  if (/ies$/.test(s)) s = s.slice(0, -3) + "y";
  else if (/(ches|shes|sses|xes|zes)$/.test(s)) s = s.slice(0, -2);
  else if (/s$/.test(s) && !/ss$/.test(s)) s = s.slice(0, -1);
  if (/ing$/.test(s) && s.length > 5) s = s.slice(0, -3);
  else if (/ed$/.test(s) && s.length > 4) s = s.slice(0, -2);
  else if (/er$/.test(s) && s.length > 4) s = s.slice(0, -2);
  if (/e$/.test(s) && s.length > 4) s = s.slice(0, -1);
  return s;
};
const words = (s) => tokens(s).map(stem);

// Words Apple does not make you buy. Every one of the thirty phrases whose
// only missing word was "app" was ranking, median #13, best #2 — the store
// sells apps, and the word carries no information. Configurable because that
// is an English-language fact, not a universal one.
const implicit = new Set((overrides.implicitWords ?? ["app", "apps"]).map(stem));

// Apple pools the words of the title, subtitle and keyword field and builds
// phrases by combining them: "night" in the field plus "recorder" in the field
// is what makes "night recorder" rankable. Coverage therefore tests the pool,
// not any single field, and never looks for the phrase itself.
function poolOf(meta) {
  if (!meta || !(meta.title || meta.subtitle || meta.keywordField)) return null;
  const raw = [meta.title, meta.subtitle, meta.keywordField].filter(Boolean).join(",");
  return {
    raw,
    set: new Set(words(raw)),
    // Whole comma-separated entries, kept unsplit for the CJK tiling below.
    segments: raw
      .split(/[,、，。\s·・|｜:：]+/)
      .map((s) => fold(s.trim()))
      .filter(Boolean),
    // Whether the keyword field is recorded. Without it a market can still be
    // graded against title and subtitle, but the answer is a floor rather than
    // a verdict, and every consumer has to say so.
    complete: Boolean(meta.keywordField),
  };
}

// Japanese and Chinese queries carry no spaces, so word membership cannot test
// them: 睡眠記録アプリ is one string that Apple segments into 睡眠 + 記録 +
// アプリ and matches against a listing segmented the same way. Coverage is
// therefore a segmentation question, and the pieces available to it are any
// run of two or more characters appearing inside a single pooled entry, plus
// whole entries of any length.
//
// Two characters is the floor because a one-character piece makes everything
// match: 寝 and 言 both occur somewhere in almost any sleep listing, and
// allowing them would report 寝言 as covered by a listing that never says it.
//
// Returns the runs it could NOT place, which is the useful half: for 睡眠アプリ
// against a title reading 睡眠トラッカー it answers アプリ, the one word to add,
// rather than the whole phrase.
function cjkGaps(part, pool) {
  const gaps = [];
  const available = (piece) => pool.segments.some((seg) => seg.includes(piece));
  let i = 0;
  let run = "";
  while (i < part.length) {
    let take = 0;
    for (let len = Math.min(part.length - i, 8); len >= 2; len--) {
      if (available(part.slice(i, i + len))) {
        take = len;
        break;
      }
    }
    // A single character counts only when the listing spends an entry on it.
    if (!take && pool.segments.includes(part[i])) take = 1;
    if (take) {
      if (run) {
        gaps.push(run);
        run = "";
      }
      i += take;
    } else {
      run += part[i];
      i++;
    }
  }
  if (run) gaps.push(run);
  // A one-character gap is technically true and useless as advice: 呼吸 sits in
  // the subtitle, so 無呼吸 reports as missing 無, and nobody buys 無 on its own.
  // Widen it back to the phrase it came from, which is the thing to add.
  return gaps.some((g) => g.length < 2) ? [part] : gaps;
}

// Returns what the listing is missing before this phrase can rank at all.
// `null` means the market has no metadata recorded, which must not read as
// "covered nothing" — an empty shopping list and an unknown one are different.
function coverageOf(term, pool) {
  if (!pool) return null;
  const partial = !pool.complete;
  if (hasCJK(term)) {
    const missing = fold(term)
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((part) => (pool.set.has(part) ? [] : cjkGaps(part, pool)));
    return { mode: "segment", covered: missing.length === 0, missing, partial };
  }
  // Compared on stems, since that is what the pool holds, and skipping the
  // words Apple never makes you buy.
  const missing = tokens(term).filter((w) => !implicit.has(stem(w)) && !pool.set.has(stem(w)));
  return { mode: "word", covered: missing.length === 0, missing, partial };
}

// --- intent ------------------------------------------------------------------

// Rules run on the English form of a term: docs/data/glossary.json already
// translates 95% of the localized lists, so one rule set covers every market
// rather than eleven parallel sets drifting apart.
//
// Order is precedence, most specific first. The two that must stay on top are
// the exclusions: "heart rate monitor" contains a tool word and would read as
// category, and a competitor's name contains category words by construction.
const RULES = [
  ["brand", /\b(snore ?lab|snorescout|snore ?scout|sleep ?cycle|shuteye|shut eye|pillow|autosleep|sleepwatch|dream talk recorder|mad snoring|snorereel|sleep ?rate|snore ?gym|snore ?clock|snorelogic|sleep ?as ?android)\b/],
  ["offtarget", /\b(white noise|pink noise|heart rate|insomnia|meditat|hypnos|lullab|nap sound|sleep aid|sleep sound|sleep better|better sleep|sleep well|fall asleep|sleep music|sleep stor|cpap suppl|cpap\.com|freediv|apnea trainer|cookies)\b/],
  ["adjacent", /\b(teeth grinding|grinding|bruxis|dream|nightmare|baby monitor|snore aid|anti snor)\b/],
  ["feature", /\b(alarm|clock|score|diary|log|journal|stage|cycle|phase|rem|quality|analysis|analytics|report|graph|chart|statistic|deep sleep|debt|smart wake)\b/],
  ["category", /\b(app|apps|tracker|tracking|track|recorder|recording|record|monitor|monitoring|detector|detection|detect|checker|check|meter|analyser|analyzer|scanner|software)\b/],
];

const MODS = [
  ["free", /\b(free|gratis|gratuit|gratuito|kostenlos|무료)\b|無料|免费/],
  ["device", /\b(apple ?watch|iphone|ipad|airpods|watch)\b|苹果手表|アップルウォッチ/],
  ["year", /\b20\d\d\b/],
];

const myTitle = fold(metadata.markets?.us?.title ?? "").split(":")[0].trim();

function classify(term) {
  const english = fold(glossary[term] ?? term);
  const native = fold(term);
  if (overrides.intents?.[term]) return { intent: overrides.intents[term], english };
  // Own brand. Ranking first for your own name is expected, not an opportunity,
  // and leaving it in the chase list wastes a slot on a term already won.
  if (myTitle && (english.includes(myTitle) || native.includes(myTitle))) {
    return { intent: "mine", english };
  }
  if (overrides.offtarget?.some((t) => english.includes(fold(t)))) {
    return { intent: "offtarget", english };
  }
  for (const [intent, re] of RULES) if (re.test(english)) return { intent, english };
  // Nothing named a tool or a capability, so the searcher named the problem.
  return { intent: "symptom", english };
}

const modsOf = (english) => MODS.filter(([, re]) => re.test(english)).map(([m]) => m);

// --- priority ----------------------------------------------------------------

// What a place gained here is worth. Demand is only half the story: the top of
// the list is where the least room is left, and a phrase nothing has ever
// ranked for is upside without evidence.
function winnability(rank) {
  if (rank == null) return 0.45; // outside the top 200: real upside, unproven
  if (rank <= 3) return 0.1; // already won; this is a defend, not a chase
  if (rank <= 10) return 0.7; // page one, worth finishing
  if (rank <= 50) return 1.0; // close enough that a metadata change shows up
  if (rank <= 100) return 0.8;
  return 0.6;
}

// A searcher who names the problem is the one still choosing a category, and
// converts best against a listing that names it back. Brand terms belong to
// somebody else's marketing, and off-target ones are not ours to win.
const FIT = {
  symptom: 1,
  category: 1,
  feature: 0.85,
  adjacent: 0.5,
  brand: 0.25,
  offtarget: 0,
  mine: 0,
};

// Coverage as a multiplier rather than a filter. An uncovered phrase needing
// one word is the cheapest thing on the board; one needing four is a rewrite,
// and should not outrank a covered phrase that only needs the ranking to move.
function lever(cov) {
  if (!cov) return 1; // no metadata recorded for this market
  // The keyword field is unknown, so a word absent from title and subtitle may
  // well be sitting in the field already. Neither reward nor punish a guess.
  if (cov.partial) return 1;
  if (cov.covered) return 1;
  return cov.missing.length <= 2 ? 1.25 : 0.85;
}

// Split into the part the browser cannot change and the part it can. The page
// lets you paste your real keyword field, which changes coverage and therefore
// the score; shipping the whole formula there instead would leave two copies
// to drift apart.
const baseOf = ({ pop, rank, intent }) => (pop / 100) * winnability(rank) * FIT[intent];

function scoreOf({ pop, rank, intent, cov }) {
  return Math.round(100 * baseOf({ pop, rank, intent }) * lever(cov));
}

// The coverage multipliers by name, so the page applies these same numbers.
const LEVERS = { covered: 1, unknown: 1, cheap: 1.25, dear: 0.85 };

function reasonFor({ pop, rank, cov, intent }) {
  const where = rank == null ? "unranked" : `#${rank}`;
  if (cov && !cov.covered) {
    const list = cov.missing.map((m) => `"${m}"`).join(", ");
    const where2 = cov.partial ? "title and subtitle have no" : "listing has no";
    return `${pop} pop, ${where}, ${where2} ${list}`;
  }
  if (rank == null) return `${pop} pop, ${where}, words are all in the listing`;
  if (rank <= 10) return `${pop} pop, ${where}, page one already`;
  return `${pop} pop, ${where}, covered — this is a ranking gap, not a wording one`;
}

// --- assembly ----------------------------------------------------------------

const CHASE_MAX = 12;

// Intents a keyword-field change can actually buy. Brand and off-target demand
// is real demand, and neither is purchasable with a word in your own listing.
const CHASEABLE = new Set(["symptom", "category", "feature", "adjacent"]);

// Not worthless: "do i snore" is a real query and the CA field pays for both
// words deliberately. Flagged rather than dropped, so a one-character word
// buying one phrase never outranks a real noun buying eleven.
const STOPWORD = /^(a|an|the|do|i|my|me|is|it|to|of|for|in|on|and|or)$/;

function analyseMarket(cc) {
  const list = kwFor(cc);
  const latest = kwData.latest?.[cc] ?? {};
  const meta = metadata.markets?.[cc] ?? null;
  const pool = poolOf(meta);

  const terms = {};
  for (const kw of list) {
    const cur = latest[kw] ?? {};
    const pop = cur.pop ?? 5;
    const rank = cur.rank ?? null;
    const { intent, english } = classify(kw);
    const cov = coverageOf(kw, pool);
    const mods = modsOf(english);
    terms[kw] = {
      intent,
      ...(mods.length && { mods }),
      pop,
      rank,
      ...(cov && { covered: cov.covered, ...(cov.missing.length && { missing: cov.missing }) }),
      score: scoreOf({ pop, rank, intent, cov }),
      base: Math.round(baseOf({ pop, rank, intent }) * 1000) / 1000,
      why: reasonFor({ pop, rank, cov, intent }),
    };
  }

  // What one added word would unlock, ranked by the demand it is holding back.
  // This is the shopping list: every entry is a word to put in the field, and
  // the number beside it is what it buys.
  //
  // Brand terms are excluded rather than discounted. A competitor's name is
  // demand you cannot buy with a keyword: the field would carry their word,
  // the ranking would still be theirs, and the first version of this happily
  // recommended "lab" off the back of "snore lab".
  const blocked = {};
  for (const [kw, t] of Object.entries(terms)) {
    if (!t.missing || !CHASEABLE.has(t.intent)) continue;
    for (const w of t.missing) {
      (blocked[w] ??= { word: w, terms: [], demand: 0, ...(STOPWORD.test(w) && { weak: true }) });
      blocked[w].terms.push(kw);
      blocked[w].demand += t.pop;
    }
  }
  const shoppingList = Object.values(blocked).sort((a, b) => b.demand - a.demand);

  // Words the listing is spending characters on that no tracked term needs.
  // Not automatically waste: it may be covering a phrase nobody thought to
  // track. Worth a look every time the field gets rewritten.
  const needed = new Set();
  for (const [kw, t] of Object.entries(terms)) {
    if (!CHASEABLE.has(t.intent)) continue;
    for (const w of hasCJK(kw) ? [] : words(kw)) needed.add(w);
  }
  const fieldWords = meta?.keywordField ? tokens(meta.keywordField) : [];
  const unused = fieldWords.filter((w) => !needed.has(stem(w)) && !implicit.has(stem(w)));

  // Subtitle words repeated in the field: Apple pools them, so the second copy
  // buys nothing and the characters could hold another word.
  const subtitleWords = new Set(words(meta?.subtitle ?? ""));
  const repeated = fieldWords.filter((w) => subtitleWords.has(stem(w)));

  // One alternatives model, shared by the recommendation and the builder.
  const model = altsFor(terms, meta);

  const chase = Object.entries(terms)
    .filter(([, t]) => t.score > 0)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, CHASE_MAX)
    .map(([kw, t]) => ({ kw, score: t.score, pop: t.pop, rank: t.rank, intent: t.intent, why: t.why }));

  const byIntent = {};
  for (const t of Object.values(terms)) byIntent[t.intent] = (byIntent[t.intent] ?? 0) + 1;

  const covered = Object.values(terms).filter((t) => t.covered).length;
  const gradable = Object.values(terms).filter((t) => t.covered !== undefined).length;
  const partial = Boolean(pool && !pool.complete);

  return {
    listing: meta
      ? {
          title: meta.title ?? null,
          subtitle: meta.subtitle ?? null,
          subtitleChars: (meta.subtitle ?? "").length,
          keywordField: meta.keywordField ?? null,
          fieldChars: (meta.keywordField ?? "").length,
          fieldUpdated: meta.fieldUpdated ?? null,
          fetchedAt: meta.fetchedAt ?? null,
          screenshots: meta.screenshots ?? [],
        }
      : null,
    coverage: gradable ? { covered, of: gradable, partial } : null,
    // Always present, including where the current field is unknown. What the
    // field should say does not depend on anyone having written down what it
    // says now.
    recommended: recommendField(cc, terms, meta, model),
    builder: builderFor(model, meta),
    byIntent,
    shoppingList: shoppingList.slice(0, 12),
    unusedFieldWords: unused,
    repeatedInSubtitle: repeated,
    chase,
    terms,
  };
}

// --- live title and subtitle -------------------------------------------------

// The product page renders both in the header. The lookup API has never
// carried the subtitle, and the page's embedded JSON only holds it for the
// "You Might Also Like" shelf, which is a neighbouring app's subtitle and not
// ours — reading that was wrong by one shelf and looked entirely plausible.
//
// A localization with no subtitle is not blank on the page: Apple fills the
// same slot with the app's category, so DE and NL both scraped as
// "Gesundheit und Fitness" / "Gezondheid en fitness" and would have been
// graded as if that were the copy. The lookup API's localized `genres[0]` is
// the same string, which is what tells the two apart.
async function fetchListing(cc) {
  const [res, genre] = await Promise.all([
    fetch(`https://apps.apple.com/${cc}/app/id${config.appId}`),
    fetch(`https://itunes.apple.com/lookup?id=${config.appId}&country=${cc}`)
      .then((r) => r.json())
      .then((j) => j.results?.[0]?.genres?.[0] ?? null)
      .catch(() => null),
  ]);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const unescape = (s) =>
    s
      .replace(/&amp;/g, "&")
      .replace(/&#x27;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
  const title = html.match(/<h1[^>]*>[\s\S]*?<span class="multiline-clamp__text[^"]*">([\s\S]*?)<\/span>/);
  const subtitle = html.match(/<p class="subtitle[^"]*">([\s\S]*?)<\/p>/);
  if (!title && !subtitle) throw new Error("header not found; page markup changed");
  const sub = subtitle ? unescape(subtitle[1]) : null;
  const isCategory = sub && genre && fold(sub) === fold(genre);
  return {
    ...(title && { title: unescape(title[1]) }),
    subtitle: isCategory ? null : sub,
    // Recorded rather than inferred from a null, so a market that has never
    // been fetched and one that genuinely has no subtitle stay distinguishable.
    subtitleSet: !isCategory && Boolean(sub),
  };
}

async function refreshListings() {
  const at = new Date().toISOString();
  metadata.markets ??= {};
  let ok = 0;
  for (const cc of Object.keys(markets)) {
    try {
      const live = await fetchListing(cc);
      const prev = metadata.markets[cc] ?? {};
      const changed = prev.title !== live.title || prev.subtitle !== live.subtitle;
      if (changed && (prev.title || prev.subtitle)) {
        console.log(`${cc}: listing changed\n  was "${prev.subtitle ?? "(no subtitle)"}"\n  now "${live.subtitle ?? "(no subtitle)"}"`);
      }
      // The timestamp only moves when the listing does. Stamping every run
      // would rewrite this file four times a day with nothing in it, and the
      // git history of a metadata file is worth more as a log of when the
      // subtitle actually changed.
      metadata.markets[cc] = { ...prev, ...live, fetchedAt: changed ? at : prev.fetchedAt ?? at };
      ok++;
    } catch (err) {
      console.warn(`${cc}: ${err.message}, keeping stored listing`);
    }
  }
  await writeFile(metadataFile, JSON.stringify(metadata, null, 2) + "\n");
  console.log(`listings refreshed for ${ok}/${Object.keys(markets).length} markets`);
}

// --- outputs -----------------------------------------------------------------

const analyseAll = () =>
  Object.fromEntries(Object.keys(markets).map((cc) => [cc, analyseMarket(cc)]));

async function writeData() {
  const all = analyseAll();
  await writeFile(
    outFile,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      levers: LEVERS,
      markets: all,
    })
  );
  const chased = Object.values(all).reduce((n, m) => n + m.chase.length, 0);
  const graded = Object.values(all).filter((m) => m.coverage).length;
  console.log(
    `aso.json: ${Object.keys(all).length} markets, ${chased} chase entries, ` +
      `${graded} graded against a recorded listing`
  );
}

const pad = (s, n) => String(s).padEnd(n);

function report(only) {
  const all = analyseAll();
  for (const [cc, m] of Object.entries(all)) {
    if (only && cc !== only) continue;
    console.log(`\n=== ${cc.toUpperCase()} ${"=".repeat(60)}`);
    if (!m.listing) {
      console.log("  no listing recorded — run with --fetch, and add the keyword field by hand");
    } else {
      const l = m.listing;
      console.log(`  title      ${l.title ?? "?"}`);
      console.log(
        l.subtitle
          ? `  subtitle   ${l.subtitle}  (${l.subtitleChars}/30)`
          : `  subtitle   NONE SET — Apple shows the category here instead, and 30 indexed characters go unspent`
      );
      console.log(`  field      ${l.keywordField ?? "not recorded (add it to scripts/metadata.json)"}`);
      if (l.keywordField) console.log(`             ${l.fieldChars}/100 chars, updated ${l.fieldUpdated ?? "?"}`);
      if (m.repeatedInSubtitle.length)
        console.log(`  repeated   ${m.repeatedInSubtitle.join(", ")} (already in the subtitle, so the field copy is dead weight)`);
      if (m.unusedFieldWords.length)
        console.log(`  unused     ${m.unusedFieldWords.join(", ")} (no tracked term needs these)`);
    }
    if (m.coverage) {
      console.log(
        `  coverage   ${m.coverage.covered}/${m.coverage.of} tracked terms fully in the listing` +
          (m.coverage.partial ? " (title and subtitle only — a gap below may already be in the field)" : "")
      );
    }
    console.log(`  intents    ${Object.entries(m.byIntent).map(([k, v]) => `${k} ${v}`).join(", ")}`);

    if (m.shoppingList.length) {
      console.log("\n  Add one word, unlock these:");
      for (const s of m.shoppingList.slice(0, 8)) {
        console.log(`    ${pad(s.word, 16)} ${pad(s.demand + " demand", 12)} ${s.terms.length} term(s): ${s.terms.slice(0, 4).join(", ")}`);
      }
    }
    console.log("\n  Chase list:");
    for (const c of m.chase) {
      console.log(`    ${pad(c.score, 4)} ${pad(c.kw, 30)} ${pad(c.intent, 9)} ${c.why}`);
    }
  }
}

function csv(only) {
  const all = analyseAll();
  console.log("market,keyword,intent,pop,rank,score,covered,missing,why");
  for (const [cc, m] of Object.entries(all)) {
    if (only && cc !== only) continue;
    for (const c of m.chase) {
      const t = m.terms[c.kw];
      const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      console.log(
        [cc, cell(c.kw), t.intent, t.pop, t.rank ?? "", t.score, t.covered ?? "", cell((t.missing ?? []).join(" ")), cell(t.why)].join(",")
      );
    }
  }
}

// What the keyword field SHOULD say, worked out from the tracked phrases
// rather than from whatever it says today. Always computed, including for the
// markets whose current field nobody has written down: "not recorded" is a
// fact about bookkeeping, and the useful answer is the recommendation.
//
// One model serves both this and the interactive builder on the page. Each
// phrase is reduced to the sets of units that would satisfy it, and everything
// downstream — the greedy pack here, the live coverage in the browser — asks
// the same question of the same data. They disagreed when they were separate:
// the Chinese field reported 48 of 48 phrases covered here and 32 of 48 in the
// builder, for the identical set of words.
//
// A Latin phrase has one satisfying set, its stemmed words. A Japanese one can
// have several, because 睡眠記録 is satisfied by 睡眠記録 whole or by 睡眠 plus
// 記録, and the field should be free to buy whichever is cheaper.
const FIELD_LIMIT = 100;
const MAX_ALTS = 6;

// CJK units match by containment, not equality: a listing carrying 睡眠トラッカー
// can rank for 睡眠, exactly as coverageOf already treats it. Latin units match
// on the stem, so "talk" in the field satisfies "talks" in a phrase.
const satisfies = (unit, have) =>
  have.has(unit) || (hasCJK(unit) && [...have].some((h) => h.includes(unit)));
const satisfiedBy = (alts, have) => alts.some((alt) => alt.every((u) => satisfies(u, have)));

function tilingsOf(part, claimed, allowed) {
  const free = (piece) => Boolean(claimed?.segments.some((seg) => seg.includes(piece)));
  const out = [];
  const walk = (i, acc) => {
    if (out.length >= 400 || acc.length > 5) return;
    if (i === part.length) {
      out.push([...acc]);
      return;
    }
    for (let len = Math.min(6, part.length - i); len >= 2; len--) {
      const piece = part.slice(i, i + len);
      if (free(piece)) walk(i + len, acc);
      else if (allowed(piece)) walk(i + len, [...acc, piece]);
    }
    // The whole remainder, so a phrase sharing no runs is still expressible.
    if (part.length - i > 6) {
      const rest = part.slice(i);
      if (!free(rest)) walk(part.length, [...acc, rest]);
    }
  };
  walk(0, []);
  return out;
}

// Per phrase: the alternative unit-sets that would satisfy it, cheapest first.
function altsFor(terms, meta) {
  const claimed = poolOf({ title: meta?.title, subtitle: meta?.subtitle });
  // Units are compared by key and shown by label: the key of "talks" is its
  // stem, but the thing to paste into the field is a real word, and the
  // cheapest real word carrying that stem is the one to suggest.
  const label = new Map();
  // Every written form of every unit, so a field typed into the page can be
  // read without shipping the stemmer: "recorder" resolves to the same key as
  // "record". A word that appears in no tracked phrase resolves to nothing,
  // which is correct — it cannot affect coverage either.
  const wordKeys = {};
  const noteLabel = (key, text) => {
    const seen = label.get(key);
    if (!seen || text.length < seen.length) label.set(key, text);
  };

  // Which character runs more than one phrase uses. A run belonging to a single
  // phrase is not a word, it is a slice of one: チェ is two characters out of
  // いびきチェッカー and has no business in a keyword field. The whole phrase is
  // always allowed, so nothing becomes unreachable.
  const shared = new Map();
  const parts = new Set();
  for (const [kw, t] of Object.entries(terms)) {
    if (!CHASEABLE.has(t.intent) || !hasCJK(kw)) continue;
    for (const part of fold(kw).split(/\s+/).filter(Boolean)) {
      if (!hasCJK(part)) continue;
      parts.add(part);
      const seen = new Set();
      for (let len = 2; len <= Math.min(6, part.length); len++)
        for (let i = 0; i + len <= part.length; i++) seen.add(part.slice(i, i + len));
      for (const run of seen) shared.set(run, (shared.get(run) ?? 0) + 1);
    }
  }
  const allowedPiece = (piece) => (shared.get(piece) ?? 0) >= 2 || parts.has(piece);

  const rows = [];
  for (const [kw, t] of Object.entries(terms)) {
    if (!CHASEABLE.has(t.intent)) continue;
    let alts;
    if (hasCJK(kw)) {
      alts = [[]];
      for (const part of fold(kw).split(/\s+/).filter(Boolean)) {
        let partAlts;
        if (hasCJK(part)) partAlts = tilingsOf(part, claimed, allowedPiece);
        else if (claimed?.set.has(stem(part)) || implicit.has(stem(part))) partAlts = [[]];
        else {
          // A Latin word inside a CJK phrase ("apple watch 睡眠") still needs a
          // label, or the chip shows the stem: "appl".
          noteLabel(stem(part), part);
          partAlts = [[stem(part)]];
        }
        if (!partAlts.length) {
          alts = [];
          break;
        }
        alts = alts.flatMap((a) => partAlts.map((p) => [...new Set([...a, ...p])])).slice(0, 60);
      }
      // CJK pieces are their own label. Latin ones inside a CJK phrase were
      // labelled here too, and since noteLabel keeps the shortest string, the
      // stem "appl" beat the word "apple" it came from.
      for (const a of alts) for (const u of a) if (hasCJK(u)) noteLabel(u, u);
    } else {
      const need = [];
      for (const w of tokens(kw)) {
        const key = stem(w);
        wordKeys[w] = key;
        // Implicit words and anything the title or subtitle already carries
        // cost nothing and are never part of what a phrase still needs.
        if (implicit.has(key) || claimed?.set.has(key)) continue;
        noteLabel(key, w);
        need.push(key);
      }
      alts = [[...new Set(need)]];
    }
    if (!alts.length) continue;

    const seen = new Set();
    const unique = [];
    for (const a of alts.sort((x, y) => x.length - y.length || x.join().length - y.join().length)) {
      const key = [...a].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push([...a].sort());
      if (unique.length >= MAX_ALTS) break;
    }
    rows.push({ kw, pop: t.pop, intent: t.intent, rank: t.rank, alts: unique });
  }
  const units = [...new Set(rows.flatMap((r) => r.alts.flat()))].sort();
  for (const u of units) if (!label.has(u)) label.set(u, u);
  return {
    rows,
    units,
    label,
    wordKeys,
    claimedKeys: [...(claimed?.set ?? [])],
    claimed,
  };
}

// Greedy weighted set cover. The move is a whole missing set, not a single
// word: adding one word of a two-word phrase covers nothing, so a loop that
// required immediate gain from every single addition stalled the moment every
// remaining phrase needed a pair. Chinese stopped at 53 of 100 characters with
// sixteen phrases uncovered and budget to spare.
function recommendField(cc, terms, meta, model) {
  const { rows, label } = model;
  const picks = [];
  const have = new Set();
  let chars = 0;

  while (true) {
    const unmet = rows.filter((r) => !satisfiedBy(r.alts, have));
    if (!unmet.length) break;
    let best = null;
    for (const r of unmet) {
      for (const alt of r.alts) {
        const need = alt.filter((u) => !satisfies(u, have));
        if (!need.length) continue;
        const cost = need.reduce((n, u) => n + label.get(u).length + 1, 0) - (picks.length ? 0 : 1);
        if (chars + cost > FIELD_LIMIT) continue;
        const next = new Set([...have, ...need]);
        let gain = 0;
        for (const o of unmet) if (satisfiedBy(o.alts, next)) gain += o.pop * FIT[o.intent];
        if (gain > 0 && (!best || gain / cost > best.gain / best.cost)) best = { need, gain, cost };
      }
    }
    if (!best) break;
    for (const u of best.need) {
      picks.push(label.get(u));
      have.add(u);
    }
    chars += best.cost;
  }

  const field = picks.join(",");
  const covered = rows.filter((r) => satisfiedBy(r.alts, have));
  const currentKeys = meta?.keywordField ? new Set(words(meta.keywordField)) : null;
  const holds = (r) => currentKeys && satisfiedBy(r.alts, currentKeys);

  return {
    field,
    chars: field.length,
    covers: covered.length,
    of: rows.length,
    ...(currentKeys && {
      currentCovers: rows.filter(holds).length,
      adds: picks.filter((p) => !currentKeys.has(stem(p))),
      // Read off the field itself, so a dropped word is shown the way it is
      // written there rather than as the stem it matches on.
      drops: tokens(meta.keywordField).filter(
        (w) =>
          !have.has(stem(w)) && !model.claimedKeys.includes(stem(w)) && !implicit.has(stem(w))
      ),
      wins: rows.filter((r) => !holds(r) && satisfiedBy(r.alts, have)).map((r) => r.kw),
      loses: rows.filter((r) => holds(r) && !satisfiedBy(r.alts, have)).map((r) => r.kw),
    }),
  };
}

// The same model, shipped to the page. The browser needs the label for every
// unit so a chip reads "talk" rather than its stem, and nothing else: coverage
// there is the satisfies() rule above, which is set arithmetic over these keys.
function builderFor(model, meta) {
  return {
    // Where a word already lives, because the three fields do not carry equal
    // weight: a phrase whose words sit only in the keyword field has a wording
    // lever left (promote one into the subtitle), and a phrase already spelled
    // out in the title has none — its rank moves on conversion and ratings.
    titleKeys: [...new Set(words(meta?.title ?? ""))],
    subtitleKeys: [...new Set(words(meta?.subtitle ?? ""))],
    units: model.units,
    labels: Object.fromEntries(model.units.map((u) => [u, model.label.get(u)])),
    wordKeys: model.wordKeys,
    claimed: model.claimedKeys,
    // Seed only. The page keeps whatever field you type in your own browser,
    // because this one is a note in the repo and App Store Connect is the
    // only place the real value lives.
    current: meta?.keywordField ?? null,
    terms: model.rows,
  };
}


function fieldFor(cc) {
  const m = analyseMarket(cc);
  if (!m.listing) return console.log(`${cc}: no listing recorded; run --fetch first`);
  const r = m.recommended;
  console.log(`${cc}: recommended field (${r.chars}/${FIELD_LIMIT})\n\n${r.field}\n`);
  console.log(`covers ${r.covers}/${r.of} chaseable terms`);
  if (r.adds) console.log(`adds:  ${r.adds.join(", ") || "nothing"}`);
  if (r.drops) console.log(`drops: ${r.drops.join(", ") || "nothing"}`);
  console.log(`\nProposal only. Check it against the shopping list in --report before shipping it.`);
}


// --- CLI ---------------------------------------------------------------------

const [mode, arg] = process.argv.slice(2);
if (mode === "--fetch") {
  await refreshListings();
  await writeData();
} else if (mode === "--report") {
  report(arg);
} else if (mode === "--csv") {
  csv(arg);
} else if (mode === "--field") {
  if (!arg || !markets[arg]) {
    console.error("usage: aso.mjs --field <market>");
    process.exit(1);
  }
  fieldFor(arg);
} else {
  await writeData();
}
