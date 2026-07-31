#!/usr/bin/env node
// Keyword rank & popularity collector for Snore Timeline.
//
// For every keyword in scripts/keywords.json, per market:
//  - Rank: position of the app in iTunes Search API results (the public proxy
//    for App Store search; verified to track device-accurate ranks closely).
//  - Popularity: 5-100 score derived from Apple's search-hints (autocomplete)
//    endpoint by prefix probing: the shorter the prefix at which the keyword
//    surfaces in the suggestions and the higher its position, the more people
//    search it. Ordinal, not calibrated; comparable day over day.
//  - Discovery: the full suggestion list under each watch prefix, so a new
//    term Apple starts suggesting shows up as an event.
//
// Apple throttles the search API hard for GitHub-runner IPs (it's an IP
// lottery: some runners lose half their calls). The workflow therefore runs
// one job per market — each job gets its own runner IP making only ~20-60
// search calls — then a merge job combines the partials:
//
//   node keywords.mjs --collect <cc>   fetch one market -> partials/<cc>.json
//   node keywords.mjs --merge          partials + prev state -> data files
//   node keywords.mjs                  all markets in-process (local use)
//
// Every request goes through a small concurrency gate with growing backoff;
// a fetch that still fails carries the previous value at merge time, so an
// outage can't fake a rank drop.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const servedDataDir = path.join(repoRoot, "docs", "data");
const dataFile = path.join(servedDataDir, "keywords.json");
const partialsDir = path.join(repoRoot, "partials");

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

