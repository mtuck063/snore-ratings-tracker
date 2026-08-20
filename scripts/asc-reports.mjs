// App Store Connect analytics, pulled into the repo.
//
// The rank table says where the listing places. This says what happened next:
// impressions, the taps that were actually installs, downloads, deletions, and
// the ones who came back. The README's "Conversion, nowhere" section was true
// until this existed.
//
//   node asc-reports.mjs            ingest every daily instance not seen yet
//   node asc-reports.mjs --backfill run the one-time snapshot too (whole history)
//   node asc-reports.mjs --report   what the numbers say, on stdout
//
// Runs locally and by hand, never in CI: the App Store Connect keys live in
// ~/.config/appstoreconnect and are meant to stay on one machine, and a repo
// secret would put an Analytics-capable key in reach of every workflow. That
// also means it is deliberately absent from check-freshness.mjs — an irregular
// collector cannot be held to a schedule it was never given.
//
// FOUR THINGS THAT ARE EASY TO GET WRONG, all of them learned the hard way:
//
//  - A Tap is not an install. The Tap event carries an Engagement Type, and
//    only `Get` is acquisition; `Open` is an existing user launching the app
//    from the store page and accounted for 14,245 lifetime taps. Reading Tap
//    whole inflates tap-through by roughly half.
//  - An Install is usually not a new user. Install carries a Download Type,
//    and `Manual update` outnumbered `First-time download` 63,052 to 6,492 —
//    ten to one — because a weekly release cadence reinstalls the whole base
//    every week. Only First-time download is acquisition.
//  - Usage reports are sampled, commerce reports are not. Downloads are
//    complete; installs, deletions and sessions come from devices that opted
//    into sharing analytics. Two independent measurements put that at 0.285
//    (first-installs against known downloads) and 0.25-0.27 (day-zero session
//    devices against the same), so ~3.5x recovers real numbers. Never scale
//    downloads, and never scale a ratio whose halves are both sampled.
//  - Deletions need their cohort. A deletion's App Download Date is when that
//    user first arrived, so cohorts have to mature before they can be read —
//    30 days here. Reading a fresh cohort reports a retention miracle.
//
// The derived rates in --report follow from those: deletion and return rates
// divide one sampled number by another and so need no correction at all, which
// is why they are the most trustworthy figures in the file.
import { createPrivateKey, sign } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "docs", "data", "asc");
const stateFile = path.join(outDir, "index.json");
const configPath = path.join(os.homedir(), ".config", "appstoreconnect", "config.json");
const BASE = "https://api.appstoreconnect.apple.com";

// The two requests created against this app. ONGOING emits one small file per
// day; ONE_TIME_SNAPSHOT holds the history and is only read with --backfill.
const REQUESTS = {
  ongoing: "4024bc61-6095-4c05-9ee5-fa954c50a800",
  snapshot: "10e8bcf1-55fc-4df3-bd74-95f01f3f0953",
};
// Report ids are stable per request; the prefix identifies which report.
const REPORTS = {
  discovery: "r14",
  downloads: "r3",
  installs: "r6",
  sessions: "r8",
};
// Territories worth keeping a per-day row for. Everything else folds into ZZ,
// so a long tail of one-download countries cannot triple the file size. The
// list is the tracked markets plus the next tier by lifetime downloads.
const KEEP = new Set(
  "US GB CA AU FR DE JP CN KR BR NL ES MX IT SA SE CH TH RU TR PL DK NO NZ IN SG EE".split(" ")
);
const terr = (t) => (KEEP.has(t) ? t : "ZZ");

const b64url = (b) => Buffer.from(b).toString("base64url");

