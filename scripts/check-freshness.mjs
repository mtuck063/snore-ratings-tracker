// Freshness watchdog.
//
// The collectors are built not to fail: a fetch that errors keeps the previous
// value so a blip can't fake a rating drop. The cost of that is a run which
// collects nothing still exits 0, and latest.json only moves when a rating
// moves, so "nothing changed today" and "dead since Tuesday" look identical
// from the data. status.json exists to separate the two, and this asserts it
// is actually advancing.
//
// Thresholds are generous on purpose. The hourly ratings cron only actually
// fires about 13 of its 24 slots — GitHub drops scheduled runs under load, and
// observed gaps between real runs reach 4.4h. Keyword gaps reach 8h. A bound
// close to that jitter would only teach us to ignore the alert, so ratings
// allows 12h and keywords 16h: comfortably past normal lateness, comfortably
// short of a day of genuine silence.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(repoRoot, "docs", "data");

// One file per collector, each with a single writer. They shared one before,
// and two writers on one line of compact JSON is a rebase conflict waiting for
// the two workflows to overlap.
const LIMITS = {
  ratings: { hours: 12, cadence: "hourly", file: "status-ratings.json" },
  keywords: { hours: 16, cadence: "every 6 hours", file: "status-keywords.json" },
};

const now = Date.now();
const problems = [];
for (const [key, { hours, cadence, file }] of Object.entries(LIMITS)) {
  let at = null;
  try {
    at = JSON.parse(await readFile(path.join(dataDir, file), "utf8")).at;
  } catch {
    problems.push(`${key}: ${file} is missing or unreadable (expected ${cadence}).`);
    continue;
  }
  if (!at) {
    problems.push(`${key}: no heartbeat recorded at all (expected ${cadence}).`);
    continue;
  }
  const age = (now - new Date(at)) / 3600e3;
  const line = `${key}: last run ${age.toFixed(1)}h ago (${at}), runs ${cadence}`;
  if (age > hours) problems.push(`${line} — over the ${hours}h limit.`);
  else console.log(`ok  ${line}`);
}

if (problems.length) {
  console.error("STALE:");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("all collectors are reporting on time");