const MIN_PREFIX = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeGate(limit) {
  let active = 0;
  const queue = [];
  return async (fn) => {
    if (active >= limit) await new Promise((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
const searchGate = makeGate(4);
const hintsGate = makeGate(16);
// Growing waits: 429s are refill-rate limits, so patience genuinely helps.
const BACKOFFS_MS = [15000, 45000, 90000];

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

// --- Rank: iTunes Search API -----------------------------------------------

// Resolves to { rank (1-based | null if outside top 200), top (the top five
// [appId, name] results — competitor context that comes free with the same
// request) } or "error".
async function fetchRank(kw, cc, attempt = 1) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(kw)}&country=${cc}&entity=software&limit=200`;
  try {
    const results = await searchGate(async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).results ?? [];
    });
    const idx = results.findIndex((r) => String(r.trackId) === appId);
    return {
      rank: idx === -1 ? null : idx + 1,
      top: results.slice(0, 5).map((r) => ({
        id: String(r.trackId),
        name: (r.trackName ?? "").slice(0, 42),
        icon: r.artworkUrl60 ?? null,
      })),
    };
  } catch (err) {
    if (attempt <= BACKOFFS_MS.length) {
      await sleep(BACKOFFS_MS[attempt - 1]);
      return fetchRank(kw, cc, attempt + 1);
    }
    console.warn(`${cc} "${kw}": ${err.message}, will carry previous rank`);
    return "error";
  }
}

// --- Popularity: search-hints prefix probing --------------------------------

async function fetchHints(prefix, storefront, attempt = 1) {
  const url = `https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=${encodeURIComponent(prefix)}`;
  try {
    const xml = await hintsGate(async () => {
      const res = await fetch(url, { headers: { "X-Apple-Store-Front": storefront } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
    return [...xml.matchAll(/<string>([^<]+)<\/string>/g)]
      .map((m) => m[1].replace(/&amp;/g, "&").toLowerCase())
      .filter((s) => !s.startsWith("http") && s !== "suggestions");
  } catch (err) {
    if (attempt <= 2) {
      await sleep(BACKOFFS_MS[attempt - 1]);
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

// --- Raw per-market collection (no previous-state logic) --------------------

async function popularityPassRaw(storefront, list) {
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
    out[term] = {
      pop: popScore(term, f?.prefix.length, f?.pos),
      ...(f && { prefix: f.prefix, pos: f.pos }),
      ...(sawFailure && !f && { failed: true }),
    };
  }
  return out;
}

async function collectMarket(cc) {
  const { storefront } = markets[cc];
  const list = kwFor(cc);
  const [rankResults, pops, watchLists] = await Promise.all([
    Promise.all(list.map((kw) => fetchRank(kw, cc))),
    popularityPassRaw(storefront, list),
    Promise.all(
      watchFor(cc).map((p) =>
        fetchHints(p, storefront).catch((err) => {
          console.warn(`watch "${p}": ${err.message}, will carry previous list`);
          return null;
        })
      )
    ),
  ]);
  const ranks = {};
  const tops = {}; // kw -> [appId x5]; app metadata deduped into `apps`
  const apps = {};
  list.forEach((kw, i) => {
    const r = rankResults[i];
    ranks[kw] = r === "error" ? "error" : r.rank;
    if (r !== "error") {
      tops[kw] = r.top.map((t) => t.id);
      for (const t of r.top) apps[t.id] = { name: t.name, ...(t.icon && { icon: t.icon }) };
    }
  });
  const watch = Object.fromEntries(watchFor(cc).map((p, i) => [p, watchLists[i]]));
  const errors = rankResults.filter((r) => r === "error").length;
  console.log(`${cc}: collected (${errors} rank fetches failed)`);
  return { cc, ranks, pops, watch, tops, apps };
}

// --- Merge: previous-state logic, events, history, writes -------------------

async function merge(partials) {
  const fetchedAt = new Date().toISOString();
  const today = fetchedAt.slice(0, 10);
  const prev = await readJson(dataFile, null);
  let rankFailures = 0;

  // Shared app-metadata dictionary: every top-5 list stores bare app ids and
  // resolves name/icon here, so nothing is duplicated per keyword or market.
  // Icons are Apple CDN URLs — no image bytes stored anywhere. First market
  // in config order wins the (localized) name, so English names take
  // precedence; previous state only fills gaps.
  const apps = {};
  for (const cc of Object.keys(markets)) {
    const part = partials.find((p) => p?.cc === cc);
    if (part?.apps) for (const [id, meta] of Object.entries(part.apps)) apps[id] ??= meta;
  }
  for (const [id, meta] of Object.entries(prev?.apps ?? {})) apps[id] ??= meta;

  // First run of a new UTC day: snapshot yesterday's closing surf details.
  const newDay = Boolean(prev?.fetchedAt) && prev.fetchedAt.slice(0, 10) < today;

  const latest = {};
  const hints = {};
  for (const cc of Object.keys(markets)) {
    const list = kwFor(cc);
    const part = partials.find((p) => p?.cc === cc) ?? null;
    latest[cc] = {};
    const dayAgo = Date.now() - 864e5;
    for (const kw of list) {
      const prevKw = prev?.latest?.[cc]?.[kw];
      // `in` check, not ??: a legitimate "not in the top 200" is null, which
      // must not read as a fetch failure.
      const rawRank = part && kw in (part.ranks ?? {}) ? part.ranks[kw] : "error";
      if (rawRank === "error") rankFailures++;
      const rank = rawRank === "error" ? (prevKw?.rank ?? null) : rawRank;
      // A failed prefix fetch can only understate the score, so keep the
      // previous day's value when it was higher: an outage shouldn't read as
      // a demand collapse. Same when the whole market partial is missing.
      const rawPop = part?.pops?.[kw] ?? { pop: 5, failed: true };
      const measured = { pop: rawPop.pop, ...(rawPop.prefix && { prefix: rawPop.prefix, pos: rawPop.pos }) };
      const pops =
        rawPop.failed && prevKw?.pop > measured.pop
          ? { pop: prevKw.pop, ...(prevKw.prefix && { prefix: prevKw.prefix, pos: prevKw.pos }) }
          : measured;
      // `recent` keeps the last 24 hours of [timestamp, rank] samples for the
      // rolling 24h range, whatever the run cadence.
      const recent = [
        ...(prevKw?.recent ?? []).filter(([at]) => new Date(at) >= dayAgo),
        [fetchedAt, rank],
      ];
      // Top-5 result lists carry over on failure like everything else.
      // Legacy carried entries ([id, name] pairs) fold into the apps map.
      let top = part?.tops?.[kw];
      if (!top && prevKw?.top) {
        top = prevKw.top.map((e) => (Array.isArray(e) ? e[0] : e));
        for (const e of prevKw.top) if (Array.isArray(e)) apps[e[0]] ??= { name: e[1] };
      }
      // Yesterday's surfacing details ([pop, prefix, pos] as of the previous
      // day's last run), so the dashboard can decompose a day-over-day demand
      // change into "prefix moved" vs "position moved" with point values.
      const daySurf = newDay
        ? [prevKw?.pop ?? null, prevKw?.prefix ?? null, prevKw?.pos ?? null]
        : prevKw?.daySurf;
      latest[cc][kw] = { rank, ...pops, recent, ...(top && { top }), ...(daySurf && { daySurf }) };
    }
    hints[cc] = {};
    for (const p of watchFor(cc)) {
      hints[cc][p] = part?.watch?.[p] ?? prev?.hints?.[cc]?.[p] ?? [];
    }
    const ranked = list.filter((kw) => latest[cc][kw].rank != null).length;
    console.log(`${cc}: ranked for ${ranked}/${list.length} keywords${part ? "" : " (partial missing, all carried)"}`);
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

  // Prune app metadata nothing references anymore.
  const used = new Set();
  for (const kws of Object.values(latest))
    for (const cur of Object.values(kws)) for (const id of cur.top ?? []) used.add(id);
  for (const id of Object.keys(apps)) if (!used.has(id)) delete apps[id];

  await writeFile(dataFile, JSON.stringify({ fetchedAt, apps, latest, hints, events, history }));
  console.log(`${today}: ${Object.keys(markets).length} markets merged`);
  // The workflow greps this to decide whether to requeue on a bad runner IP.
  console.log(`RANK_FAILURES=${rankFailures}`);
}

// --- CLI --------------------------------------------------------------------

const [mode, arg] = process.argv.slice(2);
if (mode === "--collect") {
  if (!markets[arg]) throw new Error(`unknown market "${arg}"`);
  const partial = await collectMarket(arg);
  await mkdir(partialsDir, { recursive: true });
  await writeFile(path.join(partialsDir, `${arg}.json`), JSON.stringify(partial));
} else if (mode === "--merge") {
  const partials = await Promise.all(
    Object.keys(markets).map((cc) => readJson(path.join(partialsDir, `${cc}.json`), null))
  );
  await merge(partials);
} else {
  await merge(await Promise.all(Object.keys(markets).map(collectMarket)));
}
