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
// A bare date rounds to midnight at the START of that day, so end=today would
// exclude today entirely. Asking through tomorrow includes the partial day.
const end = fmt(new Date(now.getTime() + 864e5));
const today = fmt(now);

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

  // Per-country split for the trailing 30 days, as one aggregate request.
  // GoatCounter's locations stat cannot split by day (per-day requests turned
  // out to sit on a shifted day boundary and a different counting unit than
  // the visitor totals above), and the dashboard only shows a 30-day share,
  // so a rolling snapshot replaces history here. Overwritten whole each run;
  // a failure keeps the previous snapshot.
  try {
    const start30 = fmt(new Date(now.getTime() - 30 * 864e5));
    const locRes = await fetch(
      `${SITE}/api/v0/stats/locations?start=${start30}&end=${end}&limit=100`,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    if (!locRes.ok) {
      const detail = (await locRes.text().catch(() => "")).slice(0, 200);
      throw new Error(`HTTP ${locRes.status}${detail ? ` ${detail}` : ""}`);
    }
    const locBody = await locRes.json();
    const counts = {};
    for (const s of locBody.stats ?? []) {
      if (s.count > 0) counts[s.id || "??"] = s.count;
    }
    // Sorted keys keep a no-change run rewriting the file byte-identically.
    stored.countries = {
      since: start30,
      asOf: today,
      counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
    };
  } catch (err) {
    console.warn(`pageviews: locations ${err.message}; keeping stored country split.`);
  }

  await writeFile(file, JSON.stringify(stored));
  console.log(
    `pageviews: today so far ${stored.days[today] ?? 0}, ${Object.keys(stored.days).length} day(s) stored`
  );
} catch (err) {
  console.warn(`pageviews: ${err.message}; keeping stored values.`);
}
