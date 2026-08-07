#!/usr/bin/env node
// Release log: what a version changed in the listing, and what the change did.
//
// The rank table answers "where do I place today". It cannot answer "did the
// release work", because that needs three things nothing else here records:
//
//  - WHAT SHIPPED. Title and subtitle are re-fetched every run and the keyword
//    field is hand-maintained, so `metadata.json` only ever holds the current
//    listing. The moment you paste a new field in, the old one is gone from
//    everything except the git history. A release is the one time that old
//    value matters, so it is snapshotted before it is overwritten.
//  - WHAT IT WAS MEANT TO DO. Coverage is arithmetic, not a measurement: the
//    set of phrases the listing can rank for at all is known the instant the
//    field changes, with no waiting and no noise. It is also the only check
//    that catches a field that shipped with a typo or came back truncated.
//  - WHETHER IT DID IT. Rank moved, but rank moves anyway. The read is the
//    phrases whose coverage changed against the phrases whose coverage did
//    not, over the same days — if both cohorts gained eight places, Apple
//    moved, not you.
//
//   node release.mjs --record [version]   snapshot the pre-release listing
//   node release.mjs --seal               capture the post-release listing
//   node release.mjs --effect             recompute the before/after read
//   node release.mjs --report [cc]        human summary
//
// --record is run BEFORE the new keyword field is pasted into metadata.json,
// which is the only ordering constraint in the whole file: the value it saves
// is the one about to be lost. --seal is run after, once `aso.mjs --fetch` has
// pulled the live title and subtitle. --effect rides on the keyword workflow
// and rewrites only the computed block, so it is safe to run on any schedule.
//
// Never exits non-zero for a failed fetch: screenshots and version come from
// the lookup API, and an outage should leave the log unwritten rather than
// fail the run that called it.

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(repoRoot, "scripts", "keywords.json");
const metadataFile = path.join(repoRoot, "scripts", "metadata.json");
const asoFile = path.join(repoRoot, "docs", "data", "aso.json");
const kwFile = path.join(repoRoot, "docs", "data", "keywords.json");
const ratingsFile = path.join(repoRoot, "docs", "data", "history.json");
const outFile = path.join(repoRoot, "docs", "data", "releases.json");

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

const config = JSON.parse(await readFile(configFile, "utf8"));
const markets = Object.keys(config.markets);
const appId = config.appId;

// --- tuning ------------------------------------------------------------------

// Days of rank history read as the baseline. Seven covers a full week of
// whatever weekly rhythm search demand has, and is about as far back as a
// comparison stays honest: reach further and the listing being compared is one
// that had already changed for other reasons.
const BASELINE_DAYS = 7;

// A phrase that already swings more than this on its own cannot report a move
// of a few places, because its jitter is larger than the signal. Measured two
// ways, because they catch different phrases: inside a single day (the table
// shows these as ranges like #5–52) and across the baseline days. A phrase
// that sits at #90 one day and #17 the next is quiet within each day and still
// unreadable. They are counted and held out of the cohort medians rather than
// dropped, since "too noisy to read" is itself worth seeing.
const NOISE_SPAN = 30;

// Apple re-indexes a changed keyword field over days, not minutes, and the
// first day after a release reads as flat whatever you shipped. The stages
// exist so the dashboard can say "too early" in the one voice that stops a
// day-one glance being mistaken for a verdict.
const stageOf = (days) =>
  days < 3 ? "indexing" : days < 8 ? "provisional" : "settled";

// --- snapshots ---------------------------------------------------------------

const shotKey = (urls) =>
  createHash("sha1").update(urls.join("\n")).digest("hex").slice(0, 8);

