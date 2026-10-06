/**
 * Build the desktop app for this machine and install it — the way makima's
 * `make app` does: the .app on macOS (into ~/Applications); on Linux a .deb
 * where there is dpkg, an .rpm where there is rpm, an AppImage anywhere else
 * (Arch, say). `--no-install` stops after building.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const here = join(import.meta.dir, "..");
const bundleDir = join(here, "src-tauri", "target", "release", "bundle");
const has = (cmd: string) => Bun.which(cmd) !== null;
const run = (argv: string[], cwd = here) => {
  const r = Bun.spawnSync(argv, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
};

const kind = process.platform === "darwin" ? "app" : has("dpkg") ? "deb" : has("rpm") ? "rpm" : "appimage";
run(["bun", "scripts/sidecar.ts"]);
run(["bun", "run", "tauri", "build", "--bundles", kind]);

const built = (sub: string, ext: string) => {
  const dir = join(bundleDir, sub);
  const f = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(ext)).sort().pop() : undefined;
  if (!f) throw new Error(`no ${ext} in ${dir}`);
  return join(dir, f);
};

if (process.argv.includes("--no-install")) process.exit(0);

if (kind === "app") {
  const app = built("macos", ".app");
  const dest = join(homedir(), "Applications", "midna.app");
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
