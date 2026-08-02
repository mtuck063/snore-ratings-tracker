#!/usr/bin/env node
// App Store ratings collector for Snore Timeline (id 6751759381).
//
// One call per storefront, from whichever source tells the most:
//  - Rated storefronts: the product web page, whose embedded star histogram
//    gives count + exact average + per-star breakdown in one fetch, on a CDN
//    that updates faster than the lookup API's.
//  - Unrated storefronts: the ~2KB lookup API, which only needs to answer
//    "did a first rating appear / is it still listed".
//
// A failed fetch retries once, then keeps the previous value, so an API
// outage or throttle can't fake a delisting.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ID = "6751759381";
const RETRY_BACKOFF_MS = 10000;

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const servedDataDir = path.join(repoRoot, "docs", "data");

// Every App Store storefront listing the app, found by probing the lookup
// API for each ISO region code (2026-07). Rebuild the same way if needed.
const COUNTRIES = [
  "ae", "af", "ag", "ai", "al", "am", "ao", "ar", "at", "au",
  "az", "ba", "bb", "be", "bf", "bg", "bh", "bj", "bm", "bn",
  "bo", "br", "bs", "bt", "bw", "by", "bz", "ca", "cd", "cg",
  "ch", "ci", "cl", "cm", "cn", "co", "cr", "cv", "cy", "cz",
  "de", "dk", "dm", "do", "dz", "ec", "ee", "eg", "es", "fi",
  "fj", "fm", "fr", "ga", "gb", "gd", "ge", "gh", "gm", "gr",
  "gt", "gw", "gy", "hk", "hn", "hr", "hu", "id", "ie", "il",
  "in", "iq", "is", "it", "jm", "jo", "jp", "ke", "kg", "kh",
  "kn", "kr", "kw", "ky", "kz", "la", "lb", "lc", "lk", "lr",
  "lt", "lu", "lv", "ly", "ma", "md", "me", "mg", "mk", "ml",
  "mm", "mn", "mo", "mr", "ms", "mt", "mu", "mv", "mw", "mx",
  "my", "mz", "na", "ne", "ng", "ni", "nl", "no", "np", "nr",
  "nz", "om", "pa", "pe", "pg", "ph", "pk", "pl", "pt", "pw",
  "py", "qa", "ro", "rs", "ru", "rw", "sa", "sb", "sc", "se",
  "sg", "si", "sk", "sl", "sn", "sr", "st", "sv", "sz", "tc",
  "td", "th", "tj", "tm", "tn", "to", "tr", "tt", "tw", "tz",
  "ua", "ug", "us", "uy", "uz", "vc", "ve", "vg", "vn", "vu",
  "xk", "ye", "za", "zm", "zw",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Resolves to a country record, null (genuinely not listed), or "error"
// (network/HTTP failure) so callers can keep the previous value instead of
// mistaking an outage for a delisting.
async function fetchCountry(cc, attempt = 1) {
  const url = `https://itunes.apple.com/lookup?id=${APP_ID}&country=${cc}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const app = (await res.json()).results?.[0];
    if (!app) return null;
    return {
      count: app.userRatingCount ?? 0,
      // Full API precision (5 decimals): with exact averages, a +1 count
      // change pins down the new rating's star value via
      // (n+1)*newAvg - n*oldAvg. Rounding here would destroy that.
      avg: app.averageUserRating ?? null,
    };
  } catch (err) {
    if (attempt === 1) {
      console.warn(`${cc}: ${err.message}, retrying in ${RETRY_BACKOFF_MS / 1000}s`);
      await sleep(RETRY_BACKOFF_MS);
      return fetchCountry(cc, 2);
    }
    console.warn(`${cc}: ${err.message}, keeping previous value`);
    return "error";
  }
}

// Apple's public customer-reviews RSS: written reviews only (star-only
// ratings never appear), roughly the 50 most recent per storefront.
async function fetchReviews(cc) {
  const url = `https://itunes.apple.com/${cc}/rss/customerreviews/id=${APP_ID}/sortby=mostrecent/json`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let entries = (await res.json()).feed?.entry ?? [];
    if (!Array.isArray(entries)) entries = [entries];
    return entries
      .filter((e) => e?.id?.label && e?.["im:rating"]?.label)
      .map((e) => ({
        id: e.id.label,
        cc,
        rating: Number(e["im:rating"].label),
        title: e.title?.label ?? "",
        body: e.content?.label ?? "",
        author: e.author?.name?.label ?? "",
        version: e["im:version"]?.label ?? "",
        date: e.updated?.label ?? null, // when the review was written
      }));
  } catch (err) {
    console.warn(`${cc} reviews: ${err.message}`);
    return []; // stored reviews for this storefront are kept regardless
  }
}