// Screenshots are the one part of a listing that is public, changes on
// release, and is recorded nowhere: the lookup API returns the live set, and
// each URL carries the asset's own uuid, so a swapped screenshot is a changed
// URL. Localized markets have their own sets, which is why this asks per
// market rather than once — and why identical sets are pooled by hash, so the
// eight markets sharing one set cost one copy.
async function liveShots(cc) {
  try {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${appId}&country=${cc}`);
    const app = (await res.json()).results?.[0];
    return app?.screenshotUrls ?? null;
  } catch {
    // null, not []: a market whose shots were never read and one that genuinely
    // has none must stay distinguishable, or an outage reads as a screenshot
    // change on the next snapshot.
    return null;
  }
}

async function liveVersion() {
  try {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${appId}&country=us`);
    const app = (await res.json()).results?.[0];
    return app ? { version: app.version, at: app.currentVersionReleaseDate } : null;
  } catch {
    return null;
  }
}

// One side of a release: what the listing said, and which phrases that let it
// rank for. Coverage is read out of aso.json rather than recomputed, so the
// snapshot can never disagree with what the dashboard showed at the time.
async function snapshot(pool) {
  const metadata = await readJson(metadataFile, { markets: {} });
  const aso = await readJson(asoFile, { markets: {} });
  const out = {};
  for (const cc of markets) {
    const meta = metadata.markets?.[cc];
    const m = aso.markets?.[cc];
    const terms = m?.terms ?? {};
    const shots = await liveShots(cc);
    const key = shots ? shotKey(shots) : null;
    if (key) pool[key] ??= shots;
    out[cc] = {
      title: meta?.title ?? null,
      subtitle: meta?.subtitle ?? null,
      field: meta?.keywordField ?? null,
      fieldChars: (meta?.keywordField ?? "").length,
      fieldUpdated: meta?.fieldUpdated ?? null,
      // Which phrases the listing could rank for at all. The list rather than
      // the count, because the count going 66 → 66 while six phrases were
      // traded for six others is exactly the case worth catching.
      covered: Object.entries(terms)
        .filter(([, t]) => t.covered)
        .map(([kw]) => kw)
        .sort(),
      gradable: Object.values(terms).filter((t) => t.covered !== undefined).length,
      // Graded on title and subtitle alone, because no keyword field is on
      // record for this market. Its gaps may already be covered.
      partial: Boolean(m?.coverage?.partial),
      ...(key && { shots: key, shotsAt: new Date().toISOString() }),
    };
  }
  return out;
}

// --- rank effect -------------------------------------------------------------

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// Closes and day-spans for one phrase across a set of history rows. A row
// holds [close, pop, min, max, samples]; older rows may hold the legacy
// [rank, pop], which reads as a single sample with no span.
function series(rows, cc, kw) {
  const closes = [];
  const spans = [];
  for (const row of rows) {
    const v = row.markets?.[cc]?.[kw];
    if (!v || v[0] == null) continue;
    closes.push(v[0]);
    if (v[2] != null && v[3] != null) spans.push(v[3] - v[2]);
  }
  return { closes, span: median(spans) ?? 0 };
}

// true, false, or null for "cannot be known". Null is a real answer here and
// the panel prints it as such: the alternative is a confident "unchanged" on a
// release whose screenshots were never photographed before it shipped.
function shotsVerdict(entry, cc) {
  const b = entry.before?.[cc];
  const a = entry.after?.[cc];
  if (!b?.shots || !a?.shots) return null;
  if (!b.shotsAt || b.shotsAt > entry.at) return null;
  return b.shots !== a.shots;
}

