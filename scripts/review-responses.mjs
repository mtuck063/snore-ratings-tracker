#!/usr/bin/env node
// App Store Connect's view of the reviews, folded into reviews.json.
//
// The public customer-reviews RSS feed that collect.mjs reads has two holes.
// It carries the review and nothing else: a reply written in App Store Connect
// never appears in it, so the page showed one half of every conversation. And
// it is served from edges that disagree with each other: the same storefront
// answers with its reviews from one edge and with none from the next, and a
// runner that keeps landing on a stale edge never sees a review at all -- a
// Japanese review sat on the store page for two days while every hourly run
// logged "0 new written reviews". App Store Connect has neither problem.
// `/v1/apps/{id}/customerReviews?include=response` returns every review in
// every territory with its response body and the date it was last edited,
// and the read-only reporting key is allowed to read it, which is what lets
// this run in CI beside the collector.
//
// So this does two things with one download: attaches responses to stored
// reviews, and stores any review the feed never delivered. The feed stays the
// primary source -- it is public, needs no credential, and carries the app
// version, which the API does not -- and when it later catches up with a
// review stored from here, the collector adopts the feed's id and version.
//
//   node scripts/review-responses.mjs            merge into reviews.json
//   node scripts/review-responses.mjs --dry-run  print the changes, write nothing
//
// Credentials come from ASC_KEY_ID/ASC_ISSUER_ID/ASC_PRIVATE_KEY or, locally,
// ~/.config/appstoreconnect (see asc.mjs). Missing credentials are not an
// error: the script says so and exits 0, so a fork -- or the collector's
// workflow before the secrets are set -- still collects ratings.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ascFetch, haveCredentials, makeToken } from "./asc.mjs";
import { API_ID_PREFIX, findReplacement, isRemovalEventFor, joinKey } from "./review-key.mjs";
import { ISO2 } from "./territories.mjs";

const APP_ID = "6751759381";
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(repoRoot, "docs", "data");
const reviewsFile = path.join(dataDir, "reviews.json");
const eventsFile = path.join(dataDir, "events.json");
const dryRun = process.argv.includes("--dry-run");

if (!(await haveCredentials())) {
  console.log("no App Store Connect credentials; skipping review responses");
  process.exit(0);
}

// include=response returns the responses in a sibling `included` array, so
// pagination has to keep both halves of every page -- asc.mjs's --all keeps
// only `data`, which is why this walks the links itself.
const token = await makeToken();
const reviews = [];
const responsesById = new Map();
let next = `/v1/apps/${APP_ID}/customerReviews?limit=200&sort=-createdDate&include=response`;
while (next) {
  const page = (await ascFetch(next, token)).body;
  reviews.push(...(page.data ?? []));
  for (const item of page.included ?? []) {
    if (item.type === "customerReviewResponses") responsesById.set(item.id, item.attributes);
  }
  next = page.links?.next;
}

// A response that is still PENDING_PUBLISH is not on the store page yet, and
// the tracker only ever shows what a visitor to the listing would see.
const ascListed = new Set();
const responseByReview = new Map();
for (const r of reviews) {
  const key = joinKey(r.attributes.createdDate, ISO2[r.attributes.territory], r.attributes.rating);
  ascListed.add(key);
  const attrs = responsesById.get(r.relationships?.response?.data?.id);
  if (!attrs || attrs.state !== "PUBLISHED") continue;
  responseByReview.set(key, {
    body: attrs.responseBody.trim(),
    date: attrs.lastModifiedDate,
  });
}

const now = new Date().toISOString();
const stored = JSON.parse(await readFile(reviewsFile, "utf8"));
const storedKeys = new Set(stored.map((r) => joinKey(r.date, r.cc, r.rating)));

// Reviews the API lists that the feed has not delivered. Stored in the
// feed's own shape so nothing downstream can tell the sources apart, except
// the id prefix the collector uses to recognise one when the feed catches up,
// and an empty version, which the API does not carry. A review the collector
// has flagged `removed` still has its key in the set, so a deletion the feed
// confirmed is not undone by an API that is slower to drop it. A territory
// the table does not know is skipped, since without a storefront code the
// record could neither be keyed nor shown.
const fromApi = [];
for (const r of reviews) {
  const a = r.attributes;
  const cc = ISO2[a.territory];
  if (!cc) {
    console.warn(`unknown territory ${a.territory}, skipping ${JSON.stringify(a.title)}`);
    continue;
  }
  const key = joinKey(a.createdDate, cc, a.rating);
  if (storedKeys.has(key)) continue;
  const rec = {
    id: `${API_ID_PREFIX}${r.id}`,
    cc,
    rating: a.rating,
    title: a.title ?? "",
    body: a.body ?? "",
    author: a.reviewerNickname ?? "",
    version: "",
    date: a.createdDate,
    firstSeen: now,
  };
  stored.push(rec);
  storedKeys.add(key);
  fromApi.push(rec);
}

