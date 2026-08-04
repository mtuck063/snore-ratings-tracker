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
const words = (s) => tokens(s).map(fold);

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
  const missing = tokens(term).filter((w) => !pool.set.has(fold(w)));
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
  // Every word standing between you and this phrase is one you have already
  // refused to buy. It is not a cheap fix, it is a closed door, and ranking it
  // as a one-word win puts "add ai" back on the list every single run.
  if (cov.missing.every((w) => vetoed.has(fold(w)))) return 0.4;
  return cov.missing.length <= 2 ? 1.25 : 0.85;
}

function scoreOf({ pop, rank, intent, cov }) {
  const raw = (pop / 100) * winnability(rank) * FIT[intent] * lever(cov);
  return Math.round(100 * raw);
}

function reasonFor({ pop, rank, cov, intent }) {
  const where = rank == null ? "unranked" : `#${rank}`;
  if (cov && !cov.covered) {
    const list = cov.missing.map((m) => `"${m}"`).join(", ");
    if (!cov.partial && cov.missing.every((w) => vetoed.has(fold(w)))) {
      return `${pop} pop, ${where}, only reachable by adding ${list}, which you have ruled out`;
    }
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

// Words you have decided never to buy, whatever the demand behind them.
// Without this the shopping list re-proposes the same rejected word every run,
// and a recommendation you have already said no to teaches you to skim.
const vetoed = new Set((overrides.vetoWords ?? []).map(fold));

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
      if (vetoed.has(w)) continue;
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
  const fieldWords = meta?.keywordField ? words(meta.keywordField) : [];
  const unused = fieldWords.filter((w) => !needed.has(w));

  // Subtitle words repeated in the field: Apple pools them, so the second copy
  // buys nothing and the characters could hold another word.
  const subtitleWords = new Set(words(meta?.subtitle ?? ""));
  const repeated = fieldWords.filter((w) => subtitleWords.has(w));

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
    recommended: recommendField(cc, terms, meta),
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
    JSON.stringify({ generatedAt: new Date().toISOString(), markets: all })
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

// What the keyword field SHOULD say, worked out from the tracked terms rather
// than from whatever it says today. Always computed, including for the markets
// whose current field nobody has written down: "not recorded" is a fact about
// bookkeeping, and the useful answer is the recommendation.
//
// This is set cover, not a ranking of words. A word only pays off when every
// other word of its phrase is present too, so "auto" is worth nothing until
// "sleep" and "tracker" are there, and value has to be measured against what
// has already been picked. Scoring each word independently and taking the top
// hundred characters is what produced a field full of half-covered phrases.
//
// Candidate units differ by script for the same reason coverage does. A Latin
// field is built from words. A Japanese or Chinese one has no spaces to split
// on, so the candidates are the character runs the terms actually share, and
// 睡眠 earns its place by appearing across five phrases rather than by being a
// word in any dictionary sense.
const FIELD_LIMIT = 100;

function recommendField(cc, terms, meta) {
  const claimed = poolOf({ title: meta?.title, subtitle: meta?.subtitle });
  const wanted = Object.entries(terms).filter(([, t]) => CHASEABLE.has(t.intent));

  const candidates = new Map(); // unit -> cost in characters
  const shared = new Map(); // CJK run -> how many distinct terms contain it
  for (const [kw] of wanted) {
    if (!hasCJK(kw)) {
      for (const w of tokens(kw)) if (!claimed?.set.has(fold(w))) candidates.set(w, w.length);
      continue;
    }
    for (const part of fold(kw).split(/\s+/).filter(Boolean)) {
      if (!hasCJK(part)) {
        if (!claimed?.set.has(part)) candidates.set(part, part.length);
        continue;
      }
      // A whole phrase is always a legitimate thing to put in the field.
      candidates.set(part, part.length);
      const seen = new Set();
      for (let len = 2; len <= Math.min(6, part.length); len++)
        for (let i = 0; i + len <= part.length; i++) seen.add(part.slice(i, i + len));
      for (const run of seen) shared.set(run, (shared.get(run) ?? 0) + 1);
    }
  }
  // A character run only becomes a candidate once more than one phrase uses it.
  // Any run of any phrase is a substring, so without this the cover happily
  // recommends チェ — two characters sliced out of いびきチェッカー, which is
  // not a word, not a query, and not something to paste into a keyword field.
  for (const [run, count] of shared) if (count >= 2) candidates.set(run, run.length);
  for (const w of vetoed) candidates.delete(w);

  // A term is satisfied once title, subtitle and the picks so far can build it.
  const satisfiedBy = (kw, picks) => {
    const pool = {
      set: new Set([...(claimed?.set ?? []), ...picks.map(fold)]),
      segments: [...(claimed?.segments ?? []), ...picks.map(fold)],
      complete: true,
    };
    return coverageOf(kw, pool).covered;
  };

  const picks = [];
  let chars = 0;
  while (true) {
    const unmet = wanted.filter(([kw]) => !satisfiedBy(kw, picks));
    if (!unmet.length) break;
    let best = null;
    for (const [unit, len] of candidates) {
      if (picks.includes(unit)) continue;
      const cost = picks.length ? len + 1 : len;
      if (chars + cost > FIELD_LIMIT) continue;
      const next = [...picks, unit];
      let gain = 0;
      for (const [kw, t] of unmet) if (satisfiedBy(kw, next)) gain += t.pop * FIT[t.intent];
      if (gain > 0 && (!best || gain / cost > best.gain / best.cost)) best = { unit, gain, cost };
    }
    if (!best) break;
    picks.push(best.unit);
    chars += best.cost;
  }

  const field = picks.join(",");
  const current = meta?.keywordField ? new Set(words(meta.keywordField)) : null;
  return {
    field,
    chars: field.length,
    covers: wanted.filter(([kw]) => satisfiedBy(kw, picks)).length,
    of: wanted.length,
    ...(current && {
      adds: picks.filter((p) => !current.has(fold(p))),
      drops: [...current].filter((w) => !picks.some((p) => fold(p) === w) && !claimed?.set.has(w)),
    }),
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
