#!/usr/bin/env node
// Candidate harvest: builds the input kw-discover.mjs relevance-tests.
//
// Autocomplete only ever suggests queries people actually type, so everything
// this returns has proven DEMAND. It proves nothing about relevance — that is
// the discovery probe's job — so the bar here is deliberately low. Cast wide
// and let a real search throw out "camping la siesta" later.
//
// Three passes, because one root query only ever returns ten suggestions:
//   root     hints(stem) for each category stem.
//   expand   hints(term) for every root hit, one level deep. The alphabet walk
//            that widens a Latin market (stem + a..z) has nothing to walk in
//            Japanese or Chinese, and re-querying hits widens all three.
//   framing  hints(stem + modifier) for the words buyers append to a query —
//            "kostenlos", "無料", "免费".
//
// Demand reuses the collector's popScore, so the number means exactly what the
// tracker's Popularity column means: the shortest prefix at which Apple
// surfaces the term, weighted by its position in that suggestion list.
//
// Usage: node scripts/kw-harvest.mjs <market> [<market> ...]
// Merges into scripts/kw-candidates.json; markets not named are left alone.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(repoRoot, "scripts", "keywords.json");
const candidatesFile = path.join(repoRoot, "scripts", "kw-candidates.json");

const config = JSON.parse(await readFile(configFile, "utf8"));

// Category stems and the modifiers buyers append, per market. A stem is a word
// people search on its own; the framings are what they add when they want it
// free or want an app specifically.
const HARVEST = {
  de: {
    stems: ["schnarchen", "schnarch app", "schnarchrekorder", "schlaf", "schlaftracker",
      "schlaftagebuch", "schlafapnoe", "schlafanalyse", "schlafqualität", "schlaf aufnahme",
      "apnoe", "cpap", "wecker", "tiefschlaf", "nachts", "müde", "einschlafen"],
    framings: ["kostenlos", "app", "gratis", "apple watch", "aufnehmen", "test"],
  },
  jp: {
    stems: ["いびき", "いびき録音", "いびきアプリ", "いびき対策", "睡眠", "睡眠アプリ",
      "睡眠記録", "睡眠トラッカー", "睡眠計測", "睡眠管理", "睡眠の質", "寝言", "寝言録音",
      "無呼吸", "無呼吸症候群", "快眠", "目覚まし", "熟睡", "不眠"],
    framings: ["無料", "アプリ", "録音", "apple watch", "人気", "計測"],
  },
  cn: {
    stems: ["打鼾", "打呼", "打呼噜", "鼾声", "呼噜", "止鼾", "睡眠", "睡眠监测",
      "睡眠记录", "睡眠追踪", "睡眠质量", "睡眠周期", "梦话", "呼吸暂停", "助眠",
      "白噪音", "失眠", "深度睡眠", "闹钟"],
    framings: ["免费", "软件", "记录", "苹果手表", "监测", "检测"],
  },
};

const MIN_PREFIX = 2;
const PER_MARKET = 150; // matches the scale of the existing us/ca/gb/au batches
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
const gate = makeGate(16);