function effectFor(entry, kwData, ratings) {
  const history = kwData?.history ?? [];
  const relDay = entry.at.slice(0, 10);
  // The release day itself belongs to neither window. A version that goes live
  // at 22:15 leaves a day that is mostly pre-release and partly not, and no
  // rule about which side to count it on survives the next release going live
  // at breakfast.
  const before = history.filter((r) => r.date < relDay).slice(-BASELINE_DAYS);
  const after = history.filter((r) => r.date > relDay);
  const days = Math.floor((Date.now() - new Date(entry.at)) / 864e5);

  const out = {
    computedAt: new Date().toISOString(),
    days,
    stage: stageOf(days),
    baselineDays: before.length,
    postDays: after.length,
    markets: {},
  };

  for (const cc of markets) {
    const beforeCov = new Set(entry.before?.[cc]?.covered ?? []);
    const afterCov = new Set(entry.after?.[cc]?.covered ?? []);
    const graded = Boolean(entry.after) && (beforeCov.size > 0 || afterCov.size > 0);
    const gained = [...afterCov].filter((k) => !beforeCov.has(k));
    const lost = [...beforeCov].filter((k) => !afterCov.has(k));

    const cohorts = { target: [], control: [], floor: [] };
    const appeared = [];
    const vanished = [];
    const noisy = [];
    const terms = new Set();
    for (const row of [...before, ...after])
      for (const kw of Object.keys(row.markets?.[cc] ?? {})) terms.add(kw);

    for (const kw of terms) {
      const b = series(before, cc, kw);
      const a = series(after, cc, kw);
      const pop = kwData?.latest?.[cc]?.[kw]?.pop ?? null;

      // A phrase that was not in the results at all and now is, or the
      // reverse. This is what a keyword field change actually looks like:
      // an indexed word does not walk a phrase up the list, it puts the
      // phrase on the list.
      // Once there is more than one day to judge by, an appearance has to hold
      // for more than one of them. A phrase that surfaces for a single run and
      // sinks again is Apple shuffling its tail, not a word being indexed.
      const holds = Math.min(2, Math.max(1, after.length));
      if (!b.closes.length && a.closes.length >= holds) {
        appeared.push({ kw, pop, rank: a.closes.at(-1) });
        continue;
      }
      if (!b.closes.length) continue;
      if (b.closes.length && !a.closes.length && after.length >= 2) {
        vanished.push({ kw, pop, was: median(b.closes) });
        continue;
      }
      if (b.closes.length < 2 || !a.closes.length) continue;

      const cohort = !graded
        ? "floor"
        : beforeCov.has(kw) !== afterCov.has(kw)
          ? "target"
          : afterCov.has(kw)
            ? "control"
            : "floor";
      // Lower rank is better, so the gain is how far the median came down.
      const gain = median(b.closes) - median(a.closes);
      const entryRow = {
        kw,
        pop,
        before: round1(median(b.closes)),
        after: round1(median(a.closes)),
        gain: round1(gain),
        cohort,
      };
      const drift = Math.max(...b.closes) - Math.min(...b.closes);
      if (b.span > NOISE_SPAN || drift > NOISE_SPAN) noisy.push(entryRow);
      else cohorts[cohort].push(entryRow);
    }

    const agg = (rows) => ({
      n: rows.length,
      gain: round1(median(rows.map((r) => r.gain))),
    });
    const target = agg(cohorts.target);
    const control = agg(cohorts.control);

    // The whole verdict in one number: what the changed phrases did, less what
    // the untouched ones did over the same days. Only meaningful when both
    // cohorts have members, which is why it is null rather than zero when a
    // market has no targets.
    const lift =
      target.gain != null && control.gain != null
        ? round1(target.gain - control.gain)
        : null;

    out.markets[cc] = {
      graded,
      coverage: {
        before: entry.before?.[cc]?.covered?.length ?? null,
        after: entry.after?.[cc]?.covered?.length ?? null,
        of: entry.after?.[cc]?.gradable ?? entry.before?.[cc]?.gradable ?? null,
        gained,
        lost,
        // Both sides have to have been graded the same way. A market whose
        // keyword field was not on record before the release was graded on
        // title and subtitle alone, so writing the field down at the same time
        // as shipping it makes coverage leap for reasons that have nothing to
        // do with the release. Everything downstream of coverage inherits the
        // problem: almost every phrase reads as "changed", which leaves the
        // cohort split with no control group and the lift with nothing to say.
        comparable: !entry.before?.[cc]?.partial && !entry.after?.[cc]?.partial,
      },
      fieldChanged: entry.before?.[cc]?.field !== entry.after?.[cc]?.field,
      subtitleChanged: entry.before?.[cc]?.subtitle !== entry.after?.[cc]?.subtitle,
      // Only answerable when the before side was read before the release went
      // live. Apple serves the current screenshots and only those, so a
      // baseline captured after the fact is the new set wearing the old set's
      // name, and reporting "unchanged" off it would be a lie rather than a
      // gap. Recording a release late costs this one line and nothing else.
      shotsChanged: shotsVerdict(entry, cc),
      target,
      control,
      floor: agg(cohorts.floor),
      lift,
      appeared: appeared.sort((x, y) => (y.pop ?? 0) - (x.pop ?? 0)).slice(0, 12),
      vanished: vanished.sort((x, y) => (y.pop ?? 0) - (x.pop ?? 0)).slice(0, 12),
      // Biggest movers regardless of cohort, for the case where something
      // moved that nobody was aiming at.
      movers: [...cohorts.target, ...cohorts.control, ...cohorts.floor]
        .filter((r) => Math.abs(r.gain) >= 2)
        .sort((x, y) => Math.abs(y.gain) - Math.abs(x.gain))
        .slice(0, 12),
      noisy: noisy.length,
      ratings: ratingsRate(ratings, cc, relDay),
    };
  }
  return out;
}

