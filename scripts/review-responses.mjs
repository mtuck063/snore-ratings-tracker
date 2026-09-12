#!/usr/bin/env node
// Developer responses to App Store reviews, folded into reviews.json.
//
// The public customer-reviews RSS feed that collect.mjs reads carries the
// review and nothing else: a reply written in App Store Connect never appears
// in it, so the page showed one half of every conversation. App Store Connect
// carries both -- `/v1/apps/{id}/customerReviews?include=response` returns the
// response body and the date it was last edited alongside the review it
// answers, and the read-only reporting key is allowed to read it, which is
// what lets this run in CI beside the collector.
//
//   node scripts/review-responses.mjs            merge responses into reviews.json
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

const APP_ID = "6751759381";
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const reviewsFile = path.join(repoRoot, "docs", "data", "reviews.json");
const dryRun = process.argv.includes("--dry-run");

// The two feeds disagree about one thing only: the UTC offset. Both stamp a
// review with the same Cupertino wall clock, but the RSS feed writes every one
// of them -07:00 while App Store Connect uses the offset actually in force, so
// anything written in winter differs by an hour once parsed -- 26 of 88 reviews
// when this was written, all of them PST. Comparing the first 19 characters
// compares the wall clock and sidesteps it. The nickname breaks the ties: two
// reviews sharing a second are possible, two sharing a second and an author
// are not, and this is the only field besides the text that both feeds carry
// (the RSS id and the App Store Connect id are unrelated numbers).
const joinKey = (date, author) => `${String(date).slice(0, 19)}|${author}`;

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
  const key = joinKey(r.attributes.createdDate, r.attributes.reviewerNickname);
  ascListed.add(key);
  const attrs = responsesById.get(r.relationships?.response?.data?.id);
  if (!attrs || attrs.state !== "PUBLISHED") continue;
  responseByReview.set(key, {
    body: attrs.responseBody.trim(),
    date: attrs.lastModifiedDate,
  });
}

const stored = JSON.parse(await readFile(reviewsFile, "utf8"));
const added = [];
const edited = [];
const dropped = [];
let unmatched = 0;
for (const r of stored) {
  const key = joinKey(r.date, r.author);
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
  if (!stored.some((r) => joinKey(r.date, r.author) === key)) unmatched++;
}

const label = (r) => `${r.cc} ★${r.rating} ${JSON.stringify(r.title)}`;
for (const r of added) console.log(`+ response: ${label(r)}`);
for (const r of edited) console.log(`~ response edited: ${label(r)}`);
for (const r of dropped) console.log(`- response removed: ${label(r)}`);
// A response whose review is not in reviews.json means the join stopped
// working -- worth saying out loud, since the symptom of a broken key is a
// page that simply never shows a reply.
if (unmatched) console.warn(`${unmatched} response(s) matched no stored review`);

const changed = added.length + edited.length + dropped.length;
if (!changed) {
  console.log(`no response changes (${responseByReview.size} published)`);
} else if (dryRun) {
  console.log(`${changed} change(s); --dry-run, nothing written`);
} else {
  await writeFile(reviewsFile, JSON.stringify(stored));
  console.log(`${changed} change(s) written to docs/data/reviews.json`);
}
