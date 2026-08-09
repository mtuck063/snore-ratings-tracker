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
// one job per market, and splits a market that has grown past SHARD_MAX
// keywords across several jobs, so no runner IP makes more than that many
// search calls — then a merge job combines the partials:
//
//   node keywords.mjs --matrix         the job list for the workflow, as JSON
//   node keywords.mjs --collect <cc> [i/n]
//                                      fetch one market (or its i-th shard)
//                                      -> partials/<cc>.json | <cc>-<i>.json
//   node keywords.mjs --merge          partials + prev state -> data files
//   node keywords.mjs                  all markets in-process (local use)
//
// Every request goes through a small concurrency gate with growing backoff;
// a fetch that still fails carries the previous value at merge time, so an
// outage can't fake a rank drop.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const servedDataDir = path.join(repoRoot, "docs", "data");
const dataFile = path.join(servedDataDir, "keywords.json");
// Autocomplete state the merge diffs against to spot new suggestions. Kept in
// the repo but out of docs/, because every visitor was downloading it and no
// page has ever read it.
const hintsFile = path.join(repoRoot, "scripts", "hints.json");
// Movement log, one shard per month plus an index. The merge only ever appends
// and both pages want the newest slice, so a single growing array made every
// visitor download every event ever recorded — 2.6MB gzipped at a year's rate.
const kwEventsDir = path.join(servedDataDir, "kw-events");
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

// Search calls one runner IP may make before Apple starts answering 403. The
// number is empirical: markets in the 50-70 range have run clean for months,
// and the first losses came from an 81-keyword US leg. Auto-discovery keeps
// growing these lists, so the workflow matrix is generated from this rather
// than written out — a market crossing the line splits itself.
const SHARD_MAX = 50;
const shardsFor = (cc) => Math.ceil(kwFor(cc).length / SHARD_MAX);

// "2/3" -> the middle third. A single-shard spec means the market is small
// enough to stay on one runner, which is the same thing as no shard at all.
const parseShard = (spec) => {
  if (!spec) return null;
  const [i, of] = spec.split("/").map(Number);
  if (!(i >= 1 && of >= 1 && i <= of)) throw new Error(`bad shard "${spec}"`);
  return of === 1 ? null : { idx: i - 1, of };
};

// Sorted before slicing, so keywords sharing a stem land on the same runner:
// the popularity pass probes every prefix of every keyword, and neighbours in
// sort order share almost all of theirs. Splitting them would make both
// runners walk "s", "sn", "sno"… separately.
const shardOf = (list, shard) => {
  if (!shard) return list;
  const sorted = [...list].sort();
  const size = Math.ceil(sorted.length / shard.of);
  return sorted.slice(shard.idx * size, (shard.idx + 1) * size);
};

// Accent-insensitive comparison, so "apnée" and "apnee" count as one keyword.
const fold = (s) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

// Length measured in meaning rather than characters: kana and han glyphs pack
// far more per character than letters do. Used by the auto-discovery cap.
const weigh = (s) => [...s].reduce((n, ch) => n + (/[぀-ヿ一-鿿]/.test(ch) ? 2.5 : 1), 0);

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

// Resolves to { rank (1-based | null if outside top 200), top (the top ten
// results), near (the handful sitting directly above us, when that is past
// the top ten) } or "error".
// Ten rather than five because page one of App Store search is ten results:
// an app sitting at 6-10 is still visible to a searcher, and counting only
// the top five hid every competitor in that band.
const TOP_DEPTH = 10;
// Results above our own position to record once we rank past the top ten.
// "How hard is this keyword" is not a property of the keyword: gaining five
// places means passing the five apps holding them, and for the two thirds of
// tracked terms where we sit outside page one, the top ten describes apps we
// are nowhere near. The request already carries 200 results, so this costs no
// extra call — only the metadata a few more ids pull into the shared `apps`
// map, which is why these entries skip the icon (see collectMarket).
const NEAR_DEPTH = 5;
const describe = (r, withIcon) => ({
  id: String(r.trackId),
  name: (r.trackName ?? "").slice(0, 42),
  ...(withIcon && { icon: r.artworkUrl60 ?? null }),
  // First-ever release, not the current version's date. Identical in
  // every storefront, so it rides along in the shared `apps` map.
  released: (r.releaseDate ?? "").slice(0, 10) || null,
  // Rating count and score ARE per-storefront, so they are kept per
  // market in `stats` — a US count shown under the MX tab would lie.
  ratings: r.userRatingCount ?? null,
  score: r.averageUserRating ?? null,
});
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
      top: results.slice(0, TOP_DEPTH).map((r) => describe(r, true)),
      // Empty when unranked (nobody to name) and when we are already inside
      // the top ten, where `top` covers the same apps.
      near:
        idx >= TOP_DEPTH
          ? results.slice(Math.max(0, idx - NEAR_DEPTH), idx).map((r) => describe(r, false))
          : [],
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

