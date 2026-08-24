// App Store Connect API client.
//
// Usage:
//   node scripts/asc.mjs /v1/apps
//   node scripts/asc.mjs '/v1/apps/123/customerReviews?limit=5'
//   node scripts/asc.mjs --all /v1/apps          # follow pagination links
//   node scripts/asc.mjs post /v1/analyticsReportRequests '{"data":{...}}'
//   node scripts/asc.mjs patch /v1/appStoreVersionLocalizations/ID '{"data":{...}}'
//
// Credentials live outside the repo in ~/.config/appstoreconnect/config.json
// ({ default, keys: { name: { keyId, issuerId, keyPath } } }) so no key ever
// appears in git or in this file. The default "reporting" key (Sales and
// Reports role) covers reviews and sales reports; ASC_KEY=admin selects the
// admin key, which the Analytics Reports API requires.
import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const BASE = "https://api.appstoreconnect.apple.com";
const configPath = path.join(os.homedir(), ".config", "appstoreconnect", "config.json");

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export async function makeToken() {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const name = process.env.ASC_KEY ?? config.default;
  const { keyId, issuerId, keyPath } = config.keys[name] ?? {};
  if (!keyId) {
    throw new Error(`no key named "${name}" in ${configPath} (have: ${Object.keys(config.keys)})`);
  }
  const key = createPrivateKey(await readFile(keyPath, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  // Apple rejects tokens valid longer than 20 minutes; 10 leaves slack for clock skew.
  const payload = b64url(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })
  );
  // ES256 JWTs need the raw r||s signature, not DER, hence ieee-p1363.
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${b64url(sig)}`;
}

export async function ascFetch(apiPath, token, { method = "GET", body } = {}) {
  token ??= await makeToken();
  const url = apiPath.startsWith("http") ? apiPath : BASE + apiPath;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body,
  });
  const raw = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}\n${raw.toString("utf8")}`);
  }
  // Sales/finance report endpoints return gzipped TSV, everything else JSON.
  if (res.headers.get("content-type")?.includes("gzip")) {
    return { kind: "tsv", body: gunzipSync(raw).toString("utf8") };
  }
  return { kind: "json", body: JSON.parse(raw.toString("utf8")) };
}

// Everything below is the CLI; the guard keeps it inert when another script
// imports ascFetch or makeToken.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const verb = { post: "POST", patch: "PATCH" }[args[0]];
  const followAll = args[0] === "--all";
  const apiPath = verb || followAll ? args[1] : args[0];
  if (!apiPath) {
    console.error("usage: node scripts/asc.mjs [--all|post|patch] </v1/path?query> [json-body]");
    process.exit(2);
  }

  const token = await makeToken();
  let { kind, body } = await ascFetch(
    apiPath,
    token,
    verb ? { method: verb, body: args[2] } : {}
  );
  if (kind === "tsv") {
    process.stdout.write(body);
  } else if (followAll) {
    const data = body.data ?? [];
    let next = body.links?.next;
    while (next) {
      const page = (await ascFetch(next, token)).body;
      data.push(...(page.data ?? []));
      next = page.links?.next;
    }
    console.log(JSON.stringify({ data, meta: { total: data.length } }, null, 2));
  } else {
    console.log(JSON.stringify(body, null, 2));
  }
}
