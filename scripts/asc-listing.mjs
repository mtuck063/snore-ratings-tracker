// Pull the live App Store listing from App Store Connect: name, subtitle and
// keyword field for every locale of the version currently on sale.
//
//   ASC_KEY=admin node scripts/asc-listing.mjs          # sync and report
//   ASC_KEY=admin node scripts/asc-listing.mjs --check  # report only, write nothing
//
// Writes scripts/listing-live.json (every locale, including the ones no market
// tracks) and copies each tracked market's keyword field into
// scripts/metadata.json, setting fieldUpdated when it changes. Title and
// subtitle in metadata.json stay owned by `aso.mjs --fetch`, which reads the
// storefront; this script only reports when the two disagree. Run
// `node scripts/aso.mjs` afterwards so aso.json picks up the change.
//
// Needs the admin key: the reporting key 403s on both localization endpoints,
// so this cannot run in CI.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { makeToken, ascFetch } from "./asc.mjs";

const APP_ID = "6751759381";
const here = path.dirname(fileURLToPath(import.meta.url));
const metadataFile = path.join(here, "metadata.json");
const liveFile = path.join(here, "listing-live.json");
const checkOnly = process.argv.includes("--check");

// Market code in metadata.json → App Store Connect locale.
const LOCALE = {
  us: "en-US", ca: "en-CA", gb: "en-GB", au: "en-AU",
  fr: "fr-FR", es: "es-ES", mx: "es-MX", br: "pt-BR", it: "it", de: "de-DE",
  nl: "nl-NL", jp: "ja", kr: "ko", cn: "zh-Hans", sa: "ar-SA",
};

const token = await makeToken();
const get = async (p) => (await ascFetch(p, token)).body;

// The newest version on sale. Versions list newest first, and an older one can
// still report READY_FOR_SALE for a while after its replacement ships.
const versions = await get(
  `/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&filter[appStoreState]=READY_FOR_SALE&limit=1&fields[appStoreVersions]=versionString`
);
const version = versions.data[0];
if (!version) throw new Error("no version on sale");

// The app info whose state is live. A pending one exists while a submission
// carries a name or subtitle change; it is not what the store shows yet.
const infos = await get(`/v1/apps/${APP_ID}/appInfos?fields[appInfos]=appStoreState,state`);
const info =
  infos.data.find((i) => ["READY_FOR_DISTRIBUTION", "READY_FOR_SALE"].includes(i.attributes.state ?? i.attributes.appStoreState)) ??
  infos.data[0];

const kw = await get(
  `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale,keywords&limit=50`
);
const names = await get(
  `/v1/appInfos/${info.id}/appInfoLocalizations?fields[appInfoLocalizations]=locale,name,subtitle&limit=50`
);

const locales = {};
for (const r of names.data) {
  const { locale, name, subtitle } = r.attributes;
  locales[locale] = { title: name ?? null, subtitle: subtitle ?? null, keywords: null };
}
for (const r of kw.data) {
  const { locale, keywords } = r.attributes;
  locales[locale] ??= { title: null, subtitle: null, keywords: null };
  locales[locale].keywords = keywords ?? null;
}
const sorted = Object.fromEntries(Object.keys(locales).sort().map((k) => [k, locales[k]]));

const today = new Date().toISOString().slice(0, 10);
const meta = JSON.parse(await readFile(metadataFile, "utf8"));
const changes = [];
const drift = [];
for (const [cc, locale] of Object.entries(LOCALE)) {
  const m = meta.markets[cc];
  const live = sorted[locale];
  if (!m || !live) {
    drift.push(`${cc}: ${!m ? "no market in metadata.json" : `no ${locale} localization in App Store Connect`}`);
    continue;
  }
  if ((m.keywordField ?? null) !== live.keywords) {
    changes.push(`${cc} keywords\n    was  ${m.keywordField ?? "(none)"}\n    now  ${live.keywords ?? "(none)"}`);
    m.keywordField = live.keywords;
    m.fieldUpdated = today;
  }
  if (m.title !== live.title) drift.push(`${cc} title: repo "${m.title}", live "${live.title}"`);
  if (m.subtitle !== live.subtitle) drift.push(`${cc} subtitle: repo "${m.subtitle}", live "${live.subtitle}"`);
}

console.log(`Live version ${version.attributes.versionString}, ${Object.keys(sorted).length} locales`);
console.log(changes.length ? `\nKeyword fields changed:\n  ${changes.join("\n  ")}` : "\nKeyword fields: all tracked markets match");
console.log(
  drift.length
    ? `\nTitle/subtitle drift (refresh with \`node scripts/aso.mjs --fetch\`):\n  ${drift.join("\n  ")}`
    : "Titles and subtitles: all tracked markets match"
);

if (checkOnly) process.exit(changes.length || drift.length ? 1 : 0);

await writeFile(
  liveFile,
  JSON.stringify(
    {
      _note: "Written by scripts/asc-listing.mjs from App Store Connect. Every locale of the version on sale; do not edit by hand.",
      version: version.attributes.versionString,
      syncedAt: today,
      locales: sorted,
    },
    null,
    2
  ) + "\n"
);
if (changes.length) await writeFile(metadataFile, JSON.stringify(meta, null, 2) + "\n");
console.log(`\nWrote ${path.relative(process.cwd(), liveFile)}${changes.length ? " and metadata.json" : ""}`);
