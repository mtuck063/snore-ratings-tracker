// Installed audience per day and per country, rolled up from the App Store
// Connect shards that asc-reports.mjs writes. The figure Google Play shows
// as "installed audience" and Apple shows nowhere.
//
// Reads only committed data, so it needs no credential and runs in CI right
// after the ingest, the same way downloads.mjs does. It still works when that
// ingest is skipped; `through` says how current the series actually is.
//
// The estimate on any day is
//
//     first-time downloads + redownloads to date  -  deletions to date / sampling
//
// Downloads are a commerce report and complete. Deletions come from the
// analytics report, which only sees devices that opted in to sharing usage,
// so they are scaled up by the opt-in rate: first-time installs from that
// same sampled report divided by the complete download count over the same
// days. That ratio has sat near 0.285 for the life of the app and is measured
// here rather than assumed, so a drift in Apple's sampling moves the series
// instead of silently corrupting it. Restores are not counted: a restore is
// the same user on a new device, and the download that put them in the base
// was already counted once.
//
// Per-territory deletions live in the shards' `inst` family, which the ingest
// only started writing on 2026-09-29, and Apple had by then expired the
// snapshot that held the earlier history. Days before the first `inst` row
// are bridged from cohorts.json instead: it carries every deletion Apple could
// date to a download cohort, for all territories pooled, since launch. Two
// corrections make that usable. Cohort-dated deletions undercount, because a
// deletion whose download fell outside Apple's attribution window has no
// cohort and is dropped; the ratio between the two counts on the days both
// exist restores the missing share. And they carry no country, so each day's
// pooled figure is split by each country's share of the base to date, which
// is who was there to delete. A fresh ONE_TIME_SNAPSHOT re-ingested with
// `--reingest installs` replaces the bridge with real rows and it falls away.
//
// What this cannot know: a device that was wiped or retired without the app
// being deleted first. Those users leave the base without a deletion event,
// so the estimate runs a little high over time. The shape of the curve and
// the split by country are the reliable parts; the level is an estimate and
// the page says so.
//
// Countries with fewer than MIN_DL lifetime downloads are pooled into `zz` so
// the file stays small; the total always covers every territory.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ascDir = path.join(repoRoot, "docs", "data", "asc");
const outFile = path.join(repoRoot, "docs", "data", "audience.json");

const MIN_DL = 100;
// Apple restates the newest days as they mature, so the sampling rate is
// measured on days old enough to have settled.
const SETTLE_DAYS = 3;
const FALLBACK_SAMPLING = 0.285;

const shardFiles = (await readdir(ascDir).catch(() => []))
  .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
  .sort();

if (!shardFiles.length) {
  console.log("no ASC shards found; leaving audience.json alone");
  process.exit(0);
}

const nextDay = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const daysBefore = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

// date -> cc -> { dl, del, first }; dl already includes redownloads.
const days = {};
const at = (date, cc) => ((days[date] ??= {})[cc] ??= { dl: 0, del: 0, first: 0 });
const firstDlByDay = {}; // complete first-time downloads, for the sampling rate
let dlThrough = null;
let instFrom = null;
let instThrough = null;

for (const f of shardFiles) {
  const shard = JSON.parse(await readFile(path.join(ascDir, f), "utf8"));
  for (const [key, v] of Object.entries(shard.dl ?? {})) {
    const [date, cc] = key.split("|");
    at(date, cc).dl += (v.dl ?? 0) + (v.redl ?? 0);
    firstDlByDay[date] = (firstDlByDay[date] ?? 0) + (v.dl ?? 0);
    if (!dlThrough || date > dlThrough) dlThrough = date;
  }
  for (const [key, v] of Object.entries(shard.inst ?? {})) {
    const [date, cc] = key.split("|");
    const row = at(date, cc);
    row.del += v.del ?? 0;
    row.first += v.first ?? 0;
    if (!instFrom || date < instFrom) instFrom = date;
    if (!instThrough || date > instThrough) instThrough = date;
  }
}

if (!instFrom) {
  console.log("no per-territory install rows yet; run: node scripts/asc-reports.mjs --reingest installs");
  process.exit(0);
}

// cohorts.json, summed back to event dates: the bridge for days before the
// per-territory rows begin, and the full-history basis for the sampling rate.
const cohorts = JSON.parse(await readFile(path.join(ascDir, "cohorts.json"), "utf8").catch(() => "{}"));
const cohortDelByDay = {};
const cohortFirstByDay = {};
for (const [k, v] of Object.entries(cohorts)) {
  const date = k.split("|")[1];
  cohortDelByDay[date] = (cohortDelByDay[date] ?? 0) + (v.del ?? 0);
  cohortFirstByDay[date] = (cohortFirstByDay[date] ?? 0) + (v.first ?? 0);
}

// The series ends on the last day both reports have covered: a day with
// downloads and no deletions yet would bend the curve upward at the end.
const through = dlThrough < instThrough ? dlThrough : instThrough;
const from = Object.keys(days).sort()[0];
const dates = [];
for (let d = from; d <= through; d = nextDay(d)) dates.push(d);

