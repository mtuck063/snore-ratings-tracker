// Replace the header and search videos (and promotional text) on the custom page localizations of
// the given languages, after a re-render. usage:
//   ASC_KEY=admin node scripts/asc-cpp-replace-videos.mjs <strings.json> <videoDir> <lang> [lang...]
import { ascFetch, makeToken } from "./asc.mjs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const APP = "6751759381", CPP_VERSION = "03595dc3-e8b0-447c-97d3-6aa0269a3a62";
const [stringsPath, videoDir, ...langs] = process.argv.slice(2);
const STR = JSON.parse(await readFile(stringsPath, "utf8"));
const token = await makeToken();
const cppLocs = (await ascFetch(`/v1/appCustomProductPageVersions/${CPP_VERSION}/appCustomProductPageLocalizations?limit=50`, token)).body.data;
const here = path.dirname(new URL(import.meta.url).pathname);
const upload = (file, ref) => {
  const out = execFileSync("node", [path.join(here, "asc-asset-library-video.mjs"), APP, file, ref], { env: process.env }).toString();
  const id = out.trim().split("\n").pop(); if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(out); return id;
};
for (const lang of langs) {
  const S = STR[lang]; const tag = lang === "en" ? "breathing-short" : `breathing-short-${lang}`;
  const header = upload(path.join(videoDir, `${tag}-header-21x9-3840x1646.mp4`), `Breathing spot header 21:9 ${lang} (2026-10-14 r2)`);
  const search = upload(path.join(videoDir, `${tag}-search-3x2-3840x2560.mp4`), `Breathing spot search 3:2 ${lang} (2026-10-14 r2)`);
  for (const locale of S.locales) {
    const loc = cppLocs.find(l => l.attributes.locale === locale); if (!loc) { console.log("missing localization", locale); continue; }
    await ascFetch(`/v1/appCustomProductPageLocalizations/${loc.id}`, token, { method: "PATCH", body: JSON.stringify({
      data: { type: "appCustomProductPageLocalizations", id: loc.id, attributes: { promotionalText: S.promo } } }) });
    const have = (await ascFetch(`/v1/appCustomProductPageLocalizations/${loc.id}/placements?limit=200`, token)).body.data
      .filter(p => ["PRODUCT_PAGE_HEADER_ASSET", "APP_STORE_SEARCH_RESULTS_ASSET"].includes(p.attributes.placementType));
    for (const p of have) await fetch(`https://api.appstoreconnect.apple.com/v1/appAssetLibraryPlacements/${p.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    for (const [type, vid] of [["PRODUCT_PAGE_HEADER_ASSET", header], ["APP_STORE_SEARCH_RESULTS_ASSET", search]]) {
      await ascFetch(`/v1/appAssetLibraryPlacements`, token, { method: "POST", body: JSON.stringify({
        data: { type: "appAssetLibraryPlacements", attributes: { placementType: type, placementGroup: "DEFAULT_PROFILE" },
          relationships: { video: { data: { type: "appAssetLibraryVideos", id: vid } },
            appCustomProductPageLocalization: { data: { type: "appCustomProductPageLocalizations", id: loc.id } } } } }) });
    }
    console.log(lang, locale, "replaced header+search, promo", [...S.promo].length, "chars");
  }
}
