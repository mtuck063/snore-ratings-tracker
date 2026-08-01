// One-off keyword discovery: relevance-test candidate search terms.
//
// The candidates in kw-candidates.json already have proven DEMAND — every one
// was harvested from Apple's search-hints autocomplete, which only suggests
// queries people actually type. What they lack is proven RELEVANCE: "dette de
// sommeil" and "camping la siesta" both autocomplete, but only one is our
// category. Only a real search tells them apart.
//
// Relevance signal is the collector's own `apps` map — apps observed in real
// category searches across every tracked market. If a query returns those apps,
// it is our category. Freediving breath-hold apps are not in that map, which
// matters because "apnée"/"apnea" in FR/ES is dominated by them.
//
// Usage: node scripts/kw-discover.mjs <market> <chunkIndex> <chunkCount>
// Writes discovery/<market>-<chunkIndex>.json

import { readFile, writeFile, mkdir } from "node:fs/promises";

const [cc, idxRaw, countRaw] = process.argv.slice(2);
const chunkIndex = Number(idxRaw ?? 0);
const chunkCount = Number(countRaw ?? 1);
if (!cc) { console.error("usage: kw-discover.mjs <market> <chunkIndex> <chunkCount>"); process.exit(1); }

const ME = "6751759381";
const cands = JSON.parse(await readFile("scripts/kw-candidates.json", "utf8"))[cc] ?? [];
const kw = JSON.parse(await readFile("docs/data/keywords.json", "utf8"));
const KNOWN = new Set(Object.keys(kw.apps));

// Anchored so it cannot fire on Reverse/Restaurant/Forest the way a bare
// "reve"/"rest" fragment does.
const NAMEY = /(^|[^a-z])(snor|ronfl|ronqu|sommeil|sueñ|insomni|bruxis|despertador|réveil)/i;
const FREEDIVE = /freediv|freedive|apnea trainer|apnée trainer|stamina|buceo|plong|static apnea/i;

// Take every Nth item rather than a contiguous slice, so each runner gets a mix
// of high- and low-demand terms. If one runner draws a throttled IP we lose a
// spread of the list, not its whole head.
const mine = cands.filter((_, i) => i % chunkCount === chunkIndex);
console.log(`${cc} chunk ${chunkIndex}/${chunkCount}: ${mine.length} of ${cands.length} candidates`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let throttled = 0;

async function search(term, attempt = 1) {
  const u = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}`
    + `&country=${cc}&entity=software&limit=20`;
  try {
    const res = await fetch(u);
    if (res.status === 429 || res.status === 403) {
      throttled++;
      throw Object.assign(new Error(String(res.status)), { rl: true });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).results ?? [];
  } catch (err) {
    if (attempt <= 4) { await sleep((err.rl ? 15000 : 800) * attempt); return search(term, attempt + 1); }
    console.warn(`  "${term}": ${err.message}, giving up`);
    return null;
  }
}

const out = [];
for (const c of mine) {
  const r = await search(c.term);
  if (r) {
    const top10 = r.slice(0, 10);
    const mineIdx = r.findIndex((a) => String(a.trackId) === ME);
    out.push({
      term: c.term, demand: c.demand, via: c.via,
      known: top10.filter((a) => KNOWN.has(String(a.trackId))).length,
      namey: top10.filter((a) => NAMEY.test(a.trackName ?? "") && !FREEDIVE.test(a.trackName ?? "")).length,
      dive: top10.filter((a) => FREEDIVE.test(a.trackName ?? "")).length,
      results: r.length,
      myRank: mineIdx === -1 ? null : mineIdx + 1,
      top5: top10.slice(0, 5).map((a) => (a.trackName ?? "").slice(0, 40)),
    });
  }
  await sleep(900); // sequential and slow on purpose; this is what tripped the limit locally
}

await mkdir("discovery", { recursive: true });
await writeFile(`discovery/${cc}-${chunkIndex}.json`, JSON.stringify(out, null, 1));
console.log(`${cc} chunk ${chunkIndex}: ${out.length}/${mine.length} validated (${throttled} throttle events)`);
