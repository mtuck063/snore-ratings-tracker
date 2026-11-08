// Build out custom product page localizations for the Breathing spot: one per App Store locale,
// with promotional text, keyword links, the two videos (uploaded once per language) and the
// locale's own screenshots mirrored from the default page (falling back to the primary locale).
// usage: ASC_KEY=admin node scripts/asc-cpp-localize.mjs <strings.json> <videoDir>
//   strings.json: { lang: { promo, keywords:[...], locales:[...] } }   (from strings_breathing.py)
//   videoDir holds breathing-short-<lang>-header-21x9-3840x1646.mp4 and ...-search-3x2-3840x2560.mp4
import { ascFetch, makeToken } from "./asc.mjs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const APP = "6751759381", APPVER = "cb7c2c5b-aa7c-429a-919d-966cd2031e05";
const CPP_VERSION = "03595dc3-e8b0-447c-97d3-6aa0269a3a62", PRIMARY_DEFAULT_LOC = "a0670f40-aacf-49c8-95a2-f73fb9ab41a0";
const [stringsPath, videoDir] = process.argv.slice(2);
const STR = JSON.parse(await readFile(stringsPath, "utf8"));
const token = await makeToken();
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const defaults = (await ascFetch(`/v1/appStoreVersions/${APPVER}/appStoreVersionLocalizations?limit=50`, token)).body.data;
const cppLocs = (await ascFetch(`/v1/appCustomProductPageVersions/${CPP_VERSION}/appCustomProductPageLocalizations?limit=50`, token)).body.data;
const primaryShots = (await ascFetch(`/v1/appStoreVersionLocalizations/${PRIMARY_DEFAULT_LOC}/placements?limit=200&sort=placementGroupPosition&include=image`, token)).body.data
  .filter(p => p.attributes.placementType === "APP_SCREENSHOT" && p.relationships?.image?.data?.id && !p.attributes.placementGroup.startsWith("WATCH"));

function uploadVideo(file, refName) {
  const out = execFileSync("node", [path.join(path.dirname(new URL(import.meta.url).pathname), "asc-asset-library-video.mjs"), APP, file, refName], { env: process.env }).toString();
  const id = out.trim().split("\n").pop();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("upload did not return an id:\n" + out);
  return id;
}
async function place(L, placementType, placementGroup, rel) {
  return ascFetch(`/v1/appAssetLibraryPlacements`, token, { method: "POST", body: JSON.stringify({
    data: { type: "appAssetLibraryPlacements", attributes: { placementType, placementGroup },
      relationships: { ...rel, appCustomProductPageLocalization: { data: { type: "appCustomProductPageLocalizations", id: L } } } } }) });
}

for (const [lang, S] of Object.entries(STR)) {
  if (lang === "en") continue;
  const header = uploadVideo(path.join(videoDir, `breathing-short-${lang}-header-21x9-3840x1646.mp4`), `Breathing spot header 21:9 ${lang} (2026-10-14)`);
  const search = uploadVideo(path.join(videoDir, `breathing-short-${lang}-search-3x2-3840x2560.mp4`), `Breathing spot search 3:2 ${lang} (2026-10-14)`);
  console.log(lang, "videos", header, search);
  for (const locale of S.locales) {
    let loc = cppLocs.find(l => l.attributes.locale === locale);
    if (!loc) {
      loc = (await ascFetch(`/v1/appCustomProductPageLocalizations`, token, { method: "POST", body: JSON.stringify({
        data: { type: "appCustomProductPageLocalizations", attributes: { locale, promotionalText: S.promo },
          relationships: { appCustomProductPageVersion: { data: { type: "appCustomProductPageVersions", id: CPP_VERSION } } } } }) })).body.data;
    } else {
      await ascFetch(`/v1/appCustomProductPageLocalizations/${loc.id}`, token, { method: "PATCH", body: JSON.stringify({
        data: { type: "appCustomProductPageLocalizations", id: loc.id, attributes: { promotionalText: S.promo } } }) });
    }
    const L = loc.id;
    const kw = await fetch(`https://api.appstoreconnect.apple.com/v1/appCustomProductPageLocalizations/${L}/relationships/searchKeywords`, { method: "POST", headers: H,
      body: JSON.stringify({ data: S.keywords.map(id => ({ type: "appKeywords", id })) }) });
    const have = (await ascFetch(`/v1/appCustomProductPageLocalizations/${L}/placements?limit=200&include=image`, token)).body.data;
    const types = new Set(have.map(p => p.attributes.placementType));
    if (!types.has("PRODUCT_PAGE_HEADER_ASSET")) await place(L, "PRODUCT_PAGE_HEADER_ASSET", "DEFAULT_PROFILE", { video: { data: { type: "appAssetLibraryVideos", id: header } } });
    if (!types.has("APP_STORE_SEARCH_RESULTS_ASSET")) await place(L, "APP_STORE_SEARCH_RESULTS_ASSET", "DEFAULT_PROFILE", { video: { data: { type: "appAssetLibraryVideos", id: search } } });
    // screenshots: this locale's own, else the primary locale's
    const def = defaults.find(d => d.attributes.locale === locale);
    let shots = def ? (await ascFetch(`/v1/appStoreVersionLocalizations/${def.id}/placements?limit=200&sort=placementGroupPosition&include=image`, token)).body.data
      .filter(p => p.attributes.placementType === "APP_SCREENSHOT" && p.relationships?.image?.data?.id && !p.attributes.placementGroup.startsWith("WATCH")) : [];
    const source = shots.length ? "own" : "primary";
    if (!shots.length) shots = primaryShots;
    const placed = new Set(have.filter(p => p.attributes.placementType === "APP_SCREENSHOT").map(p => p.relationships?.image?.data?.id));
    let n = 0;
    for (const p of shots) {
      if (placed.has(p.relationships.image.data.id)) continue;
      await place(L, "APP_SCREENSHOT", p.attributes.placementGroup, { image: { data: { type: "appAssetLibraryImages", id: p.relationships.image.data.id } } });
      n++;
    }
    const fin = (await ascFetch(`/v1/appCustomProductPageLocalizations/${L}/placements?limit=200`, token)).body.data;
    const count = {}; for (const p of fin) { const k = p.attributes.placementType.replace("APP_STORE_SEARCH_RESULTS_ASSET", "search").replace("PRODUCT_PAGE_HEADER_ASSET", "header").replace("APP_SCREENSHOT", "shot"); count[k] = (count[k] || 0) + 1; }
    const kws = (await ascFetch(`/v1/appCustomProductPageLocalizations/${L}/searchKeywords`, token)).body.data.map(k => k.id);
    console.log(`  ${locale} ${L} keywords(${kw.status}) ${kws.join(",")} | screenshots from ${source}, added ${n} | ${JSON.stringify(count)}`);
  }
}