// A review stored from here is invisible to the collector's removal check,
// which only knows what the feed answered, so the same two-step rule runs
// against the API's listing instead: noted absent on the first run, removed
// once the absence has held for a day.
const REMOVAL_CONFIRM_MS = 24 * 3600e3;
const removedFromApi = [];
let markedMissing = 0;
for (const r of stored) {
  if (!r.id.startsWith(API_ID_PREFIX) || r.removed) continue;
  if (ascListed.has(joinKey(r.date, r.cc, r.rating))) {
    if (r.missingSince) markedMissing++;
    delete r.missingSince;
  } else if (!r.missingSince) {
    r.missingSince = now;
    markedMissing++;
  } else if (new Date(now) - new Date(r.missingSince) >= REMOVAL_CONFIRM_MS) {
    r.removed = now;
    removedFromApi.push(r);
  }
}

// A review its author rewrote, as in the collector: flagged `replaced`, no
// removal event, and a removal already logged is withdrawn below.
const lateReplaced = [];
let replacedCount = 0;
for (const r of stored) {
  if (!r.removed || r.replaced || !findReplacement(r, stored)) continue;
  r.replaced = now;
  replacedCount++;
  const i = removedFromApi.indexOf(r);
  if (i >= 0) removedFromApi.splice(i, 1);
  else lateReplaced.push(r);
}

const added = [];
const edited = [];
const dropped = [];
let unmatched = 0;
for (const r of stored) {
  const key = joinKey(r.date, r.cc, r.rating);
  const fresh = responseByReview.get(key);
  if (!fresh) {
    // Only a review App Store Connect still lists can lose a response. One it
    // has stopped listing was deleted by its author (the collector flags the
    // same disappearance in the RSS feed), and dropping the reply then would
    // erase a record of something that was said.
    if (r.response && ascListed.has(key)) {
      dropped.push(r);
      delete r.response;
    }
    continue;
  }
  if (!r.response) {
    added.push(r);
    r.response = fresh;
  } else if (r.response.body !== fresh.body || r.response.date !== fresh.date) {
    edited.push(r);
    r.response = fresh;
  }
}
for (const key of responseByReview.keys()) {
  if (!storedKeys.has(key)) unmatched++;
}

const label = (r) => `${r.cc} ★${r.rating} ${JSON.stringify(r.title)}`;
for (const r of fromApi) console.log(`+ review the feed never served: ${label(r)}`);
for (const r of removedFromApi) console.log(`- review gone from App Store Connect: ${label(r)}`);
for (const r of stored) if (r.replaced === now) console.log(`~ review replaced by its author's newer one: ${label(r)}`);
for (const r of added) console.log(`+ response: ${label(r)}`);
for (const r of edited) console.log(`~ response edited: ${label(r)}`);
for (const r of dropped) console.log(`- response removed: ${label(r)}`);
// A response whose review is not in reviews.json means the join stopped
// working -- worth saying out loud, since the symptom of a broken key is a
// page that simply never shows a reply.
if (unmatched) console.warn(`${unmatched} response(s) matched no stored review`);

// The same events the collector raises for a review the feed delivered, so
// the week row and the event log treat the two sources alike. Same seven-day
// rule too: a review the API surfaces months late joins the list silently.
const events = JSON.parse(await readFile(eventsFile, "utf8"));
const recent = (r) => r.date && new Date(r.firstSeen) - new Date(r.date) <= 7 * 864e5;
for (const r of fromApi) {
  if (recent(r)) events.push({ at: now, cc: r.cc, type: "review", rating: r.rating, title: r.title.slice(0, 80) });
}
for (const r of lateReplaced) {
  const i = events.findLastIndex((ev) => isRemovalEventFor(ev, r));
  if (i >= 0) events.splice(i, 1);
}
for (const r of removedFromApi) {
  events.push({ at: now, cc: r.cc, type: "review-removed", rating: r.rating, title: r.title.slice(0, 80) });
}

const changed =
  fromApi.length + removedFromApi.length + markedMissing + replacedCount + added.length + edited.length + dropped.length;
if (!changed) {
  console.log(`no review changes (${responseByReview.size} responses published)`);
} else if (dryRun) {
  console.log(`${changed} change(s); --dry-run, nothing written`);
} else {
  await writeFile(reviewsFile, JSON.stringify(stored));
  await writeFile(eventsFile, JSON.stringify(events));
  console.log(`${changed} change(s) written to docs/data/reviews.json`);
}