// The cheapest possible probe for the auto-tracker's brand check: only the
// name of the #1 result matters, so limit=3 instead of the rank fetch's 200.
async function topNameOf(term, cc) {
  try {
    return await searchGate(async () => {
      const res = await fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${cc}&entity=software&limit=3`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).results?.[0]?.trackName ?? null;
    });
  } catch {
    return null; // fail open: a network hiccup should not veto tracking
  }
}

// A brand query announces itself in its own results: the #1 app is named
// after the phrase — exactly, or phrase-then-tagline. "snoring king" passed
// every other guard and was Snoring King's own name. Exact-or-separator
// rather than a bare prefix match, because "do i snore" loses its #1 to
// "Do I Snore or Grind" and is still a symptom phrase worth tracking.
const BRAND_SEP = /^\s*[:\-–—|·•,(（：]/;
function namesake(name, term) {
  const n = fold(name);
  const t = fold(term);
  if (!n.startsWith(t)) return false;
  const rest = n.slice(t.length);
  return rest === "" || BRAND_SEP.test(rest);
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

async function collectMarket(cc, shard = null) {
  const { storefront } = markets[cc];
  const list = shardOf(kwFor(cc), shard);
  // Watch prefixes belong to the market, not to any keyword, so only the first
  // shard fetches them. Splitting a market must not multiply that work, and a
  // second copy of the same list would tell the merge nothing new.
  const watchList = shard && shard.idx > 0 ? [] : watchFor(cc);
  const [rankResults, pops, watchLists] = await Promise.all([
    Promise.all(list.map((kw) => fetchRank(kw, cc))),
    popularityPassRaw(storefront, list),
    Promise.all(
      watchList.map((p) =>
        fetchHints(p, storefront).catch((err) => {
          console.warn(`watch "${p}": ${err.message}, will carry previous list`);
          return null;
        })
      )
    ),
  ]);
  const ranks = {};
  const tops = {}; // kw -> [appId x10]; app metadata deduped into `apps`
  const nears = {}; // kw -> [appId x5], the apps directly above us
  const apps = {};
  const stats = {}; // id -> [ratings, score] for THIS storefront only
  list.forEach((kw, i) => {
    const r = rankResults[i];
    ranks[kw] = r === "error" ? "error" : r.rank;
    if (r !== "error") {
      tops[kw] = r.top.map((t) => t.id);
      if (r.near.length) nears[kw] = r.near.map((t) => t.id);
      for (const t of [...r.top, ...r.near]) {
        // Merged rather than assigned: an app can be page one for one keyword
        // and a neighbour for another, and the neighbour entry carries no
        // icon. Overwriting would blank an icon the competitor cards render,
        // in whichever order the two keywords happened to be collected.
        apps[t.id] = {
          ...apps[t.id],
          name: t.name,
          ...(t.icon && { icon: t.icon }),
          ...(t.released && { released: t.released }),
        };
        if (t.ratings != null) stats[t.id] = [t.ratings, Math.round((t.score ?? 0) * 100) / 100];
      }
    }
  });
  const watch = Object.fromEntries(watchList.map((p, i) => [p, watchLists[i]]));
  const errors = rankResults.filter((r) => r === "error").length;
  const label = shard ? `${cc} shard ${shard.idx + 1}/${shard.of}` : cc;
  console.log(`${label}: collected ${list.length} keywords (${errors} rank fetches failed)`);
  return { cc, ranks, pops, watch, tops, nears, apps, stats };
}

// Result lists have held bare ids since the top-5 lists grew a shared app
// dictionary; entries carried forward from before that are [id, name] pairs.
const bareIds = (list) => (list ?? []).map((e) => (Array.isArray(e) ? e[0] : e));

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
  // A market that errored this run keeps its previous numbers rather than
  // blanking the column, same carry-forward rule the rank data uses.
  const stats = {};
  for (const cc of Object.keys(markets)) {
    const part = partials.find((p) => p?.cc === cc);
    stats[cc] = { ...(prev?.stats?.[cc] ?? {}), ...(part?.stats ?? {}) };
  }

  // First run of a new UTC day: snapshot yesterday's closing surf details.
  const newDay = Boolean(prev?.fetchedAt) && prev.fetchedAt.slice(0, 10) < today;

  // Interned run timestamps. `runAt` also accepts a raw ISO string so rows
  // written before interning still resolve while they age out of the 24h
  // window; nothing needs a migration pass to stay readable.
  const runs = [...(prev?.runs ?? [])];
  const runIndex = (iso) => {
    const i = runs.indexOf(iso);
    return i === -1 ? runs.push(iso) - 1 : i;
  };
  const runAt = (v) => (typeof v === "number" ? runs[v] : v);

  const latest = {};
  // Previous autocomplete state now lives beside the collector rather than in
  // the served file; prev.hints is the fallback for the first run after the
  // move, when scripts/hints.json does not exist yet.
  const prevHints = await readJson(hintsFile, prev?.hints ?? {});
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
      // `recent` keeps the last 24 hours of [run, rank, pop] samples for the
      // rolling 24h windows, whatever the run cadence. `run` indexes into the
      // top-level `runs` table: every keyword in a run shares one timestamp,
      // so storing the string inline meant ~3,000 copies of eight values.
      const recent = [
        ...(prevKw?.recent ?? []).filter(([at]) => new Date(runAt(at)) >= dayAgo),
        [runIndex(fetchedAt), rank, pops.pop],
      ];
      // Result lists carry over on failure like everything else.
      // Legacy carried entries ([id, name] pairs) fold into the apps map.
      const measuredTop = Boolean(part?.tops?.[kw]);
      let top = part?.tops?.[kw];
      if (!top && prevKw?.top) {
        top = bareIds(prevKw.top);
        for (const e of prevKw.top) if (Array.isArray(e)) apps[e[0]] ??= { name: e[1] };
      }
      // The apps standing directly above us, recorded only once we rank past
      // page one. Read from this run when it measured, so that moving onto
      // page one clears a list that now describes apps we are ahead of.
      const near = measuredTop ? part.nears?.[kw] : prevKw?.near;
      // Turnover: day boundaries observed and apps that entered the top ten
      // across them, as [days, entrants]. A wall of large incumbents that
      // never reshuffles and one that turns over nightly look identical in a
      // single snapshot and are opposite propositions to compete in, and the
      // difference is only visible over days. Counted against yesterday's
      // closing list, and only when this run actually measured one: a list
      // carried through an outage would bank a false day of "nothing moved".
      const turn =
        newDay && measuredTop && prevKw?.top?.length
          ? [
              (prevKw.turn?.[0] ?? 0) + 1,
              (prevKw.turn?.[1] ?? 0) +
                top.filter((id) => !new Set(bareIds(prevKw.top)).has(id)).length,
            ]
          : prevKw?.turn;
      // Yesterday's surfacing details ([pop, prefix, pos] as of the previous
      // day's last run), so the dashboard can decompose a day-over-day demand
      // change into "prefix moved" vs "position moved" with point values.
      const daySurf = newDay
        ? [prevKw?.pop ?? null, prevKw?.prefix ?? null, prevKw?.pos ?? null]
        : prevKw?.daySurf;
      // First run that ever measured this keyword, so the dashboard can badge
      // newly tracked terms. Autotracked keywords already raise an event, but
      // ones added by hand to the config did not show up as new anywhere.
      // `prev &&` keeps a cold start from stamping the entire list at once.
      const since = prevKw ? prevKw.since : prev ? today : undefined;
      latest[cc][kw] = {
        rank, ...pops, recent,
        ...(since && { since }),
        ...(top && { top }), ...(near?.length && { near }), ...(turn && { turn }),
        ...(daySurf && { daySurf }),
      };
    }
    hints[cc] = {};
    for (const p of watchFor(cc)) {
      hints[cc][p] = part?.watch?.[p] ?? prevHints[cc]?.[p] ?? [];
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

  // Events go into the shard for the month they happened in. Only this month's
  // is loaded: the merge appends and never reads back, so older shards stay
  // untouched on disk.
  const month = fetchedAt.slice(0, 7);
  await mkdir(kwEventsDir, { recursive: true });
  // One-time fold, for the first run after the split: an older keywords.json
  // still carries the whole array. Once it is written without `events` this
  // branch stops firing.
  if (prev?.events?.length) {
    const byMonth = {};
    for (const e of prev.events) (byMonth[e.at.slice(0, 7)] ??= []).push(e);
    for (const [m, list] of Object.entries(byMonth)) {
      const existing = await readJson(path.join(kwEventsDir, `${m}.json`), []);
      const seen = new Set(existing.map((e) => JSON.stringify(e)));
      const merged = [...existing, ...list.filter((e) => !seen.has(JSON.stringify(e)))];
      merged.sort((a, b) => a.at.localeCompare(b.at));
      await writeFile(path.join(kwEventsDir, `${m}.json`), JSON.stringify(merged));
    }
    console.log(`folded ${prev.events.length} events into ${Object.keys(byMonth).length} month shard(s)`);
  }
  const events = await readJson(path.join(kwEventsDir, `${month}.json`), []);
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
        const before = new Set(prevHints[cc]?.[prefix] ?? []);
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
      // A title announces itself with separator punctuation. The set has to
      // include the fullwidth colon, pipe and middle dot the CJK stores use,
      // or the JP/CN lists fill up with competitor names on the first run.
      // The spaced hyphen is how a Latin title separates its tagline, which
      // is what let "soundsleep – snoring sounds" in; a hyphen touching a
      // glyph does the same job in a CJK title, where nothing is spaced.
      if (/[:：&＆™|｜·・–—，、（）【】]| - /.test(term)) continue;
      if (/[぀-ヿ一-鿿]-|-[぀-ヿ一-鿿]/.test(term)) continue;
      // One CJK glyph carries about as much as a short Latin word, so a flat
      // character cap cannot serve both scripts: 30 is fair for German and
      // waves through an entire Chinese title. Weighting a glyph at 2.5 keeps
      // a single budget honest for "schlaftracker apple watch" and 打呼噜检测免费
      // alike, while still passing a mixed query like "apple watch 睡眠".
      if (weigh(term) > 30) continue;
      if (!seedFor(cc).some((tok) => fold(term).includes(fold(tok)))) continue;
      if (target.some((k) => fold(k) === fold(term))) continue;
      // One search per surviving candidate — five per market per run at most.
      // If the top result is the phrase's own namesake, this is somebody's
      // brand, not a query to chase.
      const topName = await topNameOf(term, cc);
      if (topName && namesake(topName, term)) {
        console.log(`${cc}: not tracking "${term}" — #1 is "${topName}", its own name`);
        continue;
      }
      target.push(term);
      added++;
      configChanged = true;
      events.push({ at: fetchedAt, cc, term, type: "autotrack" });
      console.log(`${cc}: now tracking "${term}"`);
    }
  }
  if (configChanged) await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");

  // History: one row per day. Per keyword:
  // [closeRank, pop, minRank, maxRank, samples] — the day's *closing* rank,
  // the way a stock chart plots a close, plus the day's range.
  //
  // This was a running average until the average started contradicting the
  // page it sat on. A keyword that spent a day at 39 and jumped to 5 on the
  // last run averaged 30.7, so the sparkline's final point read 30 while the
  // Rank column beside it read 5, and the Δ column called a 34-place jump a
  // 2-place drift. Because the row is upserted every run, the close is simply
  // the latest rank, and during the day it equals the current rank — so the
  // chart's right edge can no longer disagree with the number next to it.
  //
  // The range is what preserves the jitter the average used to smooth: a noisy
  // day still shows as #5 (5–39) rather than pretending 5 was the whole story.
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
        // Fetch failed this run: hold the close and range rather than letting
        // an outage read as a rank change.
        const [pClose, , pMin = p[0], pMax = p[0], pN = 1] = p;
        row.markets[cc][kw] = [pClose, pop, pMin, pMax, pN];
      } else {
        const [, , pMin = p[0], pMax = p[0], pN = 1] = p;
        row.markets[cc][kw] = [rank, pop, Math.min(pMin, rank), Math.max(pMax, rank), pN + 1];
      }
    }
  }
  if (existing >= 0) history[existing] = row;
  else history.push(row);
  history.sort((a, b) => a.date.localeCompare(b.date));

  // Prune app metadata nothing references anymore. Two sets, because the two
  // kinds of reference cost different amounts: `shown` is what a page draws a
  // card for, `used` adds the neighbour lists, which are read for their rating
  // counts and never rendered.
  const shown = new Set();
  const used = new Set();
  for (const kws of Object.values(latest))
    for (const cur of Object.values(kws)) {
      for (const id of bareIds(cur.top)) { shown.add(id); used.add(id); }
      for (const id of bareIds(cur.near)) used.add(id);
    }
  for (const id of Object.keys(apps)) if (!used.has(id)) delete apps[id];
  for (const perCc of Object.values(stats))
    for (const id of Object.keys(perCc)) if (!used.has(id)) delete perCc[id];

  // Compact the run table. `recent` only holds 24 hours, so older runs fall out
  // of reference every day and would otherwise accumulate forever. Rewrites the
  // surviving samples to the new indices, and normalises any pre-interning ISO
  // string it finds on the way through.
  const seen = new Map();
  const compact = [];
  for (const kws of Object.values(latest))
    for (const cur of Object.values(kws))
      for (const s of cur.recent ?? []) {
        const iso = runAt(s[0]);
        if (!seen.has(iso)) { seen.set(iso, compact.length); compact.push(iso); }
        s[0] = seen.get(iso);
      }
  runs.length = 0;
  runs.push(...compact);

  // Competitor growth needs an earlier reading to subtract from, and `stats`
  // is a live snapshot this merge overwrites. Keep a short series of run-level
  // rating counts — counts only, since a score is not a rate.
  //
  // Retained by age rather than by count. A five-entry cap spanned a day at
  // four scheduled runs and nothing else, so the morning three updates were
  // dispatched by hand the window collapsed to eleven hours and every growth
  // figure on the dashboard went blank: nothing left was old enough to
  // subtract from. One snapshot per six-hour bucket holds the span open
  // however often runs fire, and keeps about as many entries as the cap did.
  //
  // The retention window has to clear the twenty-hour baseline floor by more
  // than one run's spacing. At thirty hours it did not: the moment a snapshot
  // aged past thirty and was dropped, the next one down was twenty-four hours
  // old with perfect cadence — and a single skipped scheduled run put it at
  // eighteen, under the floor, blanking the column until it aged in. Forty-
  // eight leaves the oldest survivor at least twenty hours old through three
  // consecutive missed runs. Costs four more snapshots, about 85KB.
  const BUCKET_MS = 6 * 3600e3;
  const RETAIN_MS = 48 * 3600e3;
  // Page-one apps only. This series is the largest thing in the file — every
  // snapshot repeats every app in every market — so extending it to the
  // neighbour lists would have cost more than the growth rates are worth.
  // Their current rating counts are still in `stats`, which is one row per
  // app rather than one per app per snapshot.
  const snapshot = {
    at: fetchedAt,
    markets: Object.fromEntries(
      Object.entries(stats).map(([cc, m]) => [
        cc,
        Object.fromEntries(
          Object.entries(m)
            .filter(([id]) => shown.has(id))
            .map(([id, v]) => [id, v[0]])
        ),
      ])
    ),
  };
  const byBucket = new Map();
  for (const s of [...(prev?.statsLog ?? []), snapshot]) {
    if (Date.now() - new Date(s.at) > RETAIN_MS) continue;
    byBucket.set(Math.floor(new Date(s.at).getTime() / BUCKET_MS), s); // newest wins its bucket
  }
  const statsLog = [...byBucket.values()].sort((a, b) => (a.at < b.at ? -1 : 1));
  // Older snapshots keep entries for apps that have since dropped out of every
  // top list; they would otherwise accumulate forever behind the same prune.
  for (const snap of statsLog)
    for (const perCc of Object.values(snap.markets))
      for (const id of Object.keys(perCc)) if (!shown.has(id)) delete perCc[id];

  await writeFile(hintsFile, JSON.stringify(hints) + "\n");
  await writeFile(path.join(kwEventsDir, `${month}.json`), JSON.stringify(events));
  // Index so a page can find the shards without probing for filenames, and can
  // report the full total while holding only one month in memory.
  const shards = (await readdir(kwEventsDir))
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 7))
    .sort();
  const counts = {};
  for (const m of shards) {
    counts[m] = m === month ? events.length : (await readJson(path.join(kwEventsDir, `${m}.json`), [])).length;
  }
  await writeFile(
    path.join(kwEventsDir, "index.json"),
    JSON.stringify({ months: shards, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) })
  );
  await writeFile(
    dataFile,
    JSON.stringify({ fetchedAt, runs, apps, stats, statsLog, latest, history })
  );
  // Heartbeat, so the dashboard can say when data was last *checked*, not only
  // when it last *changed* — the two look identical from the data alone. Its
  // own file: sharing one status.json with the ratings collector meant two
  // writers on one line of compact JSON, and a rebase that could not resolve.
  const statusFile = path.join(servedDataDir, "status-keywords.json");
  const tracked = Object.keys(markets).reduce((n, cc) => n + kwFor(cc).length, 0);
  await writeFile(
    statusFile,
    JSON.stringify({
      at: fetchedAt,
      markets: Object.keys(markets).length,
      tracked,
      rankFailures,
    })
  );

  console.log(`${today}: ${Object.keys(markets).length} markets merged`);
  // The workflow greps this to decide whether to requeue on a bad runner IP,
  // and to fail the run outright if a second attempt is still failing.
  console.log(`RANK_FAILURES=${rankFailures}`);
}

