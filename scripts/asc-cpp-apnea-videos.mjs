// Replace the header and search videos on the Sleep Apnea & CPAP custom product page with the 2026-10-24
// walkthrough (SnoreRecorder docs/design/appstore-creative-assets/remotion, build-apnea.sh), one set per
// language, on a draft version of the page. Promotional text is left as it is.
// usage: ASC_KEY=admin node scripts/asc-cpp-apnea-videos.mjs <cppVersionId> <apnea-v1 dir> [lang ...]
//   <apnea-v1 dir>/<lang>/header-21x9-3840x1646.mov and search-3x2-3840x2560.mov
// Only a version in PREPARE_FOR_SUBMISSION is accepted. An approved (live) version refuses unreviewed videos
// with a 409, and the old placements are deleted before the new ones are posted, so running this against the
// live version stripped en-US of its videos on 2026-10-24 until they were put back. New videos go live
// when the draft version passes review. Videos already in the Asset Library under the same reference name
// (from an earlier, interrupted run) are reused rather than uploaded again.
import { ascFetch, makeToken } from "./asc.mjs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const APP = "6751759381";
// Which page localizations each language's set goes to (src/apneaStrings.ts `locales`).
const LOCALES = {
  en: ["en-US", "en-CA", "en-GB", "en-AU"], de: ["de-DE"], es: ["es-ES", "es-MX"], it: ["it"], ko: ["ko"],
  nl: ["nl-NL"], "pt-BR": ["pt-BR"], "pt-PT": ["pt-PT"], ru: ["ru"],
};
const TYPES = ["PRODUCT_PAGE_HEADER_ASSET", "APP_STORE_SEARCH_RESULTS_ASSET"];
const [CPP_VERSION, root, ...picked] = process.argv.slice(2);
const langs = picked.length ? picked : Object.keys(LOCALES);
const token = await makeToken();
const state = (await ascFetch(`/v1/appCustomProductPageVersions/${CPP_VERSION}`, token)).body.data.attributes.state;
if (state !== "PREPARE_FOR_SUBMISSION") throw new Error(`version ${CPP_VERSION} is ${state}; create a new version of the page and pass its id`);
const library = [];
for (let url = `/v1/appAssetLibraries/${APP}/videos?limit=200`; url; ) {
  const r = (await ascFetch(url, token)).body;
  library.push(...r.data);
  url = r.links?.next?.replace("https://api.appstoreconnect.apple.com", "");
}
const cppLocs = (await ascFetch(`/v1/appCustomProductPageVersions/${CPP_VERSION}/appCustomProductPageLocalizations?limit=50`, token)).body.data;
const here = path.dirname(new URL(import.meta.url).pathname);
const upload = (file, ref) => {
  const have = library.find(v => v.attributes.referenceName === ref && v.attributes.state !== "FAILED");
  if (have) { console.log("   reusing", have.id, ref); return have.id; }
  const out = execFileSync("node", [path.join(here, "asc-asset-library-video.mjs"), APP, file, ref], { env: process.env }).toString();
  const id = out.trim().split("\n").pop();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(out);
  console.log("  ", out.trim().split("\n").slice(-2, -1)[0]);
  return id;
};

for (const lang of langs) {
  const header = upload(path.join(root, lang, "header-21x9-3840x1646.mov"), `Apnea walkthrough header 21:9 ${lang} (2026-10-24)`);
  const search = upload(path.join(root, lang, "search-3x2-3840x2560.mov"), `Apnea walkthrough search 3:2 ${lang} (2026-10-24)`);
  for (const locale of LOCALES[lang]) {
    const loc = cppLocs.find(l => l.attributes.locale === locale);
    if (!loc) { console.log("missing localization", locale); continue; }
    const have = (await ascFetch(`/v1/appCustomProductPageLocalizations/${loc.id}/placements?limit=200`, token)).body.data
      .filter(p => TYPES.includes(p.attributes.placementType));
    for (const p of have) {
      const r = await fetch(`https://api.appstoreconnect.apple.com/v1/appAssetLibraryPlacements/${p.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`delete ${p.id} failed ${r.status} ${await r.text()}`);
    }
    for (const [type, vid] of [[TYPES[0], header], [TYPES[1], search]]) {
      const res = await ascFetch(`/v1/appAssetLibraryPlacements`, token, { method: "POST", body: JSON.stringify({
        data: { type: "appAssetLibraryPlacements", attributes: { placementType: type, placementGroup: "DEFAULT_PROFILE" },
          relationships: { video: { data: { type: "appAssetLibraryVideos", id: vid } },
            appCustomProductPageLocalization: { data: { type: "appCustomProductPageLocalizations", id: loc.id } } } } }) });
      const a = res.body.data?.attributes;
      console.log(lang, locale, type, a ? `${a.state} ${JSON.stringify(a.stateDetails)}` : JSON.stringify(res.body).slice(0, 300));
    }
  }
}
