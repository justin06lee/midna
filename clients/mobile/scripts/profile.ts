/**
 * The App Store profile, made to match app.json through the App Store Connect
 * API: each entitlement app.json asks for is turned on for the app id, and the
 * profile is made again (Apple can't edit one) and installed, so the export
 * signs. testflight.sh runs this when the installed profile lacks an
 * entitlement. It needs what testflight.sh needs: ASC_KEY_ID, ASC_ISSUER_ID,
 * ASC_KEY_PATH, PROFILE.
 *
 *   bun scripts/profile.ts
 */
import { createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = (k: string) => process.env[k] || (console.error(`profile: ${k} is not set`), process.exit(1));
const keyId = env("ASC_KEY_ID");
const issuer = env("ASC_ISSUER_ID");
const keyPath = process.env.ASC_KEY_PATH || join(homedir(), ".appstoreconnect/private_keys", `AuthKey_${keyId}.p8`);
const profileName = process.env.PROFILE || "midna App Store";
const app = JSON.parse(readFileSync(join(import.meta.dir, "../app.json"), "utf8")).expo.ios;
const bundleId: string = app.bundleIdentifier;

/** Entitlements app.json may ask for, and the capability that grants each. One left out here is turned on by hand. */
const CAPABILITIES: Record<string, string> = {
  "aps-environment": "PUSH_NOTIFICATIONS",
  "com.apple.developer.usernotifications.time-sensitive": "USERNOTIFICATIONS_TIMESENSITIVE",
};

function jwt(): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "ES256", kid: keyId, typ: "JWT" })}.${b64({ iss: issuer, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
  const sig = sign("sha256", Buffer.from(unsigned), { key: createPrivateKey(readFileSync(keyPath, "utf8")), dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${unsigned}.${sig}`;
}

const token = jwt();
async function asc<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const ids = await asc("GET", `/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&limit=50`);
const bundle = ids.data.find((b: any) => b.attributes.identifier === bundleId);
if (!bundle) throw new Error(`no app id ${bundleId} on the team`);

const have = new Set((await asc("GET", `/v1/bundleIds/${bundle.id}/bundleIdCapabilities`)).data.map((c: any) => c.attributes.capabilityType));
for (const entitlement of Object.keys(app.entitlements ?? {})) {
  const capability = CAPABILITIES[entitlement];
  if (!capability) {
    console.error(`profile: turn on the capability for ${entitlement} by hand (developer site → Identifiers → ${bundleId}), then run this again`);
    process.exit(1);
  }
  if (have.has(capability)) continue;
  console.log(`turning on ${capability} for ${bundleId}`);
  await asc("POST", "/v1/bundleIdCapabilities", {
    data: { type: "bundleIdCapabilities", attributes: { capabilityType: capability }, relationships: { bundleId: { data: { type: "bundleIds", id: bundle.id } } } },
  });
}

// The profile again, for the same certificates: the old one is deleted first, since two can't share a name.
const old = (await asc("GET", `/v1/profiles?filter[name]=${encodeURIComponent(profileName)}&limit=10`)).data.filter((p: any) => p.attributes.name === profileName);
let certificates: Array<{ type: "certificates"; id: string }> = [];
for (const p of old) certificates.push(...(await asc("GET", `/v1/profiles/${p.id}/certificates`)).data.map((c: any) => ({ type: "certificates" as const, id: c.id })));
if (!certificates.length) {
  const dist = (await asc("GET", "/v1/certificates?filter[certificateType]=DISTRIBUTION&limit=10")).data;
  certificates = dist.map((c: any) => ({ type: "certificates" as const, id: c.id }));
}
if (!certificates.length) throw new Error("no Apple Distribution certificate on the team (docs/mobile.md)");
certificates = [...new Map(certificates.map((c) => [c.id, c])).values()];
for (const p of old) {
  console.log(`deleting the old profile "${profileName}" (${p.attributes.uuid})`);
  await asc("DELETE", `/v1/profiles/${p.id}`);
}
const made = await asc("POST", "/v1/profiles", {
  data: {
    type: "profiles",
    attributes: { name: profileName, profileType: "IOS_APP_STORE" },
    relationships: { bundleId: { data: { type: "bundleIds", id: bundle.id } }, certificates: { data: certificates } },
  },
});
const dir = join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles");
mkdirSync(dir, { recursive: true });
// The old one's copy goes, so nothing signs with it by name.
for (const f of readdirSync(dir).filter((f) => f.endsWith(".mobileprovision"))) {
  const plist = Bun.spawnSync(["security", "cms", "-D", "-i", join(dir, f)]).stdout.toString();
  if (/<key>Name<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] === profileName) rmSync(join(dir, f));
}
const file = join(dir, `${made.data.attributes.uuid}.mobileprovision`);
writeFileSync(file, Buffer.from(made.data.attributes.profileContent, "base64"));
console.log(`installed "${profileName}" (${made.data.attributes.uuid}) at ${file}`);
