#!/usr/bin/env node
// Apple's own keyword popularity index, per market.
//
// The rank collector already scores popularity by prefix-probing autocomplete
// (see popScore in keywords.mjs). That number is ordinal and uncalibrated: it
// says "more searched than yesterday", never "how much". Apple publishes the
// real index, 5-100, inside Apple Ads. It is the number every ASO tool quotes
// and the one that actually predicts traffic.
//
// It is not in any documented API. The Campaign Management API v5 manages
// campaigns and pulls reports; it has no popularity endpoint. The number comes
// from the private endpoint behind the Apple Ads web UI, which authenticates
// with a browser session cookie rather than a token:
//
//   POST app-ads.apple.com/cm/api/v2/keywords/popularities?adamId=<appId>
//   { "storefronts": [...], "terms": [...] }  ->  [{ name, popularity }]
//
// That cookie is the only credential in this repo other than the optional
// GoatCounter token, and unlike every other source here it is neither public
// nor unauthenticated. Consequences worth knowing before you rely on it:
//
//  - It expires fast. The itctx token inside the cookie carries an explicit
//    expiry and the one measured here allowed four hours and two minutes. That
//    is why this runs by hand and not from the keywords workflow: a repo secret
//    would be stale before nearly every six-hourly run, and nothing renews it.
//    A dead cookie carries values forward rather than blanking them.
//  - The endpoint is undocumented, so Apple may change or withdraw it without
//    notice. Nothing else in the dashboard depends on this file.
//  - Storefronts are honoured, and want two-letter country codes rather than
//    the numeric ids the rest of this repo uses. All eleven markets return
//    their own figures: "sleep tracker" measured 62 in the US, 54 in GB, 49 in
//    CA and 41 in DE on 2026-08-04. `--probe` re-checks this on demand.
//  - Coverage of THIS app's vocabulary is poor, and that is the catch. Apple
//    answers properly for adjacent sleep terms and for the Japanese snoring
//    words, but returns the floor of 5 for nearly every English snoring
//    phrase: "snore", "snoring", "snore recorder", "sleep apnea" and "cpap"
//    all sit at 5 in the same request where "sleep tracker" is 62 and
//    "snore lab" is 50. First measurement was 4/82 terms above the floor in
//    the US, 4/75 in GB, 1/39 in DE and 5/58 in JP. No cause established: it
//    is not the account (brand-new accounts return 100 for "instagram"), not
//    the app link (an unowned adamId is rejected outright), and not casing,
//    batching or match type. Floor values are counted, never stored.
//
// Setup, cookie capture and rotation are in the README, under "Apple's own
// popularity index".
//
//   node popularity.mjs             fetch stale markets -> docs/data/popularity.json
//   node popularity.mjs --force     ignore the freshness gate, fetch anyway
//   node popularity.mjs --probe     do non-US storefronts return distinct data?
//   node popularity.mjs --check     is ASA_COOKIE alive? one cheap call
//   node popularity.mjs --report    compare Apple's index against our popScore
//
// Credential: ASA_COOKIE, the Cookie header from a signed-in Apple Ads session.
// Never exits non-zero except on --check, which is meant to be asserted on.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(repoRoot, "scripts", "keywords.json");
const kwDataFile = path.join(repoRoot, "docs", "data", "keywords.json");
const outFile = path.join(repoRoot, "docs", "data", "popularity.json");

const POPULARITY_URL = "https://app-ads.apple.com/cm/api/v2/keywords/popularities";
// Apple's own cap, lifted from the CLI that talks to this endpoint. Every
// market's list currently fits in one call; auto-discovery keeps adding
// keywords, so chunk anyway rather than discover the limit in production.
const MAX_TERMS_PER_CALL = 100;
// Popularity is a slow-moving index and this is an undocumented endpoint
// reached with a session cookie, so a market already read today is not read
// again. Matters less now that nothing runs this on a schedule, but it keeps
// an afternoon of repeated hand-runs down to one pass. `--force` overrides.
const MIN_REFETCH_HOURS = 20;
const BACKOFFS_MS = [15000, 45000, 90000];
// Apple hands the browser a 403 with this code when the Apple Ads org has no
// linked App Store Connect account. It is the "your setup is incomplete"
// signal, not a rate limit, so it is worth naming in the log rather than
// retrying into silence.
const NO_LINKED_ACCOUNT = "KWS_NO_ORG_CONTENT_PROVIDERS";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1.1 Safari/605.1.15";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