// The JWT needs three things: a key id, an issuer id, and the private key.
// Locally they come from ~/.config/appstoreconnect, which is where they are
// meant to live. A runner has no home directory to read, so the environment
// wins when it carries all three -- createPrivateKey takes PEM text directly,
// so the .p8 never has to be written to disk on a machine you do not own.
//
// Analytics was assumed to be Admin-gated. It is not, at least for these
// reports: the read-only reporting key returns 200 on the report requests,
// the instances and the segment downloads alike. That matters because it is
// the difference between a CI secret that can only read and one that could
// submit a build.
async function token() {
  const envKey = process.env.ASC_PRIVATE_KEY;
  let keyId, issuerId, pem;
  if (envKey && process.env.ASC_KEY_ID && process.env.ASC_ISSUER_ID) {
    keyId = process.env.ASC_KEY_ID;
    issuerId = process.env.ASC_ISSUER_ID;
    // A secret pasted through a shell can arrive with its newlines escaped,
    // and a PEM whose line breaks are the two characters \ and n will not
    // parse. Both forms have to work or the failure is a bad-key error that
    // says nothing about what is actually wrong.
    pem = envKey.includes("\\n") ? envKey.replace(/\\n/g, "\n") : envKey;
  } else {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const chosen = config.keys[process.env.ASC_KEY ?? "admin"];
    if (!chosen) throw new Error(`no key named "${process.env.ASC_KEY ?? "admin"}" in ${configPath}`);
    ({ keyId, issuerId } = chosen);
    pem = await readFile(chosen.keyPath, "utf8");
  }
  const key = createPrivateKey(pem);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const body = b64url(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })
  );
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64url(sig)}`;
}

async function api(pathOrUrl, jwt) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : BASE + pathOrUrl;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
  if (!res.ok) throw new Error(`${res.status} for ${url}\n${await res.text()}`);
  return res.json();
}

// A segment is a gzipped TSV behind a presigned S3 URL. Instances routinely
// carry more than one, and an instance whose segments are read partially looks
// exactly like a quiet day, so all of them are joined before parsing.
async function rowsOf(instanceId, jwt) {
  const segs = (await api(`/v1/analyticsReportInstances/${instanceId}/segments`, jwt)).data;
  const out = [];
  for (const s of segs) {
    const buf = Buffer.from(await (await fetch(s.attributes.url)).arrayBuffer());
    const text = gunzipSync(buf).toString("utf8");
    for (const line of text.trim().split("\n")) {
      // Every segment repeats the header; a concatenated file has several.
      if (!line || line.startsWith("Date\t")) continue;
      out.push(line.split("\t"));
    }
  }
  return out;
}

const readJson = async (f, fallback) => {
  try {
    return JSON.parse(await readFile(f, "utf8"));
  } catch {
    return fallback;
  }
};

// --- aggregation -------------------------------------------------------------
// One row per date x territory x source, carrying the whole funnel. Collapsing
// device and platform version is what keeps a month near 45KB; no decision this
// repo makes has ever turned on an iOS point release.
const bump = (o, k, field, n) => {
  (o[k] ??= { imp: 0, uimp: 0, get: 0, open: 0, pv: 0, dl: 0, redl: 0 })[field] += n;
};

function foldDiscovery(rows, acc) {
  for (const r of rows) {
    const [date, , , event, page, source, engagement, , , territory, counts, unique] = r;
    const k = `${date}|${terr(territory)}|${source}`;
    const n = Number(counts) || 0;
    if (event === "Impression") {
      bump(acc, k, "imp", n);
      bump(acc, k, "uimp", Number(unique) || 0);
    } else if (event === "Page view" && page === "Product page") bump(acc, k, "pv", n);
    else if (event === "Tap" && engagement === "Get") bump(acc, k, "get", n);
    else if (event === "Tap" && engagement === "Open") bump(acc, k, "open", n);
  }
}

function foldDownloads(rows, acc) {
  for (const r of rows) {
    const [date, , , type, , , , source, , , territory, counts] = r;
    const n = Number(counts) || 0;
    const k = `${date}|${terr(territory)}|${source}`;
    if (type === "First-time download") bump(acc, k, "dl", n);
    else if (type === "Redownload") bump(acc, k, "redl", n);
  }
}

// Installs and deletions are kept by cohort rather than by event date: the
// question they answer is "of the people who arrived on day D, how many left",
// and that is unanswerable from an event-date total.
//
// Keyed cohort|eventDate rather than cohort alone, which costs some rows and
// buys idempotency: the snapshot and the ongoing files overlap by several days,
// and a cohort total that summed both counted those days twice. Writing by key
// means re-ingesting a day restates it instead of adding to it. --report sums
// the event dates back up.
function foldInstalls(rows, cohorts) {
  for (const r of rows) {
    const [date, , , event, type, , , , , , cohort, territory, counts] = r;
    const c = cohort || "";
    if (!c) continue; // download date outside Apple's window; unattributable
    const n = Number(counts) || 0;
    const row = (cohorts[`${c}|${date}`] ??= { first: 0, del: 0, redl: 0, restore: 0, auto: 0 });
    if (event === "Delete") row.del += n;
    else if (type === "First-time download") row.first += n;
    else if (type === "Redownload") row.redl += n;
    else if (type === "Restore") row.restore += n;
    else if (type === "Auto-download") row.auto += n;
  }
}

function foldSessions(rows, acc) {
  for (const r of rows) {
    const [date, , , , , , , , , territory, sessions, duration, devices] = r;
    const k = `${date}|${terr(territory)}`;
    const row = (acc[k] ??= { sessions: 0, seconds: 0, devices: 0 });
    row.sessions += Number(sessions) || 0;
    row.seconds += Number(duration) || 0;
    row.devices += Number(devices) || 0;
  }
}

// --- ingest ------------------------------------------------------------------
async function ingest({ backfill = false } = {}) {
  await mkdir(outDir, { recursive: true });
  const jwt = await token();
  const state = await readJson(stateFile, { seen: [], months: [], cohortsThrough: null });
  const seen = new Set(state.seen);

  // Discovery and downloads are kept apart even though they share a key: they
  // restate on different schedules, and merging them into one record meant a
  // downloads-only restatement wrote imp:0 over a day whose impressions were
  // fine — which is exactly how 9 and 10 August lost their download counts and
  // 12 August lost its impressions.
  const disc = {}; // date|territory|source -> impression/tap/page-view counts
  const dl = {}; //   date|territory|source -> download counts
  const sessions = {}; // date|territory -> session counts
  const cohorts = {}; // download date|event date -> install/delete/return counts
  const claimedDates = {}; // per report: event dates a newer file already gave us
  let ingested = 0;

  const sources = backfill ? ["snapshot", "ongoing"] : ["ongoing"];
  for (const which of sources) {
    for (const [name, rid] of Object.entries(REPORTS)) {
      const id = `${rid}-${REQUESTS[which]}`;
      let list;
      try {
        list = (await api(`/v1/analyticsReports/${id}/instances?limit=200`, jwt)).data;
      } catch (err) {
        console.error(`${which}/${name}: ${err.message.split("\n")[0]}`);
        continue;
      }
      // Newest instance first. The snapshot and the ongoing files overlap by
      // several event dates, and Apple restates recent days as they mature, so
      // whichever file was produced last is the authority: a date already taken
      // in this run is dropped from anything older rather than added to it.
      const daily = list
        .filter((i) => i.attributes.granularity === "DAILY")
        .sort((a, b) => (a.attributes.processingDate < b.attributes.processingDate ? 1 : -1));
      const claimed = claimedDates[name] ??= new Set();
      for (const inst of daily) {
        if (seen.has(inst.id)) continue;
        const all = await rowsOf(inst.id, jwt);
        const rows = all.filter((r) => !claimed.has(r[0]));
        for (const r of all) claimed.add(r[0]);
        if (name === "discovery") foldDiscovery(rows, disc);
        else if (name === "downloads") foldDownloads(rows, dl);
        else if (name === "installs") foldInstalls(rows, cohorts);
        else if (name === "sessions") foldSessions(rows, sessions);
        seen.add(inst.id);
        ingested++;
        const dropped = all.length - rows.length;
        console.log(
          `  ${which}/${name} ${inst.attributes.processingDate} — ${rows.length} rows` +
            (dropped ? ` (${dropped} already covered by a newer file)` : "")
        );
      }
    }
  }

  if (!ingested) {
    console.log("nothing new; every daily instance is already ingested");
    return;
  }

  // Merge into monthly shards. Apple restates recent days as data matures, so
  // a day already on disk is overwritten rather than added to — appending would
  // double-count every restatement.
  const months = new Set(state.months);
  const touched = new Set([
    ...Object.keys(disc).map((k) => k.slice(0, 7)),
    ...Object.keys(dl).map((k) => k.slice(0, 7)),
    ...Object.keys(sessions).map((k) => k.slice(0, 7)),
  ]);
  for (const month of touched) {
    const file = path.join(outDir, `${month}.json`);
    const shard = await readJson(file, { disc: {}, dl: {}, sessions: {} });
    shard.disc ??= {};
    shard.dl ??= {};
    shard.sessions ??= {};
    // Each family overwrites only its own keys, so a restatement of one report
    // cannot blank the other.
    for (const [k, v] of Object.entries(disc)) if (k.startsWith(month)) shard.disc[k] = v;
    for (const [k, v] of Object.entries(dl)) if (k.startsWith(month)) shard.dl[k] = v;
    for (const [k, v] of Object.entries(sessions)) if (k.startsWith(month)) shard.sessions[k] = v;
    delete shard.funnel; // pre-split layout
    await writeFile(file, JSON.stringify(shard) + "\n");
    months.add(month);
  }

  if (Object.keys(cohorts).length) {
    const file = path.join(outDir, "cohorts.json");
    const prev = await readJson(file, {});
    for (const [c, v] of Object.entries(cohorts)) prev[c] = v;
    await writeFile(file, JSON.stringify(prev, null, 0) + "\n");
    state.cohortsThrough = Object.keys(prev).sort().pop();
  }

  state.seen = [...seen];
  state.months = [...months].sort();
  state.at = new Date().toISOString();
  await writeFile(stateFile, JSON.stringify(state, null, 1) + "\n");
  console.log(`ingested ${ingested} instance(s) across ${state.months.length} month(s)`);
}

// --- report ------------------------------------------------------------------
const MATURE_DAYS = 30;

async function report() {
  const state = await readJson(stateFile, null);
  if (!state) return console.log("no data yet; run: node scripts/asc-reports.mjs --backfill");
  const funnel = {};
  const sessions = {};
  const put = (k, v) => {
    const row = (funnel[k] ??= { imp: 0, uimp: 0, get: 0, open: 0, pv: 0, dl: 0, redl: 0 });
    for (const f of Object.keys(row)) row[f] += v[f] ?? 0;
  };
  for (const f of (await readdir(outDir)).filter((f) => /^\d{4}-\d{2}\.json$/.test(f))) {
    const shard = await readJson(path.join(outDir, f), {});
    for (const [k, v] of Object.entries(shard.disc ?? {})) put(k, v);
    for (const [k, v] of Object.entries(shard.dl ?? {})) put(k, v);
    Object.assign(sessions, shard.sessions ?? {});
  }
  const cohorts = await readJson(path.join(outDir, "cohorts.json"), {});

  // Sampling rate: first-time installs are sampled, downloads are not, so their
  // ratio over matured cohorts is the multiplier the usage reports need.
  const cutoff = new Date(Date.now() - MATURE_DAYS * 864e5).toISOString().slice(0, 10);
  const dlByDay = {};
  for (const [k, v] of Object.entries(funnel)) {
    const day = k.slice(0, 10);
    dlByDay[day] = (dlByDay[day] || 0) + v.dl;
  }
  let D = 0, I = 0, X = 0, R = 0;
  // Rows are cohort|eventDate; sum the event dates back into their cohort.
  const byCohort = {};
  for (const [k, v] of Object.entries(cohorts)) {
    const c = k.split("|")[0];
    const row = (byCohort[c] ??= { first: 0, del: 0, redl: 0 });
    row.first += v.first;
    row.del += v.del;
    row.redl += v.redl;
  }
  for (const [c, v] of Object.entries(byCohort)) {
    if (c >= cutoff || !dlByDay[c]) continue;
    D += dlByDay[c];
    I += v.first;
    X += v.del;
    R += v.redl;
  }
  const sampling = I && D ? I / D : null;

  const last = (n) => {
    const days = [...new Set(Object.keys(funnel).map((k) => k.slice(0, 10)))].sort().slice(-n);
    const t = { imp: 0, get: 0, pv: 0, dl: 0 };
    for (const [k, v] of Object.entries(funnel)) {
      if (!days.includes(k.slice(0, 10))) continue;
      for (const f of Object.keys(t)) t[f] += v[f];
    }
    return { days: days.length, ...t };
  };
  const w = last(7);
  console.log(`\n=== last ${w.days} days ===`);
  console.log(`  impressions      ${w.imp.toLocaleString()}`);
  console.log(`  gets             ${w.get.toLocaleString()}   (${((100 * w.get) / (w.imp || 1)).toFixed(1)}% of impressions)`);
  console.log(`  product page views ${w.pv.toLocaleString()}`);
  console.log(`  first downloads  ${w.dl.toLocaleString()}   (${(w.dl / (w.days || 1)).toFixed(0)}/day)`);

  console.log(`\n=== retention, cohorts older than ${MATURE_DAYS} days ===`);
  if (!I) {
    console.log("  no matured cohorts yet");
  } else {
    console.log(`  downloads ${D.toLocaleString()} · sampled first-installs ${I.toLocaleString()}`);
    console.log(`  sampling rate    ${sampling.toFixed(3)}   (scale usage reports by ${(1 / sampling).toFixed(1)}x)`);
    console.log(`  deletion rate    ${((100 * X) / I).toFixed(1)}%   ${X.toLocaleString()} of ${I.toLocaleString()}`);
    console.log(`  return rate      ${((100 * R) / (X || 1)).toFixed(1)}%   ${R.toLocaleString()} redownloaded after deleting`);
    console.log(`  net churn        ${((100 * (X - R)) / I).toFixed(1)}%   deleted and stayed gone`);
  }

  const sdays = [...new Set(Object.keys(sessions).map((k) => k.slice(0, 10)))].sort().slice(-7);
  let ss = 0, sec = 0;
  for (const [k, v] of Object.entries(sessions)) {
    if (!sdays.includes(k.slice(0, 10))) continue;
    ss += v.sessions;
    sec += v.seconds;
  }
  if (ss) {
    console.log(`\n=== usage, last ${sdays.length} days (sampled) ===`);
    console.log(`  sessions         ${ss.toLocaleString()}  →  ~${Math.round(ss / (sampling || 0.285)).toLocaleString()} real`);
    console.log(`  avg session      ${(sec / ss / 60).toFixed(1)} min`);
  }
}

// A repo with no App Store Connect secrets set -- a fork, or this one before
// they were added -- must not fail the workflow it rides in. Checked here
// rather than in the step's `if`, because the `secrets` context is not
// readable from one and referencing it makes the whole file unparseable.
async function haveCredentials() {
  if (process.env.ASC_KEY_ID && process.env.ASC_ISSUER_ID && process.env.ASC_PRIVATE_KEY) return true;
  try {
    await readFile(configPath, "utf8");
    return true;
  } catch {
    return false;
  }
}

const mode = process.argv[2];
if (!(await haveCredentials())) {
  console.log("no App Store Connect credentials (ASC_KEY_ID/ASC_ISSUER_ID/ASC_PRIVATE_KEY or ~/.config/appstoreconnect); skipping");
  process.exit(0);
}
if (mode === "--report") await report();
else await ingest({ backfill: mode === "--backfill" });