async function hints(term, storefront, attempt = 1) {
  const url = `https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=${encodeURIComponent(term)}`;
  try {
    const xml = await gate(async () => {
      const res = await fetch(url, { headers: { "X-Apple-Store-Front": storefront } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
    return [...xml.matchAll(/<string>([^<]+)<\/string>/g)]
      .map((m) => m[1].replace(/&amp;/g, "&").toLowerCase())
      .filter((s) => !s.startsWith("http") && s !== "suggestions");
  } catch (err) {
    if (attempt <= 2) {
      await sleep(3000 * attempt);
      return hints(term, storefront, attempt + 1);
    }
    console.warn(`  hints "${term}": ${err.message}, skipping`);
    return [];
  }
}

// Same rule the collector's auto-discovery uses, for the same reason: a title
// is not a query. Kept in sync with keywords.mjs deliberately — a term this
// rejects there should never arrive as a candidate here.
const weigh = (s) => [...s].reduce((n, ch) => n + (/[぀-ヿ一-鿿]/.test(ch) ? 2.5 : 1), 0);
const isTitle = (t) =>
  /[:：&＆™|｜·・–—，、（）【】]| - /.test(t) || /[぀-ヿ一-鿿]-|-[぀-ヿ一-鿿]/.test(t) || weigh(t) > 30;

function popScore(term, prefixLen, position) {
  if (prefixLen == null) return 5;
  const depth = term.length === MIN_PREFIX
    ? 1
    : 1 - (prefixLen - MIN_PREFIX) / (term.length - MIN_PREFIX);
  const pos = (10 - (position - 1)) / 10;
  return Math.round(5 + 95 * (0.7 * depth + 0.3 * pos));
}

// Demand is only meaningful at the SHORTEST prefix that surfaces a term, so
// every prefix gets probed rather than reusing whichever query happened to
// find it during the walk. Prefixes are shared across terms, hence the dedupe.
async function scoreDemand(terms, storefront) {
  const prefixes = [...new Set(terms.flatMap((t) => {
    const out = [];
    for (let len = MIN_PREFIX; len <= t.length; len++) out.push(t.slice(0, len));
    return out;
  }))];
  console.log(`  scoring demand over ${prefixes.length} prefixes`);
  const lists = await Promise.all(prefixes.map((p) => hints(p, storefront)));
  const byPrefix = new Map(prefixes.map((p, i) => [p, lists[i]]));

  const out = new Map();
  for (const term of terms) {
    let found = null;
    for (let len = MIN_PREFIX; len <= term.length && !found; len++) {
      const prefix = term.slice(0, len);
      const idx = byPrefix.get(prefix)?.indexOf(term) ?? -1;
      if (idx !== -1) found = { len, pos: idx + 1 };
    }
    out.set(term, popScore(term, found?.len, found?.pos));
  }
  return out;
}

async function harvest(cc) {
  const market = config.markets[cc];
  if (!market) throw new Error(`unknown market "${cc}"`);
  const plan = HARVEST[cc];
  if (!plan) throw new Error(`no harvest plan for "${cc}" — add stems to HARVEST`);
  const { storefront } = market;
  const tracked = new Set(
    (market.keywords ?? [...config.keywords, ...(market.extraKeywords ?? [])]).map((k) => k.toLowerCase())
  );

  // via records how a term was reached, which survives into the candidate file:
  // a term found by more than one pass is corroborated, not just noise from a
  // single odd query.
  const via = new Map();
  const note = (term, how) => {
    const t = term.toLowerCase().trim();
    if (!t || isTitle(t) || tracked.has(t)) return;
    const seen = via.get(t);
    via.set(t, !seen || seen === how ? how : "both");
  };

  console.log(`${cc}: root pass over ${plan.stems.length} stems`);
  const rootLists = await Promise.all(plan.stems.map((s) => hints(s, storefront)));
  const rootHits = new Set();
  for (const list of rootLists) for (const t of list) { rootHits.add(t); note(t, "root"); }

  console.log(`${cc}: framing pass, ${plan.stems.length}x${plan.framings.length} combinations`);
  const framed = plan.stems.flatMap((s) => plan.framings.map((f) => `${s} ${f}`));
  const framedLists = await Promise.all(framed.map((q) => hints(q, storefront)));
  for (const list of framedLists) for (const t of list) note(t, "framing");

  // One level deep only. Level three costs hundreds of calls to return the same
  // terms with a longer tail of app titles.
  const toExpand = [...rootHits].filter((t) => !isTitle(t)).slice(0, 120);
  console.log(`${cc}: expand pass over ${toExpand.length} root hits`);
  const expandLists = await Promise.all(toExpand.map((t) => hints(t, storefront)));
  for (const list of expandLists) for (const t of list) note(t, "root");

  const terms = [...via.keys()];
  console.log(`${cc}: ${terms.length} unique candidates before scoring`);
  const demand = await scoreDemand(terms, storefront);

  return terms
    .map((term) => ({ term, demand: demand.get(term), via: via.get(term) }))
    // A term nothing surfaces scores the floor, which means autocomplete no
    // longer suggests it — it has no demand to test.
    .filter((r) => r.demand > 5)
    .sort((a, b) => b.demand - a.demand)
    .slice(0, PER_MARKET);
}

const markets = process.argv.slice(2);
if (!markets.length) {
  console.error("usage: kw-harvest.mjs <market> [<market> ...]");
  process.exit(1);
}

const candidates = JSON.parse(await readFile(candidatesFile, "utf8"));
for (const cc of markets) {
  candidates[cc] = await harvest(cc);
  console.log(`${cc}: ${candidates[cc].length} candidates kept\n`);
}
await writeFile(candidatesFile, JSON.stringify(candidates, null, 1) + "\n");
console.log(`wrote ${path.relative(repoRoot, candidatesFile)}`);