const config = JSON.parse(await readFile(configFile, "utf8"));
const { appId, markets } = config;
const kwFor = (cc) =>
  markets[cc].keywords ?? [...new Set([...config.keywords, ...(markets[cc].extraKeywords ?? [])])];
// This endpoint wants two-letter country codes, not the numeric storefront ids
// the rest of this repo passes around: 143441 comes back as
// "Invalid storefront name:143441". The `storefront` field in keywords.json is
// for the hints endpoint and is no use here, so the market key is the source.
const storefrontOf = (cc) => cc.toUpperCase();

const cookie = process.env.ASA_COOKIE?.trim();
// A Cookie request header is name=value pairs and nothing else: the expiry
// Apple set lives in the Set-Cookie that created it and is gone by the time
// anyone copies this out of a browser. So the session's remaining life is not
// merely unknown, it is unknowable from what we hold, and the only honest way
// to answer "how long do these last" is to watch one die.
//
// Identify each cookie by a short digest so consecutive runs can tell "still
// the same session" from "someone rotated it", and record how long each one
// survived. After two rotations this repo knows the real number for this
// account, which is better than any figure anyone could have quoted upfront.
// A digest, never the value: this file is committed and served publicly.
const sessionHash = cookie ? createHash("sha256").update(cookie).digest("hex").slice(0, 12) : null;

// --- the one call ------------------------------------------------------------

