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
// Territory granularity is whatever the shards kept. Downloads keep every
// territory since the 2026-09-10 re-ingest; before it, asc-reports.mjs folded
// everything outside its KEEP list into ZZ, and a --backfill re-read the
// snapshot to split that history back out. A storefront still absent here is
// one with no download on record at all, and it is recorded as absent rather
// than zero: a market with no downloads and a market nobody counted are
// different, and the table has to be able to tell them apart.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ascDir = path.join(repoRoot, "docs", "data", "asc");
const outFile = path.join(repoRoot, "docs", "data", "downloads.json");

const RECENT_DAYS = 30;
// Downloads arrive as complete days, and the shards lag Apple by a day or two,
// so these are "the last N days on record" rather than a rolling wall-clock
// window. The ratings Δ 24h beside them genuinely is rolling, off the event
// log; the two are not measuring the same span and the table has to say so.
const WINDOWS = { d1: 1, d7: 7 };

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
    const row = (byCc[cc] ??= { dl: 0, redl: 0, recent: 0, d1: 0, d7: 0, from: date });
    row.dl += v.dl ?? 0;
    row.redl += v.redl ?? 0;
    // The first day this territory had a download on record. Every territory
    // is counted separately for the whole history, so this is a first sale.
    if (date < row.from) row.from = date;
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

const cutoffFor = (days) =>
  through
    ? new Date(new Date(`${through}T00:00Z`).getTime() - (days - 1) * 864e5).toISOString().slice(0, 10)
    : null;
const since = { recent: cutoff, d1: cutoffFor(WINDOWS.d1), d7: cutoffFor(WINDOWS.d7) };

if (cutoff) {
  for (const f of shardFiles) {
    const shard = JSON.parse(await readFile(path.join(ascDir, f), "utf8"));
    for (const [key, v] of Object.entries(shard.dl ?? {})) {
      const [date, cc] = key.split("|");
      const n = v.dl ?? 0;
      if (date >= since.recent) byCc[cc].recent += n;
      if (date >= since.d7) byCc[cc].d7 += n;
      if (date >= since.d1) byCc[cc].d1 += n;
    }
  }
}

// Every territory is split out for the whole history since the 2026-09-10
// re-ingest, so a first record late in the ledger is a late first sale, not
// a late addition to a keep list. The `partial` floor marker that used to be
// inferred from that gap is gone with the pooling that made it necessary; a
// figure here is the whole count on record.
const countries = {};
for (const [cc, v] of Object.entries(byCc)) countries[cc.toLowerCase()] = { ...v };

const total = Object.values(byCc).reduce(
  (s, v) => ({
    dl: s.dl + v.dl,
    redl: s.redl + v.redl,
    recent: s.recent + v.recent,
    d1: s.d1 + v.d1,
    d7: s.d7 + v.d7,
  }),
  { dl: 0, redl: 0, recent: 0, d1: 0, d7: 0 }
);

await writeFile(
  outFile,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      through,
      from: allDates[0] ?? null,
      recentDays: RECENT_DAYS,
      // The exact spans the d1/d7 figures cover, so the table can name the
      // dates instead of implying a wall-clock window it does not have.
      windows: { d1: { days: WINDOWS.d1, since: since.d1 }, d7: { days: WINDOWS.d7, since: since.d7 } },
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
