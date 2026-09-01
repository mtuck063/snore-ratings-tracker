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
// PAGEVIEWS_WINDOW_DAYS widens it for a one-off repair, from the collect
// workflow's dispatch input; the schedule always runs on the default.
const WINDOW_DAYS = Number(process.env.PAGEVIEWS_WINDOW_DAYS) || 14;

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
    const day = String(s.day).slice(0, 10);
    // GoatCounter answers in the site's own timezone, so a UTC start lands
    // mid-afternoon there and the first row it returns is the last few hours
    // of the day BEFORE the one asked for. Stored as if it were a whole day,
    // that clipped row replaced a full count with about a fifth of one, and
    // since the day then left the window for good, the fifth was what stuck:
    // every day between 2026-08-03 and 2026-08-17 was rewritten downward at
    // exactly 15 days old, which is what put a cliff in the chart.
    if (day < start) continue;
    // A day's visitor count only accumulates, so a smaller answer is a worse
    // read of the same day and never news. Taking the larger makes a clipped
    // or partial response harmless whatever shape the next one arrives in.
    stored.days[day] = Math.max(stored.days[day] ?? 0, s.daily ?? 0);
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
      byDay: stored.countries?.byDay ?? {},
    };
  } catch (err) {
    console.warn(`pageviews: locations ${err.message}; keeping stored country split.`);
  }

  // Per-day splits for the chart tooltip, refetched across the same
  // self-healing window as days. A bare same-day range (start=d&end=d) is the
  // closest single-day slice the API offers, but it runs on the site's day
  // boundary rather than UTC's, so each split sits a few hours off the day
  // total above it. That is why the frontend only ever renders these as
  // shares of the day, never as counts next to `days`. Paced under the API's
  // per-second rate limit, with one retry as the safety net; a failure
  // partway keeps whatever landed and the window heals the rest next run.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    stored.countries ??= {};
    stored.countries.byDay ??= {};
    for (let ms = new Date(start).getTime(); fmt(new Date(ms)) <= today; ms += 864e5) {
      const day = fmt(new Date(ms));
      await sleep(300);
      const locUrl = `${SITE}/api/v0/stats/locations?start=${day}&end=${day}&limit=100`;
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      let dayRes = await fetch(locUrl, { headers });
      if (dayRes.status === 429) {
        await sleep(1000);
        dayRes = await fetch(locUrl, { headers });
      }
      if (!dayRes.ok) {
        const detail = (await dayRes.text().catch(() => "")).slice(0, 200);
        throw new Error(`HTTP ${dayRes.status}${detail ? ` ${detail}` : ""}`);
      }
      const dayBody = await dayRes.json();
      const counts = {};
      for (const s of dayBody.stats ?? []) {
        if (s.count > 0) counts[s.id || "??"] = s.count;
      }
      stored.countries.byDay[day] = Object.fromEntries(
        Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))
      );
    }
  } catch (err) {
    console.warn(`pageviews: locations by day ${err.message}; keeping stored splits.`);
  }

  // Referrers, operating systems, and languages over the same trailing 30
  // days — the rest of who visits and how they arrived. Same treatment as
  // the country snapshot: one aggregate request each, replaced whole every
  // run, quiet on failure. Stored as [label, count] pairs already sorted so
  // the frontend renders them as-is.
  try {
    const start30 = fmt(new Date(now.getTime() - 30 * 864e5));
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const extras = { asOf: today };
    const pages = [
      ["refs", "toprefs", "Direct / none"],
      ["systems", "systems", "Unknown"],
      ["langs", "languages", "Unknown"],
    ];
    for (const [key, page, blank] of pages) {
      await sleep(300);
      const url = `${SITE}/api/v0/stats/${page}?start=${start30}&end=${end}&limit=20`;
      let res = await fetch(url, { headers });
      if (res.status === 429) {
        await sleep(1000);
        res = await fetch(url, { headers });
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`${page} HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
      }
      const body = await res.json();
      extras[key] = (body.stats ?? [])
        .filter((s) => s.count > 0)
        .map((s) => [s.name || s.id || blank, s.count])
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    }
    stored.extras = extras;
  } catch (err) {
    console.warn(`pageviews: extras ${err.message}; keeping stored breakdowns.`);
  }

  await writeFile(file, JSON.stringify(stored));
  console.log(
    `pageviews: today so far ${stored.days[today] ?? 0}, ${Object.keys(stored.days).length} day(s) stored`
  );
} catch (err) {
  console.warn(`pageviews: ${err.message}; keeping stored values.`);
}