// Resolves to { pops: {term: number|null} } or { error, kind } — never throws,
// so a dead cookie degrades one market rather than the run.
//
// `kind` separates the three ways this can fail, because they want three
// different human responses: "absent" is a repo nobody has set the secret on
// and must stay silent, "session" is a cookie that needs rotating by hand and
// must be loud, "transient" is Apple having a bad minute and needs neither.
async function fetchPopularities(terms, storefronts, attempt = 1) {
  if (!cookie) return { error: "ASA_COOKIE is not set", kind: "absent" };
  try {
    const res = await fetch(`${POPULARITY_URL}?adamId=${encodeURIComponent(appId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: "https://app-ads.apple.com",
        Referer: "https://app-ads.apple.com/cm/app",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ storefronts, terms }),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      const code = body?.error?.errors?.[0]?.messageCode;
      if (code === NO_LINKED_ACCOUNT) {
        return {
          error:
            `${NO_LINKED_ACCOUNT}: the Apple Ads org has no linked App Store ` +
            `Connect account. Link it in Apple Ads > Settings > Link Accounts.`,
          kind: "session",
        };
      }
      // 401/403 without that code is the cookie, not the setup. Retrying a
      // dead session just burns three backoffs, so give up immediately and
      // let the caller carry values forward.
      if (res.status === 401 || res.status === 403) {
        return {
          error: `HTTP ${res.status}: session rejected, ASA_COOKIE is stale`,
          kind: "session",
        };
      }
      // A 400 is us, not Apple. Retrying a malformed request three times with
      // growing backoff costs two and a half minutes to arrive at the same
      // rejection, which is how a wrong storefront format once turned an
      // eleven-market run into a timeout.
      if (res.status === 400) {
        const detail = body?.error?.errors?.[0]?.message ?? "Client Error";
        return { error: `HTTP 400: ${detail}`, kind: "input" };
      }
      throw new Error(`HTTP ${res.status}${code ? ` (${code})` : ""}`);
    }

    const pops = {};
    for (const item of body?.data ?? []) {
      if (item?.name != null) pops[item.name] = item.popularity ?? null;
    }
    return { pops };
  } catch (err) {
    if (attempt <= BACKOFFS_MS.length) {
      await sleep(BACKOFFS_MS[attempt - 1]);
      return fetchPopularities(terms, storefronts, attempt + 1);
    }
    return { error: err.message, kind: "transient" };
  }
}

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// Apple's floor. The index runs 5-100 and 5 is returned both for "nobody
// searches this" and, in practice, for most of this app's actual vocabulary
// (see FLOOR_COVERAGE below). Either way it is not a measurement, and storing
// it as one would put a number on the dashboard that means nothing.
const FLOOR = 5;

// English phrases asked of every storefront purely so the markets can be
// compared with each other. Seven of the eleven markets track localized
// keyword lists that share no term with the US list, and without a common
// yardstick there is no way to notice Apple handing them all the same answer.
// They ride along inside the existing call and are never stored: three extra
// terms on an 82-term list stays well inside the 100 cap and costs no request.
//
// Deliberately NOT snoring terms, which all sit on the floor in English and so
// compare equal everywhere, which would read as every market mirroring every
// other. These three return real, market-varying numbers: 62/54/41 across US,
// GB and DE on the day this was written.
const CONTROL_TERMS = ["sleep tracker", "sleep cycle", "alarm clock"];

// One market, however many calls its keyword list needs. Resolves to
// { pops, control } — pops is what this market tracks, control is the shared
// yardstick, and the two overlap for the English markets.
async function fetchMarket(cc) {
  const tracked = kwFor(cc);
  const asked = [...new Set([...tracked, ...CONTROL_TERMS])];
  const merged = {};
  for (const batch of chunk(asked, MAX_TERMS_PER_CALL)) {
    const result = await fetchPopularities(batch, [storefrontOf(cc)]);
    if (result.error) return { error: result.error, kind: result.kind };
    Object.assign(merged, result.pops);
  }
  const trackedSet = new Set(tracked);
  return {
    pops: Object.fromEntries(Object.entries(merged).filter(([t]) => trackedSet.has(t))),
    control: Object.fromEntries(CONTROL_TERMS.map((t) => [t, merged[t] ?? null])),
  };
}

// --- modes -------------------------------------------------------------------

// Does the storefront field do anything? Same three terms, every market. If
// every storefront answers with identical numbers the field is decorative and
// this file is a US-only artifact; if they diverge, all eleven markets are real.
async function probe() {
  if (!cookie) {
    console.error("ASA_COOKIE is not set. See “Apple’s own popularity index” in the README.");
    process.exit(1);
  }
  // English terms on purpose: a localized phrase scoring 5 in Japan proves
  // nothing, because it might simply be unsearched there. Terms that exist in
  // every market make identical-vs-different the only variable.
  const terms = ["snore", "sleep tracker", "snoring app"];
  const rows = [];

  // The empty list is what the Apple Ads UI itself sends. Whatever it means
  // (the org's default storefront, most likely) it is the baseline every
  // explicit storefront gets compared against.
  const baseline = await fetchPopularities(terms, []);
  if (baseline.error) {
    console.error(`baseline call failed: ${baseline.error}`);
    process.exit(1);
  }
  rows.push(["(empty)", baseline.pops]);

  for (const cc of Object.keys(markets)) {
    const result = await fetchPopularities(terms, [storefrontOf(cc)]);
    rows.push([`${cc} ${storefrontOf(cc)}`, result.error ? result.error : result.pops]);
  }

  const width = Math.max(...rows.map(([label]) => label.length));
  console.log(`${"storefront".padEnd(width)}  ${terms.map((t) => t.padStart(14)).join("")}`);
  for (const [label, pops] of rows) {
    if (typeof pops === "string") {
      console.log(`${label.padEnd(width)}  ${pops}`);
      continue;
    }
    console.log(
      `${label.padEnd(width)}  ${terms.map((t) => String(pops[t] ?? "-").padStart(14)).join("")}`
    );
  }

  const signatures = new Set(
    rows.filter(([, p]) => typeof p !== "string").map(([, p]) => JSON.stringify(p))
  );
  console.log();
  console.log(
    signatures.size <= 1
      ? "VERDICT: every storefront returned the same numbers. The field is ignored;\n" +
          "treat this data as US-only and keep popScore as the multi-market signal."
      : `VERDICT: ${signatures.size} distinct responses. Storefronts are honoured;\n` +
          "all markets carry real per-market popularity."
  );
}

// Cheapest possible liveness test, for the human who just captured a cookie
// and wants to know it took before spending eleven calls on it.
async function check() {
  const result = await fetchPopularities(["snore"], []);
  if (result.error) {
    console.error(`ASA_COOKIE is not usable: ${result.error}`);
    process.exit(1);
  }
  console.log(`ASA_COOKIE is live (snore -> ${result.pops["snore"] ?? "null"})`);

  const stored = await readJson(outFile, {});
  if (stored.session?.hash === sessionHash) {
    const days = (Date.now() - new Date(stored.session.firstOk)) / 86_400_000;
    console.log(`this session has been working for ${days.toFixed(1)} days`);
  } else if (stored.session) {
    console.log("this is a different cookie from the one on record; first run will adopt it");
  }

  const past = stored.sessionHistory ?? [];
  if (past.length) {
    const lives = past.map((s) => s.daysAlive);
    console.log(
      `previous sessions lasted ${lives.map((d) => `${d}d`).join(", ")} ` +
        `(median ${[...lives].sort((a, b) => a - b)[Math.floor(lives.length / 2)]}d)`
    );
  }
}

// Apple's index against ours, for the markets we have both for. The point is
// not to grade popScore but to find out whether it can be trusted in the ten
// markets Apple may never answer for.
async function report() {
  const stored = await readJson(outFile, { markets: {} });
  const kwData = await readJson(kwDataFile, { latest: {} });

  for (const [cc, market] of Object.entries(stored.markets ?? {})) {
    const ours = kwData.latest?.[cc] ?? {};
    const pairs = Object.entries(market.terms ?? {})
      .filter(([term, entry]) => entry?.pop != null && ours[term]?.pop != null)
      .map(([term, entry]) => [term, entry.pop, ours[term].pop]);
    if (!pairs.length) continue;

    // Spearman: both numbers are ordinal, so agreement on ordering is the
    // only claim worth testing. Pearson on a 5-100 index against a formula
    // that hard-codes 5 and 100 as its endpoints would flatter both.
    //
    // Ties are averaged, and the correlation is computed on the ranks rather
    // than by the usual 1 - 6d²/(n(n²-1)) shortcut, because that shortcut is
    // only valid when nothing ties and here almost everything does: Apple
    // parks its long tail on the floor, and popScore returns a flat 5 for
    // every term autocomplete never surfaces. Fed those, the shortcut reports
    // a correlation the data does not support.
    const rank = (values) => {
      const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
      const ranks = new Array(values.length);
      for (let i = 0; i < order.length; ) {
        let j = i;
        while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
        const shared = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) ranks[order[k][1]] = shared;
        i = j + 1;
      }
      return ranks;
    };
    const correlate = (a, b) => {
      const n = a.length;
      const meanA = a.reduce((s, v) => s + v, 0) / n;
      const meanB = b.reduce((s, v) => s + v, 0) / n;
      let num = 0;
      let devA = 0;
      let devB = 0;
      for (let i = 0; i < n; i++) {
        const x = a[i] - meanA;
        const y = b[i] - meanB;
        num += x * y;
        devA += x * x;
        devB += y * y;
      }
      // Zero variance means one side scored every term identically, which is
      // not a correlation of zero, it is no answer at all.
      return devA && devB ? num / Math.sqrt(devA * devB) : NaN;
    };

    const n = pairs.length;
    const rho = n > 1 ? correlate(rank(pairs.map((p) => p[1])), rank(pairs.map((p) => p[2]))) : NaN;

    console.log(`\n${cc.toUpperCase()}  ${n} terms with both scores   rho=${rho.toFixed(3)}`);
    const worst = pairs
      .map(([term, apple, our]) => [term, apple, our, Math.abs(apple - our)])
      .sort((a, b) => b[3] - a[3])
      .slice(0, 8);
    console.log(`  ${"term".padEnd(28)}${"apple".padStart(7)}${"ours".padStart(7)}${"gap".padStart(7)}`);
    for (const [term, apple, our, gap] of worst) {
      console.log(`  ${term.slice(0, 27).padEnd(28)}${String(apple).padStart(7)}${String(our).padStart(7)}${String(gap).padStart(7)}`);
    }
  }
}

// --- collect -----------------------------------------------------------------

async function collect({ force }) {
  const stored = await readJson(outFile, { markets: {} });
  const now = new Date();
  const nowIso = now.toISOString();
  const out = {
    fetchedAt: nowIso,
    source: "apple-ads",
    session: stored.session ?? null,
    sessionHistory: stored.sessionHistory ?? [],
    markets: {},
  };
  let failures = 0;
  let fetched = 0;
  let gated = 0;
  const kinds = new Set();
  // Raw values per market this run, kept only to answer "did the storefront
  // field actually do anything" below. Not written anywhere.
  const rawByMarket = new Map();

  for (const cc of Object.keys(markets)) {
    const previous = stored.markets?.[cc] ?? { fetchedAt: null, terms: {} };

    const ageHours = previous.fetchedAt
      ? (now - new Date(previous.fetchedAt)) / 3_600_000
      : Infinity;
    if (!force && ageHours < MIN_REFETCH_HOURS) {
      out.markets[cc] = previous;
      gated++;
      continue;
    }

    const result = await fetchMarket(cc);
    if (result.error) {
      // Carry forward, exactly as a failed rank fetch does. A market that has
      // never succeeded stays absent rather than appearing with null scores:
      // an empty stub on the dashboard reads as "Apple says nothing is
      // searched here", which is a different and much worse claim than "we
      // have not asked yet".
      console.warn(`${cc}: ${result.error}, carrying previous popularity`);
      if (previous.fetchedAt) out.markets[cc] = previous;
      kinds.add(result.kind);
      failures++;
      continue;
    }

    const terms = {};
    let atFloor = 0;
    for (const [term, pop] of Object.entries(result.pops)) {
      const before = previous.terms?.[term];
      if (pop == null) {
        // Apple returns null for terms it has no index for. That is a real
        // answer, but it is not a reason to forget a number we already had.
        if (before) terms[term] = before;
        continue;
      }
      if (pop <= FLOOR) {
        // Not stored. Apple says 5 for most of this app's vocabulary in
        // English while answering properly for adjacent terms, so a 5 here
        // cannot be read as "hardly anyone searches this". Writing it would
        // fill the file with a number that survives into charts and averages
        // and means nothing. Counted instead, so the gap stays visible.
        atFloor++;
        if (before) terms[term] = before;
        continue;
      }
      terms[term] =
        before && before.pop === pop
          ? before
          : { pop, ...(before?.pop != null && { prev: before.pop }), changedAt: nowIso };
    }

    // measured vs asked is the honesty of this market in one pair of numbers.
    out.markets[cc] = {
      fetchedAt: nowIso,
      asked: Object.keys(result.pops).length,
      measured: Object.keys(result.pops).length - atFloor,
      terms,
    };
    rawByMarket.set(cc, result.control);
    fetched++;

    // A call came back, so this cookie is alive right now. Either it is the
    // one we were already watching, or it is a replacement and the one before
    // it has just had its lifetime settled.
    if (out.session?.hash === sessionHash) {
      out.session = { ...out.session, lastOk: nowIso };
    } else {
      if (out.session) {
        const lived =
          (new Date(out.session.lastOk) - new Date(out.session.firstOk)) / 86_400_000;
        out.sessionHistory = [
          ...out.sessionHistory,
          { ...out.session, retiredAt: nowIso, daysAlive: Number(lived.toFixed(1)) },
        ].slice(-12);
      }
      out.session = { hash: sessionHash, firstOk: nowIso, lastOk: nowIso };
    }
  }

  // Did the storefront field do anything, or did Apple hand every market the
  // same answer? This has to be checked on real data every run, not settled
  // once by --probe, because the failure is silent and expensive: eleven
  // markets of identical numbers presented per-market is a dashboard telling
  // you Mexico and Japan search exactly like the United States. That is a
  // worse outcome than collecting nothing, so mirrored markets are labelled
  // in the file rather than passed off as their own data.
  //
  // Exact equality on the control terms is the test. Two storefronts genuinely
  // agreeing to the digit on a 5-100 index, for every control phrase, does not
  // happen: search volume is not the same in Mexico City and Manchester.
  const [reference, ...others] = [...rawByMarket.keys()];
  const mirrored = [];
  for (const cc of others) {
    const a = rawByMarket.get(reference);
    const b = rawByMarket.get(cc);
    const shared = CONTROL_TERMS.filter((t) => a[t] != null && b[t] != null);
    // Apple answered null for the controls in one of the two, so there is
    // nothing to compare and no conclusion to draw either way.
    if (!shared.length) continue;
    if (shared.every((t) => a[t] === b[t])) {
      mirrored.push(cc);
      out.markets[cc].mirrors = reference;
    }
  }
  if (mirrored.length) {
    console.warn(
      `popularity: ${mirrored.join(", ")} returned values identical to ${reference} ` +
        `on every shared term. Apple is ignoring the storefront field; these are ` +
        `not per-market figures and are labelled "mirrors" in the data file.`
    );
  }

  // Before the cookie exists there is nothing to say, and a file of empty
  // markets would be committed on every run and read as real data by anything
  // that later loads it. Say nothing instead.
  if (!Object.keys(out.markets).length) {
    console.log("popularity: nothing collected yet, leaving the data file alone");
  } else {
    await writeFile(outFile, JSON.stringify(out) + "\n");
    const asked = Object.values(out.markets).reduce((s, m) => s + (m.asked ?? 0), 0);
    const measured = Object.values(out.markets).reduce((s, m) => s + (m.measured ?? 0), 0);
    console.log(
      `popularity: ${fetched} markets fetched, ${failures} carried forward` +
        (mirrored.length ? `, ${mirrored.length} mirroring ${reference}` : "") +
        (asked ? `; ${measured}/${asked} terms above Apple's floor` : "")
    );
  }

  // Machine-readable tail, in the RANK_FAILURES style keywords.mjs uses. No
  // workflow greps these today; they are kept because they are the summary a
  // human wants on the last line anyway, and because wiring this into CI later
  // should not require re-deriving what a run concluded about itself.
  console.log(`POP_FAILURES=${failures}`);
  // "dead" is the only state that stays broken until someone pastes a new
  // cookie. "absent" is the state of any checkout that never set the variable.
  //
  // A session-class error only means the session when nothing worked. Apple may
  // well answer 403 for storefronts this account cannot see, and a run where the
  // US worked and Mexico did not is a storefront limitation, not an expired
  // cookie. Conflating the two makes the signal useless.
  //
  // A market skipped by the freshness gate counts as working, because that gate
  // only holds it back on the strength of a recent success. Without that clause
  // a US-only account reports dead every time: the US is gated as fresh, the
  // other ten fail as they always would, nothing is left to succeed, and a
  // perfectly good cookie is declared expired.
  const working = fetched > 0 || gated > 0;
  console.log(
    `POP_SESSION=${
      kinds.has("session") && !working
        ? "dead"
        : kinds.has("absent")
          ? "absent"
          : kinds.has("session")
            ? "partial"
            : "ok"
    }`
  );
}

// --- entry -------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--probe")) await probe();
else if (args.includes("--check")) await check();
else if (args.includes("--report")) await report();
else await collect({ force: args.includes("--force") });
