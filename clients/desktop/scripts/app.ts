/**
 * Build the desktop app for this machine and install it — the way makima's
 * `make app` does: the .app on macOS (into ~/Applications); on Linux a .deb
 * where there is dpkg, an .rpm where there is rpm, an AppImage anywhere else
 * (Arch, say). `--no-install` stops after building.
 *
 * On macOS the app is signed with this Mac's Developer ID identity, then
 * notarized and stapled, so Gatekeeper accepts it and its designated
 * requirement is Apple-anchored and the same on every Mac; without one, with
 * "midna dev" (scripts/signing.ts has why). Either way the permissions it's
 * granted survive the update; without either the build is ad hoc, and loses
 * them. A build is only installed where nothing is lost by it (guard.ts).
 * MIDNA_NOTARIZE=0 signs with Developer ID but skips notarizing.
 *
 * `--universal` (macOS) builds one midna.app for Apple silicon and Intel Macs: the Tauri
 * binary and the bundled CLI each carry arm64 and x86_64, signed and notarized the same way.
 * It needs both Rust targets (rustup target add aarch64-apple-darwin x86_64-apple-darwin).
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_ID, refuseInstall, signer, type Signer } from "./guard.ts";
import { NOTARY_PROFILE, SIGNING_IDENTITY, developerId, hasSigningIdentity, signingIdentity } from "./signing.ts";

const here = join(import.meta.dir, "..");
const universal = process.argv.includes("--universal");
const bundleDir = join(here, "src-tauri", "target", ...(universal ? ["universal-apple-darwin"] : []), "release", "bundle");
const has = (cmd: string) => Bun.which(cmd) !== null;
const run = (argv: string[], cwd = here) => {
  const r = Bun.spawnSync(argv, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
};

const kind = process.platform === "darwin" ? "app" : has("dpkg") ? "deb" : has("rpm") ? "rpm" : "appimage";
if (universal) {
  if (kind !== "app") throw new Error("--universal is a macOS build");
  const targets = Bun.spawnSync(["rustup", "target", "list", "--installed"]).stdout.toString().split("\n");
  const missing = ["aarch64-apple-darwin", "x86_64-apple-darwin"].filter((t) => !targets.includes(t));
  if (missing.length) throw new Error(`a universal build needs these Rust targets: rustup target add ${missing.join(" ")}`);
}
const install = !process.argv.includes("--no-install");
const dest = join(homedir(), "Applications", "midna.app");

/** Stop before an ad-hoc build replaces a midna.app whose permissions it would lose. */
function guard(bundleId: string, build: Signer): void {
  const refusal = refuseInstall({
    bundleId,
    build,
    identity: hasSigningIdentity(),
    installed: signer(dest),
    allowAdHoc: process.env.MIDNA_ALLOW_ADHOC === "1",
    allowSwitch: process.env.MIDNA_SWITCH_SIGNER === "1",
  });
  if (!refusal) return;
  console.error(`\n${refusal}\n`);
  process.exit(1);
}

const identity = kind === "app" ? signingIdentity() : null;

// Before building: it would be signed only if codesign can use an identity now.
if (kind === "app" && install) {
  const conf = JSON.parse(readFileSync(join(here, "src-tauri", "tauri.conf.json"), "utf8")) as { identifier: string };
  guard(conf.identifier, !identity ? "adhoc" : identity.developerId ? "developer id" : "midna dev");
}

run(["bun", "scripts/sidecar.ts", ...(universal ? ["--universal"] : [])]);
run(["bun", "run", "tauri", "build", "--bundles", kind, ...(universal ? ["--target", "universal-apple-darwin"] : [])]);

const built = (sub: string, ext: string) => {
  const dir = join(bundleDir, sub);
  const f = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(ext)).sort().pop() : undefined;
  if (!f) throw new Error(`no ${ext} in ${dir}`);
  return join(dir, f);
};

/** Sign the bundle inside out — the bundled CLI, then the app — under the hardened runtime. */
function sign(app: string): void {
  if (!identity) {
    console.warn(`\n⚠ ad-hoc build: neither a Developer ID nor "${SIGNING_IDENTITY}" is ready on this Mac (bun run signing), so the permissions midna.app has been granted won't survive this update.\n`);
    return;
  }
  const dev = developerId();
  if (dev && !identity.developerId) console.warn(`\n⚠ "${dev}" is here but codesign can't use its key without asking; signing with "${SIGNING_IDENTITY}".\n`);
  // The grants are filed under the bundle id and the certificate: the id never changes.
  const id = Bun.spawnSync(["/usr/bin/defaults", "read", join(app, "Contents", "Info.plist"), "CFBundleIdentifier"]).stdout.toString().trim();
  if (id !== BUNDLE_ID) throw new Error(`${app} is ${id || "unidentified"}, not ${BUNDLE_ID}: only midna.app itself is signed with "${identity.name}"`);
  const entitlements = (name: string) => join(here, "src-tauri", "entitlements", `${name}.plist`);
  // Notarization wants a secure timestamp on every signature.
  const timestamp = identity.developerId ? ["--timestamp"] : [];
  const codesign = (target: string, ent: string) =>
    run(["codesign", "--force", "--options", "runtime", ...timestamp, "--entitlements", entitlements(ent), "--sign", identity.name, target]);
  codesign(join(app, "Contents", "MacOS", "midna"), "sidecar");
  codesign(app, "app");
  run(["codesign", "--verify", "--strict", "--deep", app]);
  console.log(`signed with "${identity.name}"`);
}