// Star histograms live in the storefront web page ([5★..1★] embedded in its
// server-rendered data). Pages are ~500KB, so fetches go through a gate.
let pageActive = 0;
const pageQueue = [];
async function pageGate(fn) {
  if (pageActive >= 8) await new Promise((r) => pageQueue.push(r));
  pageActive++;
  try {
    return await fn();
  } finally {
    pageActive--;
    pageQueue.shift()?.();
  }
}

async function fetchHistogram(cc, attempt = 1) {
  const url = `https://apps.apple.com/${cc}/app/id${APP_ID}`;
  try {
    const html = await pageGate(async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
    const m = html.match(/"ratingCounts":\[([0-9,]+)\]/);
    return m ? m[1].split(",").map(Number) : null;
  } catch (err) {
    if (attempt === 1) {
      await sleep(RETRY_BACKOFF_MS);
      return fetchHistogram(cc, 2);
    }
    console.warn(`${cc} histogram: ${err.message}`);
    return null;
  }
}

// Primary source for rated storefronts: count and exact average derived from
// the histogram itself, so ratings data and star breakdown can never disagree.
async function fetchCountryFromPage(cc) {
  const counts = await fetchHistogram(cc);
  if (!counts) return "error"; // carry previous; delistings are caught elsewhere
  const count = counts.reduce((a, b) => a + b, 0);
  const stars = counts.reduce((s, c, i) => s + c * (5 - i), 0);
  return {
    record: { count, avg: count ? Number((stars / count).toFixed(5)) : null },
    counts,
  };
}

const fetchedAt = new Date().toISOString();
const today = fetchedAt.slice(0, 10);

const prevLatest = await readJson(path.join(servedDataDir, "latest.json"), null);
const prevRated = prevLatest
  ? Object.entries(prevLatest.countries).filter(([, c]) => c?.count > 0).map(([cc]) => cc)
  : [];

async function ratingsPass() {
  const ratedSet = new Set(prevRated);
  // Two sources on purpose; collapsing to either one alone loses something.
  // The storefront page is the fresher number and carries the star histogram
  // in the same fetch, but it's ~500KB and starts returning 429s under load,
  // so it's spent only on storefronts that actually have ratings. The lookup
  // API has no histogram at all, but at ~11KB it's the only sane way to poll
  // the long tail of storefronts still sitting at zero (currently ~70% of the
  // list). Routing everything through the page costs ~3x the bandwidth to
  // learn nothing new about that tail.
  const results = await Promise.all(
    COUNTRIES.map((cc) => (ratedSet.has(cc) ? fetchCountryFromPage(cc) : fetchCountry(cc)))
  );
  const countries = {}; // built in COUNTRIES order so stringify comparisons stay stable
  const pageCounts = {}; // cc -> [5★..1★] from this run's page fetches
  COUNTRIES.forEach((cc, i) => {
    const r = results[i];
    if (r === "error") {
      countries[cc] = prevLatest?.countries[cc] ?? null;
    } else if (r && r.record) {
      countries[cc] = r.record;
      pageCounts[cc] = r.counts;
    } else {
      countries[cc] = r;
    }
  });
  const failed = results.filter((r) => r === "error").length;
  console.log(`ratings done${failed ? ` (${failed} failed, values carried over)` : ""}`);
  return { countries, pageCounts, failed };
}

async function reviewsPass() {
  const perStorefront = await Promise.all(prevRated.map((cc) => fetchReviews(cc)));
  console.log(`reviews done (${prevRated.length} storefronts)`);
  return perStorefront.flat();
}

const [{ countries, pageCounts, failed: fetchFailures }, fetchedReviews] = await Promise.all([
  ratingsPass(),
  reviewsPass(),
]);

// Fold newly fetched reviews into the stored set.
const reviewsFile = path.join(servedDataDir, "reviews.json");
const storedReviews = await readJson(reviewsFile, []);
const knownIds = new Set(storedReviews.map((r) => r.id));
const isReviewSeed = storedReviews.length === 0;
const newReviews = [];
for (const r of fetchedReviews) {
  if (!knownIds.has(r.id)) {
    knownIds.add(r.id);
    newReviews.push({ ...r, firstSeen: fetchedAt });
  }
}
console.log(`${newReviews.length} new written reviews`);

// The lookup API's CDN can serve a stale, lower count for many hours after a
// real increase (verified against App Store Connect). Increases record
// immediately; a decrease only sticks after being reported continuously for
// 48 hours, since genuine rating removals are rare and never urgent.
const pendingFile = path.join(servedDataDir, "pending.json");
const pending = await readJson(pendingFile, {});
const pendingBefore = JSON.stringify(pending);
const DECREASE_CONFIRM_MS = 48 * 3600e3;
if (prevLatest) {
  for (const [cc, cur] of Object.entries(countries)) {
    const prev = prevLatest.countries[cc];
    if (cur?.count == null || prev?.count == null || cur.count >= prev.count) {
      delete pending[cc]; // any non-decrease resets the clock
      continue;
    }
    const entry = typeof pending[cc] === "object" && pending[cc] ? pending[cc] : null;
    if (entry && entry.count === cur.count && Date.now() - new Date(entry.since) >= DECREASE_CONFIRM_MS) {
      delete pending[cc]; // persisted long enough to be a real removal
    } else {
      if (!entry || entry.count !== cur.count) pending[cc] = { count: cur.count, since: fetchedAt };
      countries[cc] = prev; // hold the confirmed value meanwhile
    }
  }
}
if (JSON.stringify(pending) !== pendingBefore) await writeFile(pendingFile, JSON.stringify(pending));

// Star histogram bookkeeping. The page cohort's histograms arrived with the
// ratings fetch; only storefronts newly rated via the lookup cohort still
// need a page fetch (their first rating just appeared).
const histFile = path.join(servedDataDir, "histograms.json");
const histograms = await readJson(histFile, { countries: {} });
const sumOf = (a) => a.reduce((x, y) => x + y, 0);
const needHist = Object.entries(countries)
  .filter(([cc, c]) => c?.count > 0 && !(cc in pageCounts))
  .filter(([cc, c]) => {
    const h = histograms.countries[cc];
    return !h || sumOf(h.counts) !== c.count;
  })
  .map(([cc]) => cc);
// An edit-shift (same total, different stars) changes no count, so it must
// keep the run alive past the early exit on its own.
const pageHistChanged = Object.entries(pageCounts).some(([cc, counts]) => {
  const h = histograms.countries[cc];
  return sumOf(counts) === countries[cc]?.count && (!h || h.counts.join() !== counts.join());
});

const ratingsChanged = !prevLatest || JSON.stringify(prevLatest.countries) !== JSON.stringify(countries);

// Heartbeat, written before the early exit below because the quiet path is
// exactly when it matters: latest.json only moves when a rating moves, so a
// frozen timestamp there is indistinguishable from a collector that has been
// dead since Tuesday. This separates "checked at" from "changed at". Merged
// rather than overwritten so the keywords collector's entry survives.
//
// Written every run. This was briefly throttled to save commits on quiet
// hours, which was a mistake: the dashboard reads `at` as "when did it last
// check", and a throttled value made a healthy collector look six hours dead.
// A heartbeat that only sometimes beats is a worse version of the thing it
// replaced. It also forced the watchdog's bound to exceed the throttle,
// coupling two constants that had to be kept in step by hand.
//
// The cost is real but small: GitHub actually fires ~13 of the 24 hourly
// slots, and only the runs that change data would have committed anyway, so
// this is roughly a dozen extra commits a day on a repo whose entire design is
// bot commits.
const statusFile = path.join(servedDataDir, "status.json");
const status = await readJson(statusFile, {});
const anythingChanged = ratingsChanged || newReviews.length > 0 || needHist.length > 0 || pageHistChanged;
status.ratings = {
  at: fetchedAt,
  storefronts: COUNTRIES.length,
  failed: fetchFailures,
  changed: ratingsChanged,
};
await writeFile(statusFile, JSON.stringify(status));

// Also before the early exit: a run where most fetches failed carries every
// value forward, which leaves ratingsChanged false and would slip out through
// the quiet path with exit 0. Past a quarter of storefronts this is not a
// blip, and the run needs to be loud enough for the failure mail to fire.
const FAIL_RATIO = 0.25;
if (fetchFailures > COUNTRIES.length * FAIL_RATIO) {
  console.error(
    `FAILED: ${fetchFailures}/${COUNTRIES.length} storefronts did not answer ` +
      `(threshold ${Math.floor(COUNTRIES.length * FAIL_RATIO)}). Data was carried forward, not updated.`
  );
  process.exit(1);
}

if (!anythingChanged) {
  console.log("No rating or review changes since last fetch; nothing written.");
  process.exit(0);
}

if (newReviews.length) {
  await writeFile(reviewsFile, JSON.stringify([...newReviews, ...storedReviews]));
}

// Log what changed, timestamped: this is what the dashboard's Latest strip
// and events section show, since day-granular history can't attribute it.
const events = await readJson(path.join(servedDataDir, "events.json"), []);
if (ratingsChanged && prevLatest) {
  for (const [cc, cur] of Object.entries(countries)) {
    const curCount = cur?.count;
    if (curCount == null) continue;
    const prevCount = prevLatest.countries[cc]?.count;
    if (!(cc in prevLatest.countries)) {
      events.push({ at: fetchedAt, cc, type: "tracked", to: curCount });
    } else if ((prevCount ?? 0) === 0 && curCount > 0) {
      events.push({ at: fetchedAt, cc, type: "first", to: curCount, avg: cur.avg });
    } else if (prevCount != null && curCount !== prevCount) {
      const ev = { at: fetchedAt, cc, type: "delta", from: prevCount, to: curCount };
      // A single added/removed rating's star value falls out of the two
      // averages. Only annotate when the arithmetic lands cleanly on an
      // integer: stored 2-decimal averages from before this feature (and
      // any same-hour rating edits) fail the tolerance and stay unlabeled.
      const prevAvg = prevLatest.countries[cc]?.avg;
      if (Math.abs(curCount - prevCount) === 1 && cur.avg != null && prevAvg != null) {
        const est =
          curCount > prevCount
            ? curCount * cur.avg - prevCount * prevAvg
            : prevCount * prevAvg - curCount * cur.avg;
        const star = Math.round(est);
        if (star >= 1 && star <= 5 && Math.abs(est - star) < 0.25) ev.stars = star;
      }
      events.push(ev);
    }
  }
}
if (!isReviewSeed) {
  for (const r of newReviews) {
    // Apple's feeds sometimes surface months-old reviews late; those join the
    // list silently. Only reviews actually written recently are news.
    if (r.date && new Date(r.firstSeen) - new Date(r.date) > 7 * 864e5) continue;
    events.push({ at: fetchedAt, cc: r.cc, type: "review", rating: r.rating, title: r.title.slice(0, 80) });
  }
}
// Apply this run's page histograms, then fetch the few remaining (newly
// rated) storefronts. A snapshot diff pins the exact stars behind this run's
// delta event, overriding the average-math inference (the fallback). A
// snapshot is stored only when its total agrees with the recorded count, so
// a pending-decrease hold keeps the previous snapshot; and only when the
// counts actually moved, so quiet runs don't rewrite timestamps.
let histUpdated = false;
function applyHistogram(cc, counts) {
  if (sumOf(counts) !== countries[cc]?.count) {
    console.warn(`${cc} histogram: total disagrees with recorded count, will retry`);
    return;
  }
  const prevH = histograms.countries[cc];
  if (prevH) {
    const changed = counts.map((n, j) => [5 - j, n - prevH.counts[j]]).filter(([, d]) => d !== 0);
    const ev = events.find((e) => e.at === fetchedAt && e.cc === cc && e.type === "delta");
    if (ev && changed.length) {
      if (changed.length === 1 && Math.abs(changed[0][1]) === 1) ev.stars = changed[0][0];
      else ev.starsMix = Object.fromEntries(changed);
    }
    if (!changed.length) return;
  }
  histograms.countries[cc] = { counts };
  histUpdated = true;
}
for (const [cc, counts] of Object.entries(pageCounts)) applyHistogram(cc, counts);
for (let i = 0; i < needHist.length; i += 8) {
  await Promise.all(
    needHist.slice(i, i + 8).map(async (cc) => {
      const counts = await fetchHistogram(cc);
      if (counts) applyHistogram(cc, counts);
    })
  );
}
if (needHist.length) console.log(`histograms: ${needHist.length} extra storefront(s) fetched`);
if (histUpdated) await writeFile(histFile, JSON.stringify(histograms));

await writeFile(path.join(servedDataDir, "events.json"), JSON.stringify(events));

if (ratingsChanged) {
  await writeFile(path.join(servedDataDir, "latest.json"), JSON.stringify({ fetchedAt, countries }, null, 2));

  // History: one row per day, upserted so a rerun replaces today's row.
  const historyFile = path.join(servedDataDir, "history.json");
  const history = await readJson(historyFile, []);
  const row = { date: today, countries };
  const existing = history.findIndex((r) => r.date === today);
  if (existing >= 0) history[existing] = row;
  else history.push(row);
  history.sort((a, b) => a.date.localeCompare(b.date));
  await writeFile(historyFile, JSON.stringify(history));
}

const total = Object.values(countries).reduce((sum, c) => sum + (c?.count ?? 0), 0);
console.log(`${today}: ${total} total ratings across ${COUNTRIES.length} storefronts`);

