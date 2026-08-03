#!/usr/bin/env node
// Website pageview collector: pulls daily visitor totals for snoretimeline.com
// from GoatCounter's stats API into docs/data/pageviews.json.
//
// Deliberately separate from collect.mjs and deliberately quiet on failure:
// pageviews ride along on the ratings run as a nice-to-have, and a GoatCounter
// outage (or a missing token) should never fail the ratings job or raise its
// alarm issue. This script always exits 0.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "https://snoretimeline.goatcounter.com";
// Refetch this many trailing days each run. Every young day gets re-asked, so
// late-arriving hits and skipped runs self-heal without any bookkeeping.
const WINDOW_DAYS = 14;

const token = process.env.GOATCOUNTER_TOKEN;
if (!token) {
  console.log("pageviews: GOATCOUNTER_TOKEN not set, skipping.");
  process.exit(0);
}

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(repoRoot, "docs", "data", "pageviews.json");

let stored;
try {
  stored = JSON.parse(await readFile(file, "utf8"));
} catch {
  stored = { days: {} };
}

const now = new Date();
const fmt = (d) => d.toISOString().slice(0, 10);
const start = fmt(new Date(now.getTime() - WINDOW_DAYS * 864e5));
const end = fmt(now);

try {
  const res = await fetch(`${SITE}/api/v0/stats/total?start=${start}&end=${end}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    // GoatCounter's error bodies say why (bad token, wrong site, bad params),
    // which the status alone doesn't.
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
  }
  const body = await res.json();
  // Existing keys are updated in place and new days append at the end, so a
  // run where nothing moved rewrites the file byte-identically and git sees
  // no diff (same trick history.json relies on).
  for (const s of body.stats ?? []) {
    stored.days[String(s.day).slice(0, 10)] = s.daily ?? 0;
  }
  await writeFile(file, JSON.stringify(stored));
  console.log(
    `pageviews: today so far ${stored.days[end] ?? 0}, ${Object.keys(stored.days).length} day(s) stored`
  );
} catch (err) {
  console.warn(`pageviews: ${err.message}; keeping stored values.`);
}
