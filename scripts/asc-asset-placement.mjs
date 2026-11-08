// Place an Asset Library video or image onto a custom product page localization.
// usage: ASC_KEY=admin node scripts/asc-asset-placement.mjs <cppLocalizationId> <placementType> <video|image> <assetId> [placementGroup]
// e.g.   ... c5ed7f3f-... PRODUCT_PAGE_HEADER_ASSET video 92400019-... DEFAULT_PROFILE
import { ascFetch, makeToken } from "./asc.mjs";
const [locId, placementType, kind, assetId, group = "DEFAULT_PROFILE"] = process.argv.slice(2);
const token = await makeToken();
const rel = kind === "video" ? { video: { data: { type: "appAssetLibraryVideos", id: assetId } } }
                             : { image: { data: { type: "appAssetLibraryImages", id: assetId } } };
const res = await ascFetch(`/v1/appAssetLibraryPlacements`, token, { method: "POST", body: JSON.stringify({
  data: { type: "appAssetLibraryPlacements", attributes: { placementType, placementGroup: group },
    relationships: { ...rel, appCustomProductPageLocalization: { data: { type: "appCustomProductPageLocalizations", id: locId } } } } }) });
const p = res.body.data;
console.log(p.id, p.attributes.placementType, p.attributes.mediaType, p.attributes.state, JSON.stringify(p.attributes.stateDetails));
