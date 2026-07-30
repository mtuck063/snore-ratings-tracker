#!/usr/bin/env node
// Keyword rank & popularity collector for Snore Timeline.
//
// For every keyword in scripts/keywords.json, per market:
//  - Rank: position of the app in iTunes Search API results (the public proxy
//    for App Store search).
//  - Popularity: 5-100 score derived from Apple's search-hints (autocomplete)
//    endpoint by prefix probing: the shorter the prefix at which the keyword
//    surfaces in the suggestions and the higher its position, the more people
//    search it. Ordinal, not calibrated; comparable day over day.
//  - Discovery: the full suggestion list under each watch prefix, so a new
//    term Apple starts suggesting shows up as an event.
//
// Search requests all fire in parallel (verified: 210 simultaneous calls, no
// throttling). The hints endpoint starts returning 429 somewhere past ~300
// concurrent requests, so those go through a concurrency gate instead.
// A failed fetch retries with backoff, then keeps the previous value, so an
// outage can't fake a rank drop.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const servedDataDir = path.join(repoRoot, "docs", "data");
const dataFile = path.join(servedDataDir, "keywords.json");

const configFile = path.join(repoRoot, "scripts", "keywords.json");
const config = JSON.parse(await readFile(configFile, "utf8"));
const { appId, markets, keywords, watchPrefixes } = config;
// A market entry may carry its own localized keywords/watchPrefixes/seedTokens;
// otherwise it tracks the global (English) lists. extraKeywords extend the
// global list for markets that share the English core plus local phrases.
const kwFor = (cc) =>
  markets[cc].keywords ?? [...new Set([...keywords, ...(markets[cc].extraKeywords ?? [])])];
const watchFor = (cc) => markets[cc].watchPrefixes ?? watchPrefixes;
const seedFor = (cc) => markets[cc].seedTokens ?? config.seedTokens ?? [];

// Accent-insensitive comparison, so "apnée" and "apnee" count as one keyword.
const fold = (s) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

const RETRY_BACKOFF_MS = 10000;
const MIN_PREFIX = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

// --- Rank: iTunes Search API -----------------------------------------------

