// Release notes ("What's New in This Version") for every locale, through the
// App Store Connect API.
//
//   node scripts/whatsnew.mjs --init     # write the release-notes/<version>.json skeleton
//   node scripts/whatsnew.mjs            # dry run: validate the file, show what would change
//   node scripts/whatsnew.mjs --apply    # write the notes into App Store Connect
//
// The notes live in release-notes/<version>.json, one key per App Store
// locale, checked into git for the same reason metadata.json is: the file's
// history is the log. A value of "@en-US" copies another locale's text, so
// shared translations are written once; --init prefills the aliases by
// grouping the previous version's notes, which is where the sharing is
// already visible. Every locale on the version must resolve to a non-empty
// text or nothing at all is written: a missing translation fails loudly,
// a stale one never ships silently.
//
// The script finds the one version in an editable state by itself; there is
// never more than one. Apple locks whatsNew the moment a version goes live,
// so run this between creating the version and submitting it.
//
// appStoreVersionLocalizations is denied to the reporting key outright, reads
// included, so this defaults to the admin key (metadata writes need it anyway).
process.env.ASC_KEY ??= "admin";

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ascFetch, makeToken } from "./asc.mjs";

const APP_ID = "6751759381";
const NOTES_DIR = path.join(import.meta.dirname, "..", "release-notes");
const MAX_CHARS = 4000;
// The states in which version metadata is still writable.
const EDITABLE = new Set([
  "PREPARE_FOR_SUBMISSION",
  "METADATA_REJECTED",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "INVALID_BINARY",
]);
// When a group of locales shares one text, the alias head to prefer.
const PREFERRED_HEADS = new Set(["en-US", "es-ES", "fr-FR", "pt-BR", "zh-Hans"]);

async function pages(apiPath, token) {
  const rows = [];
  let next = apiPath;
  while (next) {
    const { body } = await ascFetch(next, token);
    rows.push(...(body.data ?? []));
    next = body.links?.next;
  }
  return rows;
}

async function versions(token) {
  const { body } = await ascFetch(
    `/v1/apps/${APP_ID}/appStoreVersions?limit=10&fields[appStoreVersions]=versionString,appStoreState`,
    token
  );
  return body.data.map((v) => ({
    id: v.id,
    version: v.attributes.versionString,
    state: v.attributes.appStoreState,
  }));
}

