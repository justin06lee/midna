/**
 * Build the desktop app for this machine and install it — the way makima's
 * `make app` does: the .app on macOS (into ~/Applications); on Linux a .deb
 * where there is dpkg, an .rpm where there is rpm, an AppImage anywhere else
 * (Arch, say). `--no-install` stops after building.
 *
 * On macOS the app is signed with this Mac's "midna dev" identity
 * (scripts/signing.ts), so the permissions it's granted survive the update;
 * without it the build is ad hoc, and loses them. An ad-hoc build is only
 * installed where nothing is lost by it (guard.ts).
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUNDLE_ID, refuseInstall, signer, type Signer } from "./guard.ts";
import { SIGNING_IDENTITY, hasSigningIdentity, signingReady } from "./signing.ts";

const here = join(import.meta.dir, "..");
const bundleDir = join(here, "src-tauri", "target", "release", "bundle");
const has = (cmd: string) => Bun.which(cmd) !== null;
const run = (argv: string[], cwd = here) => {
  const r = Bun.spawnSync(argv, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
};

const kind = process.platform === "darwin" ? "app" : has("dpkg") ? "deb" : has("rpm") ? "rpm" : "appimage";
const install = !process.argv.includes("--no-install");
const dest = join(homedir(), "Applications", "midna.app");

/** Stop before an ad-hoc build replaces a midna.app whose permissions it would lose. */
function guard(bundleId: string, build: Signer): void {
  const refusal = refuseInstall({ bundleId, build, identity: hasSigningIdentity(), installed: signer(dest), allowAdHoc: process.env.MIDNA_ALLOW_ADHOC === "1" });
  if (!refusal) return;
  console.error(`\n${refusal}\n`);
  process.exit(1);
}

// Before building: it would be signed only if codesign can use the identity now.
if (kind === "app" && install) {
  const conf = JSON.parse(readFileSync(join(here, "src-tauri", "tauri.conf.json"), "utf8")) as { identifier: string };
  guard(conf.identifier, signingReady() ? "midna dev" : "adhoc");
}

run(["bun", "scripts/sidecar.ts"]);
run(["bun", "run", "tauri", "build", "--bundles", kind]);

const built = (sub: string, ext: string) => {
  const dir = join(bundleDir, sub);
  const f = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(ext)).sort().pop() : undefined;
  if (!f) throw new Error(`no ${ext} in ${dir}`);
  return join(dir, f);
};

/** Sign the bundle inside out — the bundled CLI, then the app — under the hardened runtime. */
function sign(app: string): void {
  if (!signingReady()) {
    console.warn(`\n⚠ ad-hoc build: "${SIGNING_IDENTITY}" isn't ready on this Mac (bun run signing), so the permissions midna.app has been granted won't survive this update.\n`);
    return;
  }
  // The grants are filed under the bundle id and the certificate: the id never changes.
  const id = Bun.spawnSync(["/usr/bin/defaults", "read", join(app, "Contents", "Info.plist"), "CFBundleIdentifier"]).stdout.toString().trim();
  if (id !== BUNDLE_ID) throw new Error(`${app} is ${id || "unidentified"}, not ${BUNDLE_ID}: only midna.app itself is signed with "${SIGNING_IDENTITY}"`);
  const entitlements = (name: string) => join(here, "src-tauri", "entitlements", `${name}.plist`);
  const codesign = (target: string, ent: string) =>
    run(["codesign", "--force", "--options", "runtime", "--entitlements", entitlements(ent), "--sign", SIGNING_IDENTITY, target]);
  codesign(join(app, "Contents", "MacOS", "midna"), "sidecar");
  codesign(app, "app");
  run(["codesign", "--verify", "--strict", app]);
  console.log(`signed with "${SIGNING_IDENTITY}"`);
}

if (kind === "app") sign(built("macos", ".app"));

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
