/**
 * A photograph of the built Mac app's own window, against a throwaway midna,
 * in one command (macOS, from clients/desktop):
 *
 *   bun scripts/built-shot.ts [out dir] [--build] [--keep]
 *
 * It runs a build of the app under a bundle id, name and process name of
 * its own (sh.midna.desktop.preview, midna-preview), so the installed
 * midna.app, its single-instance lock and its permissions are never
 * touched. --build makes that build first (a few minutes); without it the
 * one left by an earlier run is used. The throwaway midna is started here
 * and its connection handed to the app, since each one has a home and a
 * token of its own. --keep leaves the app and its midna running afterwards,
 * to click around; otherwise both are stopped.
 *
 * WebKit paints a window only while some of it can be seen, so the app comes
 * to the front for the two or three seconds the photograph takes (once
 * nobody has touched the Mac for a few seconds), and the app that was in
 * front gets the screen back. The screen has to be unlocked: behind a lock
 * screen the window comes out empty (scripts/websnap.swift draws the page
 * off screen for that case). Whatever runs this needs Screen Recording.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MidnaClient, type Connection } from "@midna/protocol";

const here = join(import.meta.dir, "..");
const repo = join(here, "..", "..");
const ID = "sh.midna.desktop.preview";
const NAME = "midna-preview";
const APP = join(here, "src-tauri", "target", "release", "bundle", "macos", `${NAME}.app`);
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const out = resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? join(repo, "docs", "apple-pass"));

const sh = (argv: string[], cwd = here) => Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
const say = (line: string) => console.log(line);
/** One line of Swift's answer: the lock state and the window list aren't in any command-line tool. */
const swift = (code: string) => sh(["swift", "-e", `import CoreGraphics\nimport Foundation\n${code}`]).stdout.toString().trim();

if (process.platform !== "darwin") throw new Error("this photographs a Mac window");

if (flags.has("--build")) {
  say("[1/4] building midna-preview.app (release; a few minutes)");
  for (const argv of [
    ["bun", "scripts/sidecar.ts"],
    ["bun", "run", "tauri", "build", "--bundles", "app", "--config", JSON.stringify({ identifier: ID, productName: NAME, mainBinaryName: NAME })],
    // Ad hoc: it runs here and nowhere else.
    ["codesign", "--force", "--deep", "--sign", "-", APP],
  ]) {
    const r = Bun.spawnSync(argv, { cwd: here, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
  }
} else if (!existsSync(APP)) {
  console.error(`no preview build at ${APP}\nrun this again with --build`);
  process.exit(1);
} else say("[1/4] using the preview build already there");

if (swift(`let d = CGSessionCopyCurrentDictionary() as? [String: Any]; print((d?["CGSSessionScreenIsLocked"] as? Int) == 1 ? "locked" : "open")`) === "locked") {
  console.error("this Mac's screen is locked: the app would paint nothing. Unlock it and run this again.");
  process.exit(2);
}

say("[2/4] starting a throwaway midna");
const midna = Bun.spawn(["bun", "scripts/preview.ts"], { cwd: repo, stdout: "pipe", stderr: "inherit" });
let home = "";
const reader = midna.stdout.getReader();
for (let text = ""; !home; ) {
  const { value, done } = await reader.read();
  if (done) throw new Error("the throwaway midna stopped before it was ready");
  text += new TextDecoder().decode(value);
  home = /\(home ([^)]+)\)/.exec(text)?.[1] ?? "";
}
reader.releaseLock();
const stop = () => {
  if (flags.has("--keep")) return say(`left running: the app, and midna (pid ${midna.pid}); quit the app and kill that when done`);
  sh(["pkill", "-f", `${NAME}.app/Contents/MacOS/${NAME}`]);
  midna.kill();
};

try {
  // The app reads its connection from its own folder: this build's, not midna.app's.
  const support = join(homedir(), "Library", "Application Support", ID);
  mkdirSync(support, { recursive: true });
  copyFileSync(join(home, "connection.json"), join(support, "connection.json"));
  const c = (await Bun.file(join(home, "connection.json")).json()) as Connection;
  // What Justin runs, so the window shows the names it would show him. A brain this Mac lacks is simply not set.
  await new MidnaClient(c.url, c.token).updateSettings({ model: "claude:claude-fable-5-2", account: "personal" }).catch(() => {});

  say("[3/4] opening the app behind whatever is in front");
  const front = /"LSDisplayName"="([^"]+)"/.exec(sh(["sh", "-c", 'lsappinfo info -only name "$(lsappinfo front)"']).stdout.toString())?.[1];
  sh(["pkill", "-f", `${NAME}.app/Contents/MacOS/${NAME}`]);
  sh(["open", "-g", APP]);
  let window = "";
  for (let tries = 0; !window && tries < 10; tries++) {
    await Bun.sleep(1500);
    window = swift(
      `let l = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]\nfor w in l { if (w["kCGWindowOwnerName"] as? String) == "${NAME}", (w["kCGWindowName"] as? String) == "midna", (w["kCGWindowIsOnscreen"] as? Int) == 1 { print(w["kCGWindowNumber"] ?? ""); break } }`,
    );
  }
  if (!window) throw new Error("the app's window never came up");
  // The page: its history, and its model's name from the brain.
  await Bun.sleep(5000);

  say("[4/4] photographing its window");
  mkdirSync(out, { recursive: true });
  const file = join(out, "built-chat.png");
  // In front only as long as it takes, and not in the middle of someone's typing: wait for a pause of a few seconds (a minute at most).
  const idle = () => Number(/"HIDIdleTime" = (\d+)/.exec(sh(["ioreg", "-c", "IOHIDSystem"]).stdout.toString())?.[1] ?? 0) / 1e9;
  for (let waited = 0; idle() < 4 && waited < 60; waited++) await Bun.sleep(1000);
  sh(["open", "-a", APP]);
  await Bun.sleep(2500);
  const shot = sh(["screencapture", "-x", "-o", "-l", window, file]);
  if (front) sh(["open", "-a", front]);
  if (shot.exitCode !== 0 || !existsSync(file)) throw new Error(`screencapture couldn't take it: ${shot.stderr.toString().trim() || "no picture"}`);
  say(`saved ${file}`);
} finally {
  stop();
}
process.exit(0);