// Ratings per day either side of the release. Included because it is the only
// download proxy this repo has, and labelled everywhere it is shown, because
// at one or two ratings a day it cannot separate a good release from a quiet
// week for months. It answers "did anything fall off a cliff", nothing finer.
function ratingsRate(history, cc, relDay) {
  const rows = (history ?? [])
    .map((r) => ({ date: r.date, count: r.countries?.[cc]?.count }))
    .filter((r) => typeof r.count === "number")
    .sort((a, b) => a.date.localeCompare(b.date));
  const rate = (subset) => {
    if (subset.length < 2) return null;
    const span = (new Date(subset.at(-1).date) - new Date(subset[0].date)) / 864e5;
    return span > 0 ? round1((subset.at(-1).count - subset[0].count) / span) : null;
  };
  return {
    before: rate(rows.filter((r) => r.date <= relDay).slice(-(BASELINE_DAYS + 1))),
    after: rate(rows.filter((r) => r.date >= relDay)),
  };
}

// --- commands ----------------------------------------------------------------

async function record(version) {
  const log = await readJson(outFile, []);
  const open = log.find((r) => !r.after);
  if (open) {
    console.error(
      `${open.version} was recorded on ${open.recordedAt?.slice(0, 10)} and never sealed.\n` +
        `Run --seal first, or delete that entry from ${path.relative(repoRoot, outFile)}.`
    );
    process.exit(1);
  }
  const live = await liveVersion();
  const v = version ?? live?.version;
  if (!v) {
    console.error("could not read the live version; pass it: --record 4.13");
    process.exit(1);
  }
  // Recorded ahead of the release, which is the ordering this is built for,
  // leaves nothing to timestamp yet: the version is not on the store, so the
  // only date the lookup can offer belongs to the version being replaced.
  // --seal fills it in from the store, which is the authority on when a
  // version actually went live in any case.
  const at = live && v === live.version ? live.at : null;
  const pool = {};
  const before = await snapshot(pool);
  log.push({
    version: v,
    at,
    recordedAt: new Date().toISOString(),
    shots: pool,
    before,
    after: null,
    effect: null,
  });
  await write(log);
  const fields = Object.values(before).filter((m) => m.field).length;
  console.log(
    `recorded ${v}${at ? `, live ${at}` : " (not live yet; --seal will date it)"}\n` +
      `  baseline saved for ${markets.length} markets (${fields} with a keyword field on record)`
  );
  if (at && new Date(at) < new Date(Date.now() - 6e5)) {
    console.log(
      `  NOTE: ${v} was already live when this ran, so the screenshots saved as the\n` +
        `  "before" set are the ones it shipped with. Apple serves no others. This\n` +
        `  release will report its screenshot change as unknown rather than guess.`
    );
  }
  console.log(
    `  next: paste the shipped keyword fields into scripts/metadata.json, set fieldUpdated,\n` +
      `  then run: node scripts/aso.mjs --fetch && node scripts/release.mjs --seal`
  );
}

