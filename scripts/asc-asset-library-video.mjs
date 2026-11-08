// Upload a video to the app's Asset Library (category CREATIVE_ASSETS) and wait for processing.
// usage: ASC_KEY=admin node scripts/asc-asset-library-video.mjs <appId> <file.mp4> [referenceName]
// Prints the appAssetLibraryVideos id. Placement onto a page is a separate POST (see asc-asset-placement.mjs).
import { ascFetch, makeToken } from "./asc.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const [appId, file, refName] = process.argv.slice(2);
const token = await makeToken();
const bytes = await readFile(file);
const res = await ascFetch(`/v1/appAssetLibraryVideos`, token, { method: "POST", body: JSON.stringify({
  data: { type: "appAssetLibraryVideos",
    attributes: { fileName: path.basename(file), fileSize: bytes.length, category: "CREATIVE_ASSETS", referenceName: refName || path.basename(file) },
    relationships: { assetLibrary: { data: { type: "appAssetLibraries", id: appId } } } } }) });
const video = res.body.data;
console.log("reserved", video.id, video.attributes.state, video.attributes.uploadOperations.length, "parts");
for (const op of video.attributes.uploadOperations) {
  const headers = Object.fromEntries(op.requestHeaders.map(h => [h.name, h.value]));
  const r = await fetch(op.url, { method: op.method, headers, body: bytes.subarray(op.offset, op.offset + op.length) });
  if (!r.ok) throw new Error(`part upload failed ${r.status} ${await r.text()}`);
}
await ascFetch(`/v1/appAssetLibraryVideos/${video.id}`, token, { method: "PATCH", body: JSON.stringify({
  data: { type: "appAssetLibraryVideos", id: video.id, attributes: { uploaded: true } } }) });
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const v = (await ascFetch(`/v1/appAssetLibraryVideos/${video.id}`, token)).body.data.attributes;
  if (!["AWAITING_UPLOAD", "UPLOAD_COMPLETE"].includes(v.state)) {
    console.log("state", v.state, "spec", v.specId, JSON.stringify(v.stateDetails));
    console.log(video.id);
    process.exit(v.state === "FAILED" ? 1 : 0);
  }
}
throw new Error("timed out waiting for processing");
