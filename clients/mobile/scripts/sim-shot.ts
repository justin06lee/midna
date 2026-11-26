/**
 * A screenshot of the iPhone app in the simulator, against a throwaway midna
 * with a day planned in it (scripts/preview.ts at the repo's root):
 *
 *   bun scripts/sim-shot.ts [--build [--clean]] [--tab today|money|vault] [--tomorrow approved] [--dark] [out.png]
 *
 * --build makes a Release build for the simulator first (prebuild, pods,
 * xcodebuild; Screen Time left out as in TestFlight builds), into
 * build/DerivedData-sim; without it the last one is used. The app is
 * launched with the throwaway midna's connection as a launch argument
 * (src/preview.ts), so nothing is paired or saved and no permission is
 * asked. The app and its midna run in a timezone where it is mid-afternoon,
 * so the day has a block on now whatever the time here.
 *
 * Needs Xcode (DEVELOPER_DIR, the T7's by default) with the iOS platform installed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const mobile = join(import.meta.dir, "..");
const repo = join(mobile, "..", "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const out = resolve(args.find((a, i) => !a.startsWith("--") && !["--tab", "--tomorrow"].includes(args[i - 1] ?? "")) ?? join(repo, "docs", "timetable.png"));
const tab = value("tab") ?? "today";
const DEVICE = "midna preview iPhone";
const APP_ID = "sh.midna.mobile";

process.env.DEVELOPER_DIR ??= "/Volumes/T7/Stockpile/Xcode.app/Contents/Developer";
// CocoaPods is a gem here, and refuses to run without a UTF-8 locale.
process.env.PATH = `/opt/homebrew/lib/ruby/gems/4.0.0/bin:${process.env.PATH}`;
process.env.LANG ??= "en_US.UTF-8";
process.env.LC_ALL ??= "en_US.UTF-8";

const say = (line: string) => console.log(line);
function run(argv: string[], opts: { cwd?: string; env?: Record<string, string>; quiet?: boolean; log?: string } = {}): string {
  const r = Bun.spawnSync(argv, { cwd: opts.cwd ?? mobile, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  const text = r.stdout.toString() + r.stderr.toString();
  if (opts.log) Bun.write(opts.log, text);
  if (r.exitCode !== 0) {
    console.error(text.split("\n").slice(-40).join("\n"));
    throw new Error(`${argv.slice(0, 3).join(" ")} failed${opts.log ? ` (see ${opts.log})` : ""}`);
  }
  return r.stdout.toString();
}

/** A zone where it is between two and three in the afternoon now, so the plan has a block on. */
function afternoonZone(): string {
  const zones = ["Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Halifax", "America/Sao_Paulo", "Atlantic/South_Georgia", "Atlantic/Azores", "Europe/London", "Europe/Paris", "Europe/Athens", "Europe/Moscow", "Asia/Dubai", "Asia/Karachi", "Asia/Dhaka", "Asia/Bangkok", "Asia/Shanghai", "Asia/Seoul", "Australia/Brisbane", "Pacific/Noumea", "Pacific/Auckland", "Pacific/Tongatapu"];
  const hour = (z: string) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: z, hour: "numeric", hourCycle: "h23" }).format(new Date()));
  return zones.find((z) => hour(z) === 14) ?? zones.find((z) => hour(z) === 15) ?? zones.find((z) => hour(z) === 13) ?? "Europe/London";
}

const products = join(mobile, "build", "DerivedData-sim", "Build", "Products", "Release-iphonesimulator", "midna.app");

