#!/usr/bin/env node
// Slot log: who held each search-result slot, per keyword, per market, per day.
//
// The rank collector records where WE place. It also sees the whole top ten
// and the five apps directly above us on every run, and until now that list
// was overwritten each run and gone. This keeps one row per keyword per day
// (the day's closing run) so two questions become answerable that a single
// snapshot cannot touch:
//
//  - Who OWNS a slot. An app that has sat at #1 for thirty days straight is a
//    wall, and no wording change moves a wall. An app that trades #1 with a
//    rival every few days is a contest. Both look identical in one snapshot.
//  - Where the CEILING is. Consecutive welded slots from #1 are not on the
//    market; the winnable contest starts under them. #24 with an open head has
//    more room than #8 under three welded incumbents, and the difficulty
//    score reads that off this log.
//
// Two kinds of movement are kept apart, because only one of them is a chance:
// apps REORDERING within the group above you proves Apple still re-ranks the
// phrase, but creates no vacancy; the group's MEMBERSHIP changing does. A
// change that reverts the next day is a blip, and counted as neither.
//
// Storage: docs/data/kw-slots/<cc>.json, one file per market.
//   { v, apps: [id...], days: [YYYY-MM-DD...],
//     terms: { kw: [[dayIdx, rank, [topIdx x10], [nearIdx x0-5]], ...] } }
// App ids are interned in `apps`; a term's rows are appended only when the
// (rank, top, near) tuple changed from its previous row, so a phrase whose
// head never moves costs a single row. Reading a day means taking the newest
// row at or before it. Rows older than KEEP_DAYS are folded away on write.
//
//   node scripts/kw-slots.mjs --backfill        replay git history of keywords.json
//   node scripts/kw-slots.mjs --report <cc>     welded heads, ceilings, grip per phrase
//
// Imported by keywords.mjs (writes today's row each merge) and aso.mjs (reads
// the statistics). Never throws on a missing file: an empty log grades nothing.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const slotsDir = path.join(repoRoot, "docs", "data", "kw-slots");
export const slotsFile = (cc) => path.join(slotsDir, `${cc}.json`);

export const KEEP_DAYS = 180;
// The window every statistic is read over, and the fewest observed days
// inside it before anything is said at all.
export const WINDOW_DAYS = 30;
export const MIN_DAYS = 7;
// An occupant present on this share of observed days holds the slot.
export const HOLD = 0.9;
// A group of two or more apps is a closed club only if the same members
// filled the top k on every day but at most this many. A count, not a share:
// the tolerance exists for the odd bad close (a fetch that dropped SnoreLab
// for one run) and one such day is one such day whether the window is
// eighteen days or thirty. Any looser and a nine-app head that admitted a
// newcomer three times would read as a wall, when three newcomers in a month
// is exactly what an opening looks like.
export const CLUB_MISSES = 1;
// Past page one a neighbour is held in place when its 10th-90th percentile
// position spans no more than this many places over the days it was seen.
export const LOCK_BAND = 2;

const empty = () => ({ v: 1, apps: [], days: [], terms: {} });

export async function readSlots(cc) {
  try {
    const j = JSON.parse(await readFile(slotsFile(cc), "utf8"));
    return j?.v === 1 ? j : empty();
  } catch {
    return empty();
  }
}

