// Upload one event image to an appEventLocalization, replacing any existing one of the same type.
// usage: ASC_KEY=admin node scripts/asc-event-screenshot.mjs <localizationId> <EVENT_CARD|EVENT_DETAILS_PAGE> <file.png>
import { ascFetch, makeToken } from "./asc.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const [locId, assetType, file] = process.argv.slice(2);
const token = await makeToken();
const bytes = await readFile(file);
const md5 = createHash("md5").update(bytes).digest("hex");

// 1. remove an existing asset of this type on the localization
const existing = await ascFetch(`/v1/appEventLocalizations/${locId}/appEventScreenshots`, token);
for (const s of existing.body.data) {
  if (s.attributes.appEventAssetType === assetType) {
    const d = await fetch(`https://api.appstoreconnect.apple.com/v1/appEventScreenshots/${s.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (!d.ok) throw new Error(`delete failed ${d.status} ${await d.text()}`);
    console.log("deleted", s.id, s.attributes.fileName);
  }
}
// 2. reserve
const res = await ascFetch(`/v1/appEventScreenshots`, token, { method: "POST", body: JSON.stringify({
  data: { type: "appEventScreenshots",
    attributes: { fileName: path.basename(file), fileSize: bytes.length, appEventAssetType: assetType },
    relationships: { appEventLocalization: { data: { type: "appEventLocalizations", id: locId } } } } }) });
const shot = res.body.data;
// 3. upload parts
for (const op of shot.attributes.uploadOperations) {
  const headers = Object.fromEntries(op.requestHeaders.map(h => [h.name, h.value]));
  const r = await fetch(op.url, { method: op.method, headers, body: bytes.subarray(op.offset, op.offset + op.length) });
  if (!r.ok) throw new Error(`upload part failed ${r.status} ${await r.text()}`);
}
// 4. commit
await ascFetch(`/v1/appEventScreenshots/${shot.id}`, token, { method: "PATCH", body: JSON.stringify({
  data: { type: "appEventScreenshots", id: shot.id, attributes: { uploaded: true } } }) });
// 5. wait for delivery
for (let i = 0; i < 30; i++) {
  const st = (await ascFetch(`/v1/appEventScreenshots/${shot.id}`, token)).body.data.attributes.assetDeliveryState;
  if (st.state === "COMPLETE") { console.log("COMPLETE", shot.id, path.basename(file)); process.exit(0); }
  if (st.state === "FAILED") { console.error("FAILED", JSON.stringify(st)); process.exit(1); }
  await new Promise(r => setTimeout(r, 3000));
}
console.error("timed out waiting for delivery", shot.id); process.exit(1);