// --- CLI --------------------------------------------------------------------

// Shards of one market cover disjoint keywords, so a key-wise union rebuilds
// exactly the partial an unsharded run would have written. A shard whose job
// died is simply absent: its keywords go missing from `ranks`, which the merge
// already reads as "carry the previous value" rather than as a rank drop.
const joinShards = (a, b) => ({
  cc: a.cc,
  ranks: { ...a.ranks, ...b.ranks },
  pops: { ...a.pops, ...b.pops },
  watch: { ...a.watch, ...b.watch },
  tops: { ...a.tops, ...b.tops },
  nears: { ...a.nears, ...b.nears },
  apps: { ...a.apps, ...b.apps },
  stats: { ...a.stats, ...b.stats },
});

const [mode, arg, shardArg] = process.argv.slice(2);
if (mode === "--matrix") {
  // One entry per job. `id` names the artifact and the partial file, because
  // "1/2" cannot appear in either; `shard` is what the collector parses.
  const include = Object.keys(markets).flatMap((market) => {
    const of = shardsFor(market);
    return Array.from({ length: of }, (_, i) => ({
      market,
      shard: `${i + 1}/${of}`,
      id: of === 1 ? market : `${market}-${i + 1}`,
    }));
  });
  console.log(JSON.stringify({ include }));
} else if (mode === "--collect") {
  if (!markets[arg]) throw new Error(`unknown market "${arg}"`);
  const shard = parseShard(shardArg);
  const partial = await collectMarket(arg, shard);
  await mkdir(partialsDir, { recursive: true });
  const file = shard ? `${arg}-${shard.idx + 1}.json` : `${arg}.json`;
  await writeFile(path.join(partialsDir, file), JSON.stringify(partial));
} else if (mode === "--merge") {
  // Read whatever arrived rather than probing for known filenames: the number
  // of shards per market is a property of the run, not of this script.
  const files = (await readdir(partialsDir).catch(() => [])).filter((f) => f.endsWith(".json"));
  const byMarket = new Map();
  for (const f of files) {
    const part = await readJson(path.join(partialsDir, f), null);
    if (!part?.cc) continue;
    const seen = byMarket.get(part.cc);
    byMarket.set(part.cc, seen ? joinShards(seen, part) : part);
  }
  await merge(Object.keys(markets).map((cc) => byMarket.get(cc) ?? null));
} else {
  await merge(await Promise.all(Object.keys(markets).map((cc) => collectMarket(cc))));
}
