// Per-country downloads for the ratings table, rolled up from the App Store
// Connect shards that asc-reports.mjs already writes.
//
// Reads only committed data, so it needs no credential of its own and runs
// in CI straight after the ingest that refreshes those shards. It still works
// when that ingest is skipped -- it simply re-sums what the shards already
// held, which is why `through` is recorded: it is the only thing that says
// how current the figures actually are.
//
// Downloads are complete rather than sampled — commerce reports always are —
// so these need none of the ~3.5x correction the session and deletion figures
// take. First-time downloads and redownloads are kept apart: pooling them
// answers "how many times was this installed", which is not the question the
// ratings table is asking.
//
// Territory granularity is whatever the shards kept. asc-reports.mjs folds
// everything outside its KEEP list into ZZ to stop a long tail of
// one-download countries tripling the file size, so a storefront outside that
// list has no figure here at all. Recorded as absent rather than zero: a
// market with no downloads and a market nobody counted are different, and the
// table has to be able to tell them apart.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ascDir = path.join(repoRoot, "docs", "data", "asc");
const outFile = path.join(repoRoot, "docs", "data", "downloads.json");

const RECENT_DAYS = 30;

const shardFiles = (await readdir(ascDir).catch(() => []))
  .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
  .sort();

if (!shardFiles.length) {
  console.log("no ASC shards found; leaving downloads.json alone");
  process.exit(0);
}

// date|territory|source -> counts. Source is dropped: per-source download
// splits are real, but the ratings table is a per-country view and summing
// them is the only thing it wants.
const byCc = {};
const dates = new Set();

for (const f of shardFiles) {
  const shard = JSON.parse(await readFile(path.join(ascDir, f), "utf8"));
  for (const [key, v] of Object.entries(shard.dl ?? {})) {
    const [date, cc] = key.split("|");
    dates.add(date);
    const row = (byCc[cc] ??= { dl: 0, redl: 0, recent: 0 });
    row.dl += v.dl ?? 0;
    row.redl += v.redl ?? 0;
  }
}

const allDates = [...dates].sort();
const through = allDates[allDates.length - 1] ?? null;
// Counted back from the last day with data rather than from today, so a stale
// shard reports a real 30-day window instead of a mostly empty one.
const cutoff = through
  ? new Date(new Date(`${through}T00:00Z`).getTime() - (RECENT_DAYS - 1) * 864e5)
      .toISOString()
      .slice(0, 10)
  : null;

if (cutoff) {
  for (const f of shardFiles) {
    const shard = JSON.parse(await readFile(path.join(ascDir, f), "utf8"));
    for (const [key, v] of Object.entries(shard.dl ?? {})) {
      const [date, cc] = key.split("|");
      if (date < cutoff) continue;
      byCc[cc].recent += v.dl ?? 0;
    }
  }
}

const countries = {};
for (const [cc, v] of Object.entries(byCc)) countries[cc.toLowerCase()] = v;

const total = Object.values(byCc).reduce(
  (s, v) => ({ dl: s.dl + v.dl, redl: s.redl + v.redl, recent: s.recent + v.recent }),
  { dl: 0, redl: 0, recent: 0 }
);

await writeFile(
  outFile,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      through,
      from: allDates[0] ?? null,
      recentDays: RECENT_DAYS,
      total,
      countries,
    },
    null,
    1
  ) + "\n"
);

console.log(
  `downloads.json: ${Object.keys(countries).length} territories, ` +
    `${total.dl} first-time downloads through ${through}` +
    (countries.zz ? ` (${countries.zz.dl} unattributed in ZZ)` : "")
);