async function seal() {
  const log = await readJson(outFile, []);
  const entry = log.find((r) => !r.after);
  if (!entry) {
    console.error("nothing to seal: every recorded release already has an after side.");
    process.exit(1);
  }
  entry.shots ??= {};
  entry.after = await snapshot(entry.shots);
  entry.sealedAt = new Date().toISOString();
  // The store is the authority on when a version went live, and it is only
  // able to say so once the version is on it.
  if (!entry.at) {
    const live = await liveVersion();
    if (live?.version !== entry.version) {
      console.error(
        `the store is still serving ${live?.version ?? "an unreadable version"}, not ${entry.version}.\n` +
          `Seal once the release is live, or the before and after would describe the same listing.`
      );
      process.exit(1);
    }
    entry.at = live.at;
  }
  entry.effect = effectFor(entry, await readJson(kwFile, null), await readJson(ratingsFile, []));
  await write(log);
  const changed = markets.filter((cc) => entry.before[cc]?.field !== entry.after[cc]?.field);
  const shots = markets.filter((cc) => shotsVerdict(entry, cc) === true);
  const unknown = markets.filter((cc) => shotsVerdict(entry, cc) === null).length;
  console.log(
    `sealed ${entry.version}, live ${entry.at}\n` +
      `  keyword field changed in ${changed.length ? changed.join(", ") : "no market"}\n` +
      `  screenshots changed in ${shots.length ? shots.join(", ") : "no market"}` +
      (unknown ? ` (${unknown} market(s) had no screenshot baseline to compare against)` : "") +
      `\n  read it with: node scripts/release.mjs --report`
  );
}

async function effect() {
  const log = await readJson(outFile, []);
  const entry = [...log].reverse().find((r) => r.after);
  if (!entry) return console.log("release: nothing sealed yet, skipping.");
  entry.effect = effectFor(entry, await readJson(kwFile, null), await readJson(ratingsFile, []));
  await write(log);
  const e = entry.effect;
  console.log(
    `release ${entry.version}: day ${e.days} (${e.stage}), ` +
      `${e.baselineDays} baseline days against ${e.postDays} since`
  );
}

const write = (log) => writeFile(outFile, JSON.stringify(log, null, 1) + "\n");

const pad = (s, n) => String(s).padEnd(n);
const sign = (n) => (n == null ? "—" : n > 0 ? `+${n}` : String(n));