async function localizations(versionId, token) {
  const rows = await pages(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50&fields[appStoreVersionLocalizations]=locale,whatsNew`,
    token
  );
  return rows
    .map((r) => ({ id: r.id, locale: r.attributes.locale, whatsNew: r.attributes.whatsNew ?? "" }))
    .sort((a, b) => a.locale.localeCompare(b.locale));
}

// Resolve the file into { locale: text }. One alias hop only: an alias must
// point at a locale that carries its own text.
function resolveNotes(raw, locales) {
  const problems = [];
  const entries = Object.entries(raw).filter(([k]) => !k.startsWith("_"));
  const have = new Set(entries.map(([k]) => k));

  for (const locale of locales) {
    if (!have.has(locale)) problems.push(`${locale}: missing from the file`);
  }
  const known = new Set(locales);
  for (const [locale] of entries) {
    if (!known.has(locale)) problems.push(`${locale}: in the file but not on this version`);
  }

  const notes = {};
  for (const [locale, value] of entries) {
    if (typeof value !== "string") {
      problems.push(`${locale}: value is not a string`);
      continue;
    }
    let text = value;
    if (value.startsWith("@")) {
      const target = raw[value.slice(1)];
      if (typeof target !== "string" || target.startsWith("@") || !target.trim()) {
        problems.push(`${locale}: alias "${value}" does not point at a locale with its own text`);
        continue;
      }
      text = target;
    }
    if (!text.trim()) problems.push(`${locale}: empty`);
    else if (text.length > MAX_CHARS) problems.push(`${locale}: ${text.length} chars, limit ${MAX_CHARS}`);
    else notes[locale] = text;
  }
  return { notes, problems };
}

const args = process.argv.slice(2);
const mode = args.includes("--apply") ? "apply" : args.includes("--init") ? "init" : "dry";

const token = await makeToken();
const all = await versions(token);
const editable = all.filter((v) => EDITABLE.has(v.state));
if (editable.length !== 1) {
  const seen = all.map((v) => `${v.version} ${v.state}`).join(", ");
  console.error(
    editable.length === 0
      ? `no version in an editable state (${seen}); create the new version in App Store Connect first`
      : `more than one editable version (${editable.map((v) => v.version).join(", ")}); refusing to guess`
  );
  process.exit(1);
}
const version = editable[0];
const locs = await localizations(version.id, token);
const notesPath = path.join(NOTES_DIR, `${version.version}.json`);
console.log(`${version.version} (${version.state}), ${locs.length} locales`);

if (mode === "init") {
  const exists = await readFile(notesPath, "utf8").then(() => true, () => false);
  if (exists) {
    console.error(`${notesPath} already exists; edit it instead`);
    process.exit(1);
  }
  // Derive the alias structure from the previous version: locales that shipped
  // identical notes there share one text here too.
  const previous = all.find((v) => v.state === "READY_FOR_SALE");
  const groups = new Map(); // text -> [locale]
  if (previous) {
    for (const l of await localizations(previous.id, token)) {
      if (!l.whatsNew) continue;
      groups.set(l.whatsNew, [...(groups.get(l.whatsNew) ?? []), l.locale]);
    }
  }
  const aliasOf = {};
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const head = members.find((m) => PREFERRED_HEADS.has(m)) ?? members[0];
    for (const m of members) if (m !== head) aliasOf[m] = head;
  }
  const skeleton = {
    _note: `What's New for ${version.version}, one key per App Store locale. "@xx-XX" copies that locale's text. Fill every ""; the script refuses to apply a partial file.`,
  };
  for (const l of locs) skeleton[l.locale] = aliasOf[l.locale] ? `@${aliasOf[l.locale]}` : "";
  await mkdir(NOTES_DIR, { recursive: true });
  await writeFile(notesPath, JSON.stringify(skeleton, null, 2) + "\n");
  console.log(`wrote ${notesPath}${previous ? `, aliases grouped from ${previous.version}` : ""}`);
  process.exit(0);
}

const raw = await readFile(notesPath, "utf8").then(JSON.parse, () => null);
if (!raw) {
  console.error(`no ${notesPath}; run with --init to create the skeleton`);
  process.exit(1);
}
const { notes, problems } = resolveNotes(raw, locs.map((l) => l.locale));
if (problems.length) {
  console.error(`refusing to ${mode === "apply" ? "apply" : "grade"} ${notesPath}:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const changed = locs.filter((l) => notes[l.locale] !== l.whatsNew);
for (const l of locs) {
  const text = notes[l.locale];
  const mark = notes[l.locale] === l.whatsNew ? "unchanged" : `${text.length} chars`;
  console.log(`  ${l.locale.padEnd(8)} ${mark.padEnd(10)} ${text.split("\n")[0].slice(0, 60)}`);
}
if (!changed.length) {
  console.log("everything already matches; nothing to write");
  process.exit(0);
}
if (mode === "dry") {
  console.log(`${changed.length} locale(s) would change; run with --apply to write them`);
  process.exit(0);
}

for (const l of changed) {
  await ascFetch(`/v1/appStoreVersionLocalizations/${l.id}`, token, {
    method: "PATCH",
    body: JSON.stringify({
      data: {
        type: "appStoreVersionLocalizations",
        id: l.id,
        attributes: { whatsNew: notes[l.locale] },
      },
    }),
  });
  console.log(`  ${l.locale} written`);
}
console.log(`${changed.length} locale(s) updated on ${version.version}`);