export async function writeSlots(cc, slots) {
  await mkdir(slotsDir, { recursive: true });
  await writeFile(slotsFile(cc), JSON.stringify(fold(slots)));
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameRow = (a, b) => a && b && a[1] === b[1] && same(a[2], b[2]) && same(a[3], b[3]);

function intern(slots, id) {
  let i = slots.apps.indexOf(id);
  if (i === -1) i = slots.apps.push(id) - 1;
  return i;
}
function dayIndex(slots, day) {
  const have = slots.days.indexOf(day);
  if (have !== -1) return have;
  const at = slots.days.findIndex((d) => d > day);
  if (at === -1) return slots.days.push(day) - 1;
  // A day inserted before the end shifts every row index at or past it.
  slots.days.splice(at, 0, day);
  for (const rows of Object.values(slots.terms)) for (const r of rows) if (r[0] >= at) r[0] += 1;
  return at;
}

// Upsert the closing row for `day` for every keyword in `rows`
// ({ kw: { rank, top: [id...], near: [id...] } }). Called every run, so the
// row for today is replaced each time and ends the day holding the last
// measured run. Only measured keywords should be passed: a carried-forward
// list would bank a false day of "nothing moved".
export function upsertDay(slots, day, rows) {
  const di = dayIndex(slots, day);
  for (const [kw, r] of Object.entries(rows)) {
    if (!r?.top?.length) continue;
    const row = [
      di,
      r.rank ?? null,
      r.top.map((id) => intern(slots, String(id))),
      (r.near ?? []).map((id) => intern(slots, String(id))),
    ];
    const list = (slots.terms[kw] ??= []);
    // Drop an existing row for this day, then append if it differs from the
    // row now last (which is the previous day's close, or nothing).
    const at = list.findIndex((x) => x[0] === di);
    if (at !== -1) list.splice(at, 1);
    const prev = list.length ? list[list.length - 1] : null;
    if (!sameRow(prev, row)) {
      list.push(row);
      list.sort((a, b) => a[0] - b[0]);
    }
  }
  return slots;
}

// Rebuild the log over the kept window: reconstruct each term's daily value
// by carry-forward, then re-encode change-only from the window's first day.
// Also drops app ids nothing references any more.
export function fold(slots, keepDays = KEEP_DAYS) {
  if (!slots.days.length) return slots;
  const last = slots.days[slots.days.length - 1];
  const cutoff = new Date(new Date(`${last}T00:00:00Z`) - keepDays * 864e5).toISOString().slice(0, 10);
  const days = slots.days.filter((d) => d >= cutoff);
  if (days.length === slots.days.length) return prune(slots);
  const out = { v: 1, apps: [], days, terms: {} };
  const reindex = (idx) => idx.map((i) => intern(out, slots.apps[i]));
  for (const [kw, rows] of Object.entries(slots.terms)) {
    let carry = null;
    const kept = [];
    for (const r of rows) {
      const d = slots.days[r[0]];
      if (d < cutoff) {
        carry = r;
        continue;
      }
      kept.push(r);
    }
    const list = [];
    // The value in force at the window's first day is the carry, re-dated.
    if (carry && (!kept.length || slots.days[kept[0][0]] !== days[0]))
      list.push([0, carry[1], reindex(carry[2]), reindex(carry[3])]);
    for (const r of kept) list.push([days.indexOf(slots.days[r[0]]), r[1], reindex(r[2]), reindex(r[3])]);
    if (list.length) out.terms[kw] = list;
  }
  return out;
}

// Drop unreferenced app ids without touching the day axis.
function prune(slots) {
  const used = new Set();
  for (const rows of Object.values(slots.terms)) for (const r of rows) for (const i of [...r[2], ...r[3]]) used.add(i);
  if (used.size === slots.apps.length) return slots;
  const map = new Map();
  const apps = [];
  for (const i of [...used].sort((a, b) => a - b)) map.set(i, apps.push(slots.apps[i]) - 1);
  for (const rows of Object.values(slots.terms))
    for (const r of rows) {
      r[2] = r[2].map((i) => map.get(i));
      r[3] = r[3].map((i) => map.get(i));
    }
  return { ...slots, apps };
}

// The last `windowDays` observed days for one keyword, as
// [{ day, rank, top: [id...], near: [id...] }], carry-forward filled so every
// observed day in the window has a value. Days before the term's first row
// are absent, not carried: nothing was measured.
export function daySeries(slots, kw, windowDays = WINDOW_DAYS) {
  const rows = slots?.terms?.[kw];
  if (!rows?.length || !slots.days.length) return [];
  const last = slots.days[slots.days.length - 1];
  const cutoff = new Date(new Date(`${last}T00:00:00Z`) - (windowDays - 1) * 864e5).toISOString().slice(0, 10);
  const out = [];
  let ri = 0;
  let cur = null;
  for (let di = 0; di < slots.days.length; di++) {
    while (ri < rows.length && rows[ri][0] <= di) cur = rows[ri++];
    if (!cur) continue;
    const day = slots.days[di];
    if (day < cutoff) continue;
    out.push({
      day,
      rank: cur[1],
      top: cur[2].map((i) => slots.apps[i]),
      near: cur[3].map((i) => slots.apps[i]),
    });
  }
  return out;
}

// Everything the difficulty score and the page need from one keyword's series.
// Returns null below MIN_DAYS. `me` is our own app id.
//
//   slots:    per slot 1-10: { pos, id, hold, seen } — modal occupant, share
//             of days it held that slot, and days the slot was observed
//   welded:   [{ pos, id, hold, setHold }] the apps holding slots 1..k as a
//             set on HOLD of days (any order), none of them us; `hold` is
//             each app's own grip on its modal slot, `setHold` the group's
//   club:     true when the head is welded as a set but not slot by slot —
//             the same apps, reordering among themselves
//   ceiling:  welded.length + 1, or null when we hold #1 ourselves
//   headroom: our latest rank minus the ceiling, floored at 0 (null unranked)
//   block:    the apps directly above us on the latest day, graded:
//             { size, locked: [id...], contested: [id...], judged, readable,
//               days, compared, reorders, vacancies, blips }
//             — `readable` is false when fewer than half the block was seen
//             on MIN_DAYS days; consumers should then say nothing about grip
//             — for rank <= 10 the block is slots 1..rank-1 and "locked"
//             means the app holds its slot; past page one it is the recorded
//             neighbour list and "locked" means the app's own position band
//             is narrow. `compared` is the number of consecutive-day pairs on
//             which our rank held still, the only pairs the counts are read on.
//   apps:     per app seen anywhere: { hold, band: [lo, hi], seen, obs }
//             (hold = share of its observed days at its modal position;
//             seen = share of window days it was observed; obs = that count)
export function slotStats(series, me) {
  if (!series || series.length < MIN_DAYS) return null;
  const days = series.length;
  const last = series[days - 1];

  // Per-slot occupancy.
  const occ = Array.from({ length: 10 }, () => new Map());
  const perApp = new Map(); // id -> { positions: [] }
  for (const d of series)
    d.top.forEach((id, i) => {
      if (i >= 10) return;
      occ[i].set(id, (occ[i].get(id) ?? 0) + 1);
      (perApp.get(id) ?? perApp.set(id, { positions: [] }).get(id)).positions.push(i + 1);
    });
  const slots = occ.map((m, i) => {
    const seen = [...m.values()].reduce((a, b) => a + b, 0);
    const [id, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    return { pos: i + 1, id, hold: seen ? n / seen : 0, seen };
  });
  // Welded head: the deepest k for which the SAME k apps filled slots 1..k
  // on HOLD of days, in any order, and we are not one of them. Set-based
  // rather than slot-based on purpose: five apps trading #1 through #5 among
  // themselves are a closed club, and a club is a wall — it reorders without
  // ever opening a slot. A single app holding #1 alone is the k = 1 case.
  let welded = [];
  let club = false;
  for (let k = 1; k <= 10; k++) {
    const sets = new Map();
    let observed = 0;
    for (const d of series) {
      if (d.top.length < k) continue;
      observed++;
      const key = [...d.top.slice(0, k)].sort().join(",");
      sets.set(key, (sets.get(key) ?? 0) + 1);
    }
    if (observed < MIN_DAYS) break;
    const [key, n] = [...sets.entries()].sort((a, b) => b[1] - a[1])[0];
    const members = key.split(",");
    const held = k === 1 ? n / observed >= HOLD : observed - n <= CLUB_MISSES;
    if (!held || members.includes(me)) continue;
    welded = members
      .map((id) => {
        const s = slots.find((x) => x.id === id) ?? null;
        const modal = s ? s.pos : last.top.indexOf(id) + 1 || k;
        return { pos: modal, id, hold: s?.id === id ? s.hold : 0, setHold: n / observed };
      })
      .sort((a, b) => a.pos - b.pos);
    club = welded.some((w) => w.hold < HOLD);
  }
  const weHold1 = last.rank === 1;
  const ceiling = weHold1 ? null : welded.length + 1;
  const headroom = last.rank == null || ceiling == null ? null : Math.max(0, last.rank - ceiling);

  // An app's absolute position on a day: its top-ten slot, or, when it sits
  // in the neighbour list, our rank minus its distance above us.
  const posOf = (d, id) => {
    const i = d.top.indexOf(id);
    if (i !== -1) return i + 1;
    const j = d.near.indexOf(id);
    return j !== -1 && d.rank != null ? d.rank - (d.near.length - j) : null;
  };
  const seenIds = new Set();
  for (const d of series) for (const id of [...d.top, ...d.near]) seenIds.add(id);
  const apps = {};
  for (const id of seenIds) {
    const positions = series.map((d) => posOf(d, id)).filter((p) => p != null);
    if (!positions.length) continue;
    const counts = new Map();
    for (const p of positions) counts.set(p, (counts.get(p) ?? 0) + 1);
    const modal = [...counts.values()].sort((a, b) => b - a)[0];
    const sorted = [...positions].sort((a, b) => a - b);
    apps[id] = {
      hold: modal / positions.length,
      band: [sorted[Math.floor(sorted.length * 0.1)], sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]],
      seen: positions.length / days,
      obs: positions.length,
    };
  }

  // The block above us on the latest day, and how it behaved over the window.
  //
  // Past page one we only ever see rivals through a five-app window that
  // moves with our own rank, so two guards keep our movement out of their
  // statistics: a neighbour is judged on its own position band across the
  // days it was seen at all, and membership changes are only counted between
  // consecutive days on which our rank did not move.
  let block = null;
  const setOf = (d) => (d.rank != null && d.rank <= 10 ? d.top.slice(0, Math.max(0, d.rank - 1)) : d.near);
  const ids = last.rank == null ? [] : setOf(last);
  if (ids.length) {
    const onPageOne = last.rank <= 10;
    const locked = [];
    const contested = [];
    for (const id of ids) {
      const a = apps[id];
      let held = false;
      if (a && a.obs >= MIN_DAYS) {
        if (onPageOne) {
          // Holds its current slot on the slot's own hold measure.
          const s = slots[last.top.indexOf(id)];
          held = Boolean(s && s.id === id && s.hold >= HOLD);
        } else {
          held = a.band[1] - a.band[0] <= LOCK_BAND;
        }
      }
      (held ? locked : contested).push(id);
    }
    // Day-over-day, our rank unchanged: same members in a different order, or
    // different members. A membership change reverted the next day is a blip.
    let reorders = 0;
    let vacancies = 0;
    let blips = 0;
    let compared = 0;
    const key = (d) => [...setOf(d)].sort().join(",");
    const obs = series.filter((d) => setOf(d).length);
    for (let i = 1; i < obs.length; i++) {
      if (obs[i].rank !== obs[i - 1].rank) continue;
      compared++;
      const a = setOf(obs[i - 1]);
      const b = setOf(obs[i]);
      if (same(a, b)) continue;
      if (key(obs[i - 1]) === key(obs[i])) reorders++;
      else if (i + 1 < obs.length && obs[i + 1].rank === obs[i].rank && key(obs[i + 1]) === key(obs[i - 1])) blips++;
      else vacancies++;
    }
    // Readable when at least half the block was seen on enough days to judge.
    // Past page one that is often not the case: a neighbour only enters the
    // record while it sits within five places of us, and we move. An
    // unreadable block is absence of evidence, and must not read as "open".
    const judged = ids.filter((id) => (apps[id]?.obs ?? 0) >= MIN_DAYS).length;
    const readable = judged * 2 >= ids.length;
    block = { size: ids.length, locked, contested, judged, readable, days: obs.length, compared, reorders, vacancies, blips };
  }

  return { days, slots, welded, club, ceiling, headroom, block, apps, rank: last.rank };
}

// --- CLI ---------------------------------------------------------------------

async function backfill() {
  const file = "docs/data/keywords.json";
  const git = (args, opts = {}) => execFileSync("git", ["-C", repoRoot, ...args], { maxBuffer: 256 * 1024 * 1024, ...opts });
  const commits = git(["log", "--format=%h", "--reverse", "--", file]).toString().trim().split("\n").filter(Boolean);
  // One state per market per day: the last commit of the day wins, which is
  // the day-close rule the live collector follows.
  const byDay = new Map(); // day -> { cc: rows }
  let parsed = 0;
  for (const c of commits) {
    let j;
    try {
      j = JSON.parse(git(["show", `${c}:${file}`]).toString());
    } catch {
      continue;
    }
    if (!j?.fetchedAt || !j.latest) continue;
    parsed++;
    const day = j.fetchedAt.slice(0, 10);
    const state = {};
    for (const [cc, kws] of Object.entries(j.latest)) {
      const rows = {};
      for (const [kw, v] of Object.entries(kws)) {
        if (!v?.top?.length) continue;
        rows[kw] = {
          rank: v.rank ?? null,
          top: v.top.map((e) => String(Array.isArray(e) ? e[0] : e)),
          near: (v.near ?? []).map((e) => String(Array.isArray(e) ? e[0] : e)),
        };
      }
      if (Object.keys(rows).length) state[cc] = rows;
    }
    byDay.set(day, state);
  }
  const days = [...byDay.keys()].sort();
  const perCc = {};
  for (const day of days) for (const [cc, rows] of Object.entries(byDay.get(day))) perCc[cc] = upsertDay(perCc[cc] ?? empty(), day, rows);
  for (const [cc, slots] of Object.entries(perCc)) {
    await writeSlots(cc, slots);
    const rows = Object.values(slots.terms).reduce((a, r) => a + r.length, 0);
    console.log(`${cc}: ${Object.keys(slots.terms).length} keywords, ${slots.days.length} days, ${rows} rows`);
  }
  console.log(`replayed ${parsed} commits across ${days.length} days (${days[0]} → ${days[days.length - 1]})`);
}

async function report(cc) {
  const config = JSON.parse(await readFile(path.join(repoRoot, "scripts", "keywords.json"), "utf8"));
  const kw = JSON.parse(await readFile(path.join(repoRoot, "docs", "data", "keywords.json"), "utf8"));
  const slots = await readSlots(cc);
  const name = (id) => (kw.names?.[cc]?.[id] ?? kw.apps?.[id]?.name ?? id).slice(0, 22);
  const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
  const rows = [];
  for (const term of Object.keys(slots.terms)) {
    const st = slotStats(daySeries(slots, term), String(config.appId));
    if (!st) continue;
    rows.push({ term, st, pop: kw.latest?.[cc]?.[term]?.pop ?? 0 });
  }
  rows.sort((a, b) => b.pop - a.pop);
  console.log(`${cc}: ${rows.length} phrases graded over the last ${WINDOW_DAYS} days (${slots.days.at(-1)})\n`);
  console.log(`${pad("phrase", 30)} rank  pop  ceil  room  block locked  vac  reord  (of N still days)  welded head`);
  for (const { term, st, pop } of rows) {
    const b = st.block;
    console.log(
      `${pad(term, 30)} ${pad(st.rank ?? "-", 4)} ${pad(pop, 4)} ${pad(st.ceiling ?? "—", 4)} ${pad(st.headroom ?? "—", 5)} ${pad(b?.size ?? "-", 5)} ${pad(b ? b.locked.length : "-", 6)} ${pad(b?.vacancies ?? "-", 4)} ${pad(b?.reorders ?? "-", 5)}  ${pad(b ? `(of ${b.compared})` : "", 18)} ${st.welded.map((w) => `${name(w.id)} ${Math.round(100 * w.hold)}%`).join(" | ")}`
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, cc] = process.argv.slice(2);
  if (mode === "--backfill") await backfill();
  else if (mode === "--report" && cc) await report(cc);
  else {
    console.log("usage: node scripts/kw-slots.mjs --backfill | --report <cc>");
    process.exit(1);
  }
}