async function report(only) {
  const log = await readJson(outFile, []);
  const entry = [...log].reverse().find((r) => r.after) ?? log.at(-1);
  if (!entry) return console.log("no releases recorded. Run --record first.");
  if (!entry.after) return console.log(`${entry.version} recorded but not sealed. Run --seal.`);

  const kwData = await readJson(kwFile, null);
  const e = (entry.effect = effectFor(entry, kwData, await readJson(ratingsFile, [])));

  console.log(`\n${entry.version}, live ${entry.at.slice(0, 16).replace("T", " ")}Z`);
  console.log(
    `day ${e.days} — ${e.stage}: ` +
      {
        indexing: "Apple has not finished re-indexing, so rank here means nothing yet.",
        provisional: "early enough that a single noisy day can still swing this.",
        settled: "far enough out to read as a result.",
      }[e.stage]
  );
  console.log(`${e.baselineDays} baseline days against ${e.postDays} days since\n`);

  for (const cc of markets) {
    if (only && cc !== only) continue;
    const m = e.markets[cc];
    const b = entry.before[cc] ?? {};
    const a = entry.after[cc] ?? {};
    console.log(`=== ${cc.toUpperCase()} ${"=".repeat(56)}`);

    if (m.subtitleChanged) console.log(`  subtitle   "${b.subtitle ?? "none"}"\n         →   "${a.subtitle ?? "none"}"`);
    if (m.fieldChanged) {
      console.log(`  field      ${b.field ?? "NOT ON RECORD before this release"}`);
      console.log(`         →   ${a.field ?? "not recorded"}  (${a.fieldChars}/100)`);
    }
    if (!m.fieldChanged && !m.subtitleChanged) console.log("  wording    unchanged");
    console.log(
      `  shots      ${
        m.shotsChanged === null
          ? "unknown — no screenshot set was recorded before this release went live"
          : m.shotsChanged
            ? "changed"
            : "unchanged"
      }`
    );

    // Coverage first, and separately, because it is the only line on this page
    // that is arithmetic rather than a measurement: it is true the moment the
    // field ships and no amount of waiting makes it truer.
    if (!m.coverage.comparable) {
      console.log(
        `  coverage   ${m.coverage.before} → ${m.coverage.after} of ${m.coverage.of} phrases,` +
          ` NOT COMPARABLE\n` +
          `             the field was not on record before this release, so the before side was\n` +
          `             graded on title and subtitle alone. The jump is bookkeeping. The cohort\n` +
          `             split below has no real control group and the lift means nothing here.`
      );
    } else if (m.coverage.after != null) {
      console.log(
        `  coverage   ${m.coverage.before} → ${m.coverage.after} of ${m.coverage.of} phrases` +
          (a.partial ? "  (title and subtitle only, no field on record)" : "")
      );
      const pops = (list) =>
        list
          .map((k) => `${k}${kwData?.latest?.[cc]?.[k]?.pop ? ` (${kwData.latest[cc][k].pop})` : ""}`)
          .join(", ");
      if (m.coverage.gained.length) console.log(`  gained     ${pops(m.coverage.gained)}`);
      if (m.coverage.lost.length) console.log(`  LOST       ${pops(m.coverage.lost)}`);
    }

    if (m.appeared.length)
      console.log(`  appeared   ${m.appeared.map((r) => `${r.kw} → #${r.rank}`).join(", ")}`);
    if (m.vanished.length)
      console.log(`  vanished   ${m.vanished.map((r) => `${r.kw} (was #${r.was})`).join(", ")}`);

    if (e.postDays >= 1) {
      console.log(
        `\n  rank       ${pad("cohort", 10)} ${pad("phrases", 9)} median move\n` +
          `             ${pad("changed", 10)} ${pad(m.target.n, 9)} ${sign(m.target.gain)}\n` +
          `             ${pad("untouched", 10)} ${pad(m.control.n, 9)} ${sign(m.control.gain)}\n` +
          `             ${pad("uncovered", 10)} ${pad(m.floor.n, 9)} ${sign(m.floor.gain)}`
      );
      console.log(
        `  lift       ${sign(m.lift)}` +
          (m.lift == null
            ? "  (no changed phrases to compare)"
            : `  places the changed phrases gained beyond the untouched ones`)
      );
      if (m.noisy)
        console.log(
          `             ${m.noisy} phrase(s) held out: they already move more than ${NOISE_SPAN} places on their own`
        );
    }

    if (m.movers.length) {
      console.log("\n  Biggest moves:");
      for (const r of m.movers)
        console.log(
          `    ${pad(sign(r.gain), 6)} ${pad(r.kw, 30)} ${pad(`#${r.before} → #${r.after}`, 16)} ${pad(r.pop ?? "", 4)} ${r.cohort}`
        );
    }

    const rt = m.ratings;
    if (rt?.before != null || rt?.after != null)
      console.log(
        `\n  ratings    ${rt.before ?? "—"}/day before, ${rt.after ?? "—"}/day since` +
          `  (download proxy only, and far too thin to read a conversion change from)`
      );
    console.log("");
  }

  console.log(
    "Screenshots move conversion, and conversion is not in this repo. The only\n" +
      "verdict on them is App Store Connect: Analytics → Impressions, Product Page\n" +
      "Views and Conversion Rate by territory, 14 days before against 14 days after."
  );
}

// --- CLI ---------------------------------------------------------------------

const [mode, arg] = process.argv.slice(2);
if (mode === "--record") await record(arg);
else if (mode === "--seal") await seal();
else if (mode === "--report") await report(arg);
else if (mode === "--effect" || !mode) await effect();
else {
  console.error("usage: release.mjs [--record [version] | --seal | --effect | --report [cc]]");
  process.exit(1);
}