// Resolves to a 1-based rank, null (not in the top 200), or "error".
async function fetchRank(kw, cc, attempt = 1) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(kw)}&country=${cc}&entity=software&limit=200`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = (await res.json()).results ?? [];
    const idx = results.findIndex((r) => String(r.trackId) === appId);
    return idx === -1 ? null : idx + 1;
  } catch (err) {
    if (attempt === 1) {
      await sleep(RETRY_BACKOFF_MS);
      return fetchRank(kw, cc, 2);
    }
    console.warn(`${cc} "${kw}": ${err.message}, keeping previous rank`);
    return "error";
  }
}

async function rankPass(cc, prevMarket) {
  const list = kwFor(cc);
  const results = await Promise.all(list.map((kw) => fetchRank(kw, cc)));
  const out = {};
  list.forEach((kw, i) => {
    // Carrying the previous value on error also suppresses a spurious event.
    out[kw] = results[i] === "error" ? (prevMarket?.[kw]?.rank ?? null) : results[i];
  });
  return out;
}

// --- Popularity: search-hints prefix probing --------------------------------

const HINTS_CONCURRENCY = 50;
let hintsActive = 0;
const hintsQueue = [];
async function hintsSlot(fn) {
  if (hintsActive >= HINTS_CONCURRENCY) await new Promise((r) => hintsQueue.push(r));
  hintsActive++;
  try {
    return await fn();
  } finally {
    hintsActive--;
    hintsQueue.shift()?.();
  }
}

async function fetchHints(prefix, storefront, attempt = 1) {
  const url = `https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=${encodeURIComponent(prefix)}`;
  try {
    const xml = await hintsSlot(async () => {
      const res = await fetch(url, { headers: { "X-Apple-Store-Front": storefront } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
    return [...xml.matchAll(/<string>([^<]+)<\/string>/g)]
      .map((m) => m[1].replace(/&amp;/g, "&").toLowerCase())
      .filter((s) => !s.startsWith("http") && s !== "suggestions");
  } catch (err) {
    if (attempt <= 2) {
      await sleep(RETRY_BACKOFF_MS * attempt);
      return fetchHints(prefix, storefront, attempt + 1);
    }
    throw err;
  }
}

// Surfacing at a 2-char prefix in the top slot -> 100; never surfacing -> 5.
function popScore(term, prefixLen, position) {
  if (prefixLen == null) return 5;
  const depth = term.length === MIN_PREFIX ? 1 : 1 - (prefixLen - MIN_PREFIX) / (term.length - MIN_PREFIX);
  const pos = (10 - (position - 1)) / 10;
  return Math.round(5 + 95 * (0.7 * depth + 0.3 * pos));
}

async function popularityPass(storefront, list, prevMarket) {
  const prefixes = [...new Set(list.flatMap((term) => {
    const out = [];
    for (let len = MIN_PREFIX; len <= term.length; len++) out.push(term.slice(0, len));
    return out;
  }))];
  const lists = await Promise.all(
    prefixes.map((p) =>
      fetchHints(p, storefront).catch((err) => {
        console.warn(`hints "${p}": ${err.message}, skipping prefix`);
        return null;
      })
    )
  );
  const byPrefix = new Map(prefixes.map((p, i) => [p, lists[i]]));

  const out = {};
  for (const term of list) {
    let f = null;
    let sawFailure = false;
    for (let len = MIN_PREFIX; len <= term.length && !f; len++) {
      const prefix = term.slice(0, len);
      const hits = byPrefix.get(prefix);
      if (hits === null) sawFailure = true; // fetch failed; term may have surfaced here
      const idx = hits?.indexOf(term) ?? -1;
      if (idx !== -1) f = { prefix, pos: idx + 1 };
    }
    const measured = { pop: popScore(term, f?.prefix.length, f?.pos), ...(f && { prefix: f.prefix, pos: f.pos }) };
    // A failed prefix fetch can only understate the score, so when one was
    // involved keep the previous day's value if it was higher: an outage
    // shouldn't read as a demand collapse.
    const prev = prevMarket?.[term];
    out[term] =
      sawFailure && prev?.pop > measured.pop
        ? { pop: prev.pop, ...(prev.prefix && { prefix: prev.prefix, pos: prev.pos }) }
        : measured;
  }
  return out;
}

async function watchPass(storefront, prevWatch, prefixes) {
  const lists = await Promise.all(
    prefixes.map((p) =>
      fetchHints(p, storefront).catch((err) => {
        console.warn(`watch "${p}": ${err.message}, keeping previous list`);
        return prevWatch?.[p] ?? [];
      })
    )
  );
  return Object.fromEntries(prefixes.map((p, i) => [p, lists[i]]));
}

// --- Main -------------------------------------------------------------------

const fetchedAt = new Date().toISOString();
const today = fetchedAt.slice(0, 10);
const prev = await readJson(dataFile, null);

const perMarket = await Promise.all(
  Object.entries(markets).map(async ([cc, { storefront }]) => {
    const [ranks, pops, watch] = await Promise.all([
      rankPass(cc, prev?.latest?.[cc]),
      popularityPass(storefront, kwFor(cc), prev?.latest?.[cc]),
      watchPass(storefront, prev?.hints?.[cc], watchFor(cc)),
    ]);
    return [cc, ranks, pops, watch];
  })
);

const latest = {};
const hints = {};
for (const [cc, ranks, pops, watch] of perMarket) {
  const list = kwFor(cc);
  latest[cc] = {};
  for (const kw of list) {
    // Carry the previous run's values so the dashboard can show run-over-run
    // deltas for rank and popularity. Absent for a keyword's first run.
    const prevKw = prev?.latest?.[cc]?.[kw];
    latest[cc][kw] = {
      rank: ranks[kw],
      ...pops[kw],
      ...(prevKw && { prevRank: prevKw.rank ?? null, prevPop: prevKw.pop ?? null }),
    };
  }
  hints[cc] = watch;
  const ranked = list.filter((kw) => ranks[kw] != null).length;
  console.log(`${cc}: ranked for ${ranked}/${list.length} keywords`);
}

// A rank event is a move worth noticing, not daily jitter.
function rankMoved(from, to) {
  if (from === to) return false;
  if (from == null || to == null) return true; // entered or left the top 200
  const crosses = (n) => (from <= n) !== (to <= n);
  return Math.abs(from - to) >= 3 || crosses(3) || crosses(10);
}

const events = prev?.events ?? [];
const discovered = {}; // cc -> new suggestion terms this run
if (prev) {
  for (const [cc, kws] of Object.entries(latest)) {
    for (const [kw, cur] of Object.entries(kws)) {
      const from = prev.latest?.[cc]?.[kw]?.rank;
      if (from !== undefined && rankMoved(from, cur.rank)) {
        events.push({ at: fetchedAt, cc, kw, type: "rank", from, to: cur.rank });
      }
    }
    for (const [prefix, list] of Object.entries(hints[cc])) {
      const before = new Set(prev.hints?.[cc]?.[prefix] ?? []);
      if (before.size === 0) continue; // first sighting of this prefix: baseline
      for (const term of list) {
        if (!before.has(term)) {
          events.push({ at: fetchedAt, cc, prefix, term, type: "hint" });
          (discovered[cc] ??= new Set()).add(term);
        }
      }
    }
  }
}

// Auto-discovery: a new suggestion containing one of the market's seed tokens
// is a real search phrase in this niche, so promote it to the tracked list.
// It gets its first rank/pop measurement on the next run. Guardrails: skip
// app-title-looking strings, cap additions per market per run so a hints
// hiccup can't flood the config.
const MAX_AUTOTRACK = 5;
let configChanged = false;
for (const [cc, terms] of Object.entries(discovered)) {
  const target = markets[cc].keywords ?? keywords; // shared ref into config
  let added = 0;
  for (const term of terms) {
    if (added >= MAX_AUTOTRACK) break;
    if (term.length > 30 || /[:&™|]/.test(term)) continue;
    if (!seedFor(cc).some((tok) => fold(term).includes(fold(tok)))) continue;
    if (target.some((k) => fold(k) === fold(term))) continue;
    target.push(term);
    added++;
    configChanged = true;
    events.push({ at: fetchedAt, cc, term, type: "autotrack" });
    console.log(`${cc}: now tracking "${term}"`);
  }
}
if (configChanged) await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");

// History: one row per day, aggregated across the day's runs. Per keyword:
// [avgRank, pop, minRank, maxRank, samples] — a running average with range,
// so intra-run jitter washes out. Null ranks don't dilute the average.
// (Older rows may hold the legacy [rank, pop] shape; treated as one sample.)
const history = prev?.history ?? [];
const existing = history.findIndex((r) => r.date === today);
const prevRow = existing >= 0 ? history[existing] : null;
const row = { date: today, markets: {} };
for (const [cc, kws] of Object.entries(latest)) {
  row.markets[cc] = {};
  for (const [kw, { rank, pop }] of Object.entries(kws)) {
    const p = prevRow?.markets?.[cc]?.[kw];
    if (!p || p[0] == null) {
      row.markets[cc][kw] = rank != null ? [rank, pop, rank, rank, 1] : [null, pop];
    } else if (rank == null) {
      const [pAvg, , pMin = p[0], pMax = p[0], pN = 1] = p;
      row.markets[cc][kw] = [pAvg, pop, pMin, pMax, pN];
    } else {
      const [pAvg, , pMin = p[0], pMax = p[0], pN = 1] = p;
      const n = pN + 1;
      const avg = Math.round(((pAvg * pN + rank) / n) * 10) / 10;
      row.markets[cc][kw] = [avg, pop, Math.min(pMin, rank), Math.max(pMax, rank), n];
    }
  }
}
if (existing >= 0) history[existing] = row;
else history.push(row);
history.sort((a, b) => a.date.localeCompare(b.date));

await writeFile(dataFile, JSON.stringify({ fetchedAt, latest, hints, events, history }));
console.log(`${today}: ${keywords.length} keywords across ${Object.keys(markets).length} markets`);