if (flag("build")) {
  mkdirSync(join(mobile, "build"), { recursive: true });
  // Screen Time stays out, as in a TestFlight build without MIDNA_FOCUS=1.
  const focus = join(mobile, "modules", "midna-focus", "expo-module.config.json");
  const hidden = existsSync(focus);
  if (hidden) renameSync(focus, `${focus}.off`);
  try {
    // The native project is made again only when asked (--clean) or missing: a JavaScript change needs only the build.
    if (flag("clean") || !existsSync(join(mobile, "ios", "midna.xcworkspace"))) {
      say("[build 1/2] prebuild and pods");
      run(["bunx", "expo", "prebuild", "-p", "ios", "--clean"], { env: { CI: "1" }, log: join(mobile, "build", "sim-prebuild.log") });
    }
    say("[build 2/2] xcodebuild, Release for the simulator (several minutes)");
    run(
      ["xcodebuild", "-workspace", "ios/midna.xcworkspace", "-scheme", "midna", "-configuration", "Release", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", "build/DerivedData-sim", "CODE_SIGNING_ALLOWED=NO", "build"],
      { log: join(mobile, "build", "sim-build.log") },
    );
  } finally {
    if (hidden) renameSync(`${focus}.off`, focus);
  }
}
if (!existsSync(products)) throw new Error(`no simulator build at ${products}: run this with --build`);

const zone = afternoonZone();
say(`[1/4] a throwaway midna with a day planned, in ${zone}`);
const midna = Bun.spawn(["bun", "scripts/preview.ts"], { cwd: repo, env: { ...process.env, TZ: zone, PREVIEW_PORT: "17721", ...(value("tomorrow") === "approved" ? { PREVIEW_TOMORROW: "approved" } : {}) }, stdout: "pipe", stderr: "inherit" });
let home = "";
const reader = midna.stdout.getReader();
for (let text = ""; !home; ) {
  const { value: chunk, done } = await reader.read();
  if (done) throw new Error("the throwaway midna stopped before it was ready");
  text += new TextDecoder().decode(chunk);
  home = /\(home ([^)]+)\)/.exec(text)?.[1] ?? "";
}
reader.releaseLock();

let udid = "";
try {
  say("[2/4] a simulator");
  const devices = JSON.parse(run(["xcrun", "simctl", "list", "devices", "available", "-j"])) as { devices: Record<string, Array<{ name: string; udid: string; state: string }>> };
  udid = Object.values(devices.devices).flat().find((d) => d.name === DEVICE)?.udid ?? "";
  if (!udid) {
    const types = JSON.parse(run(["xcrun", "simctl", "list", "devicetypes", "-j"])) as { devicetypes: Array<{ name: string; identifier: string }> };
    const runtimes = JSON.parse(run(["xcrun", "simctl", "list", "runtimes", "available", "-j"])) as { runtimes: Array<{ identifier: string; platform: string }> };
    const phone = types.devicetypes.filter((t) => /^iPhone \d+ Pro$/.test(t.name)).pop() ?? types.devicetypes.filter((t) => t.name.startsWith("iPhone")).pop();
    const ios = runtimes.runtimes.filter((r) => r.platform === "iOS").pop();
    if (!phone || !ios) throw new Error("no iPhone device type or iOS runtime in this Xcode");
    udid = run(["xcrun", "simctl", "create", DEVICE, phone.identifier, ios.identifier]).trim();
  }
  Bun.spawnSync(["xcrun", "simctl", "boot", udid]);
  run(["xcrun", "simctl", "bootstatus", udid, "-b"]);
  if (flag("dark")) run(["xcrun", "simctl", "ui", udid, "appearance", "dark"]);
  else run(["xcrun", "simctl", "ui", udid, "appearance", "light"]);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date()).replace(/\s?[AP]M$/, "");
  run(["xcrun", "simctl", "status_bar", udid, "override", "--time", time, "--batteryState", "charged", "--batteryLevel", "100", "--wifiBars", "3", "--cellularBars", "4"]);

  say("[3/4] installing and opening the app");
  Bun.spawnSync(["xcrun", "simctl", "terminate", udid, APP_ID]);
  run(["xcrun", "simctl", "install", udid, products]);
  const connection = btoa(readFileSync(join(home, "connection.json"), "utf8"));
  run(["xcrun", "simctl", "launch", udid, APP_ID, "-midnaPreview", connection, "-midnaTab", tab], { env: { SIMCTL_CHILD_TZ: zone } });
  await Bun.sleep(9000);

  say("[4/4] photographing it");
  mkdirSync(dirname(out), { recursive: true });
  run(["xcrun", "simctl", "io", udid, "screenshot", out]);
  say(`saved ${out}`);
} finally {
  if (udid) {
    Bun.spawnSync(["xcrun", "simctl", "terminate", udid, APP_ID]);
    Bun.spawnSync(["xcrun", "simctl", "shutdown", udid]);
  }
  midna.kill();
}
process.exit(0);
