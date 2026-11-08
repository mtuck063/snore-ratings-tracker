// Copy the screenshot sets of an App Store version localization onto a custom product page
// localization: downloads each image from Apple's CDN at its original size and re-uploads it.
// usage: ASC_KEY=admin node scripts/asc-cpp-copy-screenshots.mjs <appStoreVersionLocalizationId> <cppLocalizationId>
import { ascFetch, makeToken } from "./asc.mjs";
import { createHash } from "node:crypto";

const [SRC, DST] = process.argv.slice(2);
const token = await makeToken();
const src = (await ascFetch(`/v1/appStoreVersionLocalizations/${SRC}/appScreenshotSets?include=appScreenshots`, token)).body;
const inc = Object.fromEntries((src.included || []).map(i => [i.id, i]));
const existing = (await ascFetch(`/v1/appCustomProductPageLocalizations/${DST}/appScreenshotSets`, token)).body.data;
for (const set of src.data) {
  const type = set.attributes.screenshotDisplayType;
  const shots = (set.relationships.appScreenshots?.data || []).map(r => inc[r.id]);
  if (existing.some(e => e.attributes.screenshotDisplayType === type)) { console.log("skip, set exists:", type); continue; }
  const made = (await ascFetch(`/v1/appScreenshotSets`, token, { method: "POST", body: JSON.stringify({
    data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: type },
      relationships: { appCustomProductPageLocalization: { data: { type: "appCustomProductPageLocalizations", id: DST } } } } }) })).body.data;
  console.log("set", type, made.id, shots.length, "to copy");
  for (const sh of shots) {
    const { fileName, imageAsset } = sh.attributes;
    const url = imageAsset.templateUrl.replace("{w}", imageAsset.width).replace("{h}", imageAsset.height).replace("{f}", "png");
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download failed ${r.status} ${url}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    const res = (await ascFetch(`/v1/appScreenshots`, token, { method: "POST", body: JSON.stringify({
      data: { type: "appScreenshots", attributes: { fileName, fileSize: bytes.length },
        relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: made.id } } } } }) })).body.data;
    for (const op of res.attributes.uploadOperations) {
      const headers = Object.fromEntries(op.requestHeaders.map(h => [h.name, h.value]));
      const u = await fetch(op.url, { method: op.method, headers, body: bytes.subarray(op.offset, op.offset + op.length) });
      if (!u.ok) throw new Error(`part upload failed ${u.status} ${await u.text()}`);
    }
    await ascFetch(`/v1/appScreenshots/${res.id}`, token, { method: "PATCH", body: JSON.stringify({
      data: { type: "appScreenshots", id: res.id, attributes: { uploaded: true, sourceFileChecksum: createHash("md5").update(bytes).digest("hex") } } }) });
    console.log("   uploaded", fileName, bytes.length);
  }
}
// wait for processing, then report
for (let i = 0; i < 36; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const sets = (await ascFetch(`/v1/appCustomProductPageLocalizations/${DST}/appScreenshotSets?include=appScreenshots`, token)).body;
  const inc2 = Object.fromEntries((sets.included || []).map(i => [i.id, i]));
  const states = sets.data.map(s => [s.attributes.screenshotDisplayType, (s.relationships.appScreenshots?.data || []).map(r => inc2[r.id]?.attributes?.assetDeliveryState?.state)]);
  const pending = states.some(([, st]) => st.some(x => x !== "COMPLETE" && x !== "FAILED"));
  if (!pending || i === 35) { for (const [t, st] of states) console.log(t, st.length, [...new Set(st)].join("/")); break; }
}