/** Send a Developer ID build to Apple's notary service, staple the ticket, and check Gatekeeper accepts it. */
function notarize(app: string): void {
  const zip = join(tmpdir(), `midna-notarize-${process.pid}.zip`);
  run(["ditto", "-c", "-k", "--keepParent", app, zip]);
  console.log(`notarizing with the "${NOTARY_PROFILE}" profile (a few minutes)…`);
  const r = Bun.spawnSync(["xcrun", "notarytool", "submit", zip, "--keychain-profile", NOTARY_PROFILE, "--wait", "--output-format", "json"], { stdout: "pipe", stderr: "pipe" });
  rmSync(zip, { force: true });
  const out = r.stdout.toString();
  let result: { id?: string; status?: string; message?: string } = {};
  try {
    result = JSON.parse(out);
  } catch {}
  console.log(`notarization ${result.id ?? "(no id)"}: ${result.status ?? "no answer"}`);
  if (result.status !== "Accepted") {
    console.error(out + r.stderr.toString());
    if (result.id) Bun.spawnSync(["xcrun", "notarytool", "log", result.id, "--keychain-profile", NOTARY_PROFILE], { stdout: "inherit", stderr: "inherit" });
    console.error(`\n✗ not notarized. The log above names what Apple refused (an unsigned nested binary, a missing timestamp, an entitlement). MIDNA_NOTARIZE=0 builds without notarizing.\n`);
    process.exit(1);
  }
  run(["xcrun", "stapler", "staple", app]);
  run(["xcrun", "stapler", "validate", app]);
  run(["spctl", "-a", "-vv", app]);
}

/** A universal build fails here rather than on an Intel Mac: every binary in Contents/MacOS has both slices. */
function checkArchs(app: string): void {
  const macos = join(app, "Contents", "MacOS");
  for (const f of readdirSync(macos)) {
    const archs = Bun.spawnSync(["lipo", "-archs", join(macos, f)]).stdout.toString().trim();
    console.log(`${f}: ${archs}`);
    if (!archs.split(" ").includes("arm64") || !archs.split(" ").includes("x86_64")) throw new Error(`${join(macos, f)} is ${archs || "not Mach-O"}, not arm64 + x86_64`);
  }
}

if (kind === "app") {
  if (universal) checkArchs(built("macos", ".app"));
  sign(built("macos", ".app"));
  if (identity?.developerId && process.env.MIDNA_NOTARIZE !== "0") notarize(built("macos", ".app"));
}

if (!install) process.exit(0);

if (kind === "app") {
  const app = built("macos", ".app");
  // And as built: the bundle's own id and signature.
  guard(Bun.spawnSync(["/usr/bin/defaults", "read", join(app, "Contents", "Info.plist"), "CFBundleIdentifier"]).stdout.toString().trim(), signer(app));
  mkdirSync(join(homedir(), "Applications"), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(app, dest, { recursive: true });
  console.log(`installed ${dest}`);
  Bun.spawnSync(["open", dest]);
} else if (kind === "deb") {
  run(["sudo", "apt-get", "install", "-y", "--reinstall", built("deb", ".deb")]);
} else if (kind === "rpm") {
  run(has("dnf") ? ["sudo", "dnf", "install", "-y", built("rpm", ".rpm")] : ["sudo", "rpm", "-Uvh", "--replacepkgs", built("rpm", ".rpm")]);
} else {
  // An AppImage carries everything; put it on PATH and in the app grid.
  const bin = join(homedir(), ".local", "bin", "midna-desktop");
  mkdirSync(join(homedir(), ".local", "bin"), { recursive: true });
  copyFileSync(built("appimage", ".AppImage"), bin);
  Bun.spawnSync(["chmod", "755", bin]);
  const apps = join(homedir(), ".local", "share", "applications");
  mkdirSync(apps, { recursive: true });
  const icon = join(homedir(), ".local", "share", "icons", "hicolor", "128x128", "apps", "midna-desktop.png");
  mkdirSync(join(icon, ".."), { recursive: true });
  copyFileSync(join(here, "src-tauri", "icons", "128x128.png"), icon);
  writeFileSync(join(apps, "midna.desktop"), `[Desktop Entry]\nName=midna\nComment=Your personal assistant\nExec=${bin}\nIcon=midna-desktop\nType=Application\nCategories=Office;Utility;\n`);
  console.log(`installed ${bin}`);
}
