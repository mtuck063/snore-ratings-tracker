#!/usr/bin/env node
// App Store ratings collector for Snore Timeline (id 6751759381).
// Fetches lifetime rating totals per storefront from the iTunes Lookup API
// and maintains the files the dashboard reads.
//
// Every run checks all storefronts, all requests fired in parallel (the API
// tolerates bursts; verified with 50+ simultaneous calls). A failed fetch
// retries once, then keeps the previous value, so an API outage or throttle
// can't fake a delisting.

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
      avg: app.averageUserRating != null ? Number(app.averageUserRating.toFixed(2)) : null,
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

const fetchedAt = new Date().toISOString();
const today = fetchedAt.slice(0, 10);

const prevLatest = await readJson(path.join(servedDataDir, "latest.json"), null);
const prevRated = prevLatest
  ? Object.entries(prevLatest.countries).filter(([, c]) => c?.count > 0).map(([cc]) => cc)
  : [];

async function ratingsPass() {
  const results = await Promise.all(COUNTRIES.map((cc) => fetchCountry(cc)));
  const countries = {}; // built in COUNTRIES order so stringify comparisons stay stable
  COUNTRIES.forEach((cc, i) => {
    countries[cc] = results[i] === "error" ? (prevLatest?.countries[cc] ?? null) : results[i];
  });
  const failed = results.filter((r) => r === "error").length;
  console.log(`ratings done${failed ? ` (${failed} failed, values carried over)` : ""}`);
  return countries;
}

async function reviewsPass() {
  const perStorefront = await Promise.all(prevRated.map((cc) => fetchReviews(cc)));
  console.log(`reviews done (${prevRated.length} storefronts)`);
  return perStorefront.flat();
}

const [countries, fetchedReviews] = await Promise.all([ratingsPass(), reviewsPass()]);

// Fold newly fetched reviews into the stored set.
const reviewsFile = path.join(servedDataDir, "reviews.json");
const storedReviews = await readJson(reviewsFile, []);
const knownIds = new Set(storedReviews.map((r) => r.id));
const isReviewSeed = storedReviews.length === 0;
const newReviews = [];
for (const r of fetchedReviews) {
  if (!knownIds.has(r.id)) {
    knownIds.add(r.id);
    newReviews.push({ ...r, firstSeen: fetchedAt, ...(isReviewSeed && { seeded: true }) });
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

const ratingsChanged = !prevLatest || JSON.stringify(prevLatest.countries) !== JSON.stringify(countries);
if (!ratingsChanged && newReviews.length === 0) {
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
      events.push({ at: fetchedAt, cc, type: "delta", from: prevCount, to: curCount });
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
