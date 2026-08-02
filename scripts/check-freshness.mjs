// Freshness watchdog.
//
// The collectors are built not to fail: a fetch that errors keeps the previous
// value so a blip can't fake a rating drop. The cost of that is a run which
// collects nothing still exits 0, and latest.json only moves when a rating
// moves, so "nothing changed today" and "dead since Tuesday" look identical
// from the data. status.json exists to separate the two, and this asserts it
// is actually advancing.
//
// Thresholds are generous on purpose. GitHub lands scheduled runs 1.5-3.5h
// late in practice, and observed keyword gaps reach 8h, so a tight bound would
// only teach us to ignore the alert.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const statusFile = path.join(repoRoot, "docs", "data", "status.json");

const LIMITS = {
  ratings: { hours: 6, cadence: "hourly" },
  keywords: { hours: 16, cadence: "every 6 hours" },
};

let status;
try {
  status = JSON.parse(await readFile(statusFile, "utf8"));
} catch {
  console.error("STALE: docs/data/status.json is missing or unreadable.");
  console.error("No collector has written a heartbeat since monitoring was added.");
  process.exit(1);
}

const now = Date.now();
const problems = [];
for (const [key, { hours, cadence }] of Object.entries(LIMITS)) {
  const at = status[key]?.at;
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