// Sampling rate: sampled first-time installs over complete first-time
// downloads, on every settled day both reports have. The cohort file's
// first-install count agrees with the per-territory rows to within a few
// installs, so it is the full-history source; redownloads are excluded from
// the denominator because the numerator counts first installs only.
const settledThrough = daysBefore(through, SETTLE_DAYS);
let sampledFirst = 0;
let completeFirst = 0;
let sampledDays = 0;
for (const [date, n] of Object.entries(cohortFirstByDay)) {
  if (date > settledThrough || !firstDlByDay[date]) continue;
  sampledFirst += n;
  completeFirst += firstDlByDay[date];
  sampledDays++;
}
const measured = sampledFirst && completeFirst ? sampledFirst / completeFirst : null;
// A rate outside any plausible band means the reports disagree about which
// days exist, not that Apple changed its sampling; fall back rather than
// scale deletions by something absurd.
const sampling = measured && measured > 0.1 && measured < 0.9 ? measured : FALLBACK_SAMPLING;

// Bridge correction: cohort-dated deletions against every deletion, on the
// days both counts exist.
let instDel = 0;
let cohortDelOverlap = 0;
for (const date of dates) {
  if (date < instFrom) continue;
  for (const v of Object.values(days[date] ?? {})) instDel += v.del;
  cohortDelOverlap += cohortDelByDay[date] ?? 0;
}
const bridgeScale = instDel && cohortDelOverlap ? instDel / cohortDelOverlap : 1;
const bridgedDays = dates.filter((d) => d < instFrom);

// Lifetime downloads per territory decide which countries get their own line.
const lifetime = {};
for (const byCc of Object.values(days)) {
  for (const [cc, v] of Object.entries(byCc)) (lifetime[cc] ??= 0), (lifetime[cc] += v.dl);
}
const named = Object.entries(lifetime)
  .filter(([cc, dl]) => cc !== "ZZ" && dl >= MIN_DL)
  .sort((a, b) => b[1] - a[1])
  .map(([cc]) => cc);
const slot = (cc) => (named.includes(cc) ? cc.toLowerCase() : "zz");

const series = { total: [] };
for (const cc of [...named.map((c) => c.toLowerCase()), "zz"]) series[cc] = [];
const cum = {};
for (const cc of Object.keys(series)) if (cc !== "total") cum[cc] = { dl: 0, del: 0 };
let cumDl = 0;
let cumDel = 0;
const estimate = (dl, del) => Math.max(0, Math.round(dl - del / sampling));
for (const date of dates) {
  const bridged = date < instFrom;
  // Downloads first, so a bridged day's deletions are split by the base
  // including that day's arrivals: same-day deletions are real and common.
  for (const [cc, v] of Object.entries(days[date] ?? {})) {
    cum[slot(cc)].dl += v.dl;
    cumDl += v.dl;
  }
  if (bridged) {
    const del = (cohortDelByDay[date] ?? 0) * bridgeScale;
    if (del && cumDl) {
      for (const row of Object.values(cum)) row.del += (del * row.dl) / cumDl;
      cumDel += del;
    }
  } else {
    for (const [cc, v] of Object.entries(days[date] ?? {})) {
      cum[slot(cc)].del += v.del;
      cumDel += v.del;
    }
  }
  series.total.push(estimate(cumDl, cumDel));
  for (const cc of Object.keys(cum)) series[cc].push(estimate(cum[cc].dl, cum[cc].del));
}

const out = {
  generatedAt: new Date().toISOString(),
  from,
  through,
  method: "first-time downloads + redownloads to date, minus deletions to date divided by the sampling rate",
  sampling: Number(sampling.toFixed(4)),
  samplingMeasured: measured == null ? null : Number(measured.toFixed(4)),
  samplingBasis: { sampledInstalls: sampledFirst, downloads: completeFirst, days: sampledDays, through: settledThrough },
  bridge: bridgedDays.length
    ? {
        through: bridgedDays.at(-1),
        days: bridgedDays.length,
        scale: Number(bridgeScale.toFixed(3)),
        note: "deletions before this date come from the cohort file, pooled across countries and split by each country's share of the base",
      }
    : null,
  minDownloads: MIN_DL,
  lifetime: {
    downloads: cumDl,
    deletionsSampled: Math.round(cumDel),
    deletions: Math.round(cumDel / sampling),
  },
  dates,
  series,
};

await writeFile(outFile, JSON.stringify(out) + "\n");
console.log(
  `audience.json: ${from} → ${through}, ${dates.length} days, ${named.length} countries + zz, ` +
    `sampling ${sampling.toFixed(3)}${measured == null ? " (fallback)" : ` (measured on ${sampledDays} days)`}, ` +
    (bridgedDays.length ? `${bridgedDays.length} days bridged from cohorts ×${bridgeScale.toFixed(2)}, ` : "") +
    `installed now ≈ ${series.total.at(-1).toLocaleString()} ` +
    `(${cumDl.toLocaleString()} downloads − ${out.lifetime.deletions.toLocaleString()} deletions)`
);
