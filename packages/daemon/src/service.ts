import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { paths } from "./config.ts";

/**
 * Run midna as a background service of the user's own account: a systemd
 * user unit on Linux, a launchd agent on macOS. It runs as the user — that is
 * what gives the agent the user's signed-in CLIs and the run of the machine.
 */

const LABEL = "sh.midna.daemon";
const UNIT = "midna.service";

function run(cmd: string[]): { ok: boolean; out: string } {
  const env = { ...process.env };
  // An SSH session that didn't go through PAM has no XDG_RUNTIME_DIR, and
  // `systemctl --user` can't find the user's manager without it.
  if (platform() === "linux" && !env.XDG_RUNTIME_DIR && existsSync(`/run/user/${userInfo().uid}`)) env.XDG_RUNTIME_DIR = `/run/user/${userInfo().uid}`;
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}

function unitPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", UNIT);
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Install and start the service. `command` is how to launch `midna serve`;
 * PATH is captured now so the service finds `claude`, `codex` and friends
 * exactly where this shell does.
 */
export function installService(command: string[], env: Record<string, string> = {}): string[] {
  const notes: string[] = [];
  const allEnv = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...env };
  if (platform() === "darwin") {
    const logs = paths().logs;
    mkdirSync(logs, { recursive: true });
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${command.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(allEnv).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(logs, "midna.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logs, "midna.log"))}</string>
</dict>
</plist>
`;
    const file = plistPath();
    const domain = `gui/${userInfo().uid}`;
    if (existsSync(file)) run(["launchctl", "bootout", `${domain}/${LABEL}`]);
    writeFileSync(file, plist);
    const r = run(["launchctl", "bootstrap", domain, file]);
    if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out}`);
    notes.push(`launchd agent installed: ${file}`, `logs: ${join(logs, "midna.log")}`);
    return notes;
  }

  const quote = (a: string) => (/[\s"\\]/.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a);
  const unit = `[Unit]
Description=midna — personal assistant
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${command.map(quote).join(" ")}
${Object.entries(allEnv).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`).join("\n")}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  const file = unitPath();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, unit);
  for (const cmd of [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", UNIT], ["systemctl", "--user", "restart", UNIT]]) {
    const r = run(cmd);
    if (!r.ok) throw new Error(`${cmd.join(" ")} failed: ${r.out}`);
  }
  notes.push(`systemd user service installed: ${file}`, `logs: journalctl --user -u midna -f`);
  // Without lingering, user services stop at logout — wrong for an always-on assistant.
  const linger = run(["loginctl", "enable-linger", userInfo().username]);
  notes.push(linger.ok ? "lingering enabled: midna keeps running when you log out" : `to keep midna running after logout, run: sudo loginctl enable-linger ${userInfo().username}`);
  return notes;
}

export function uninstallService(): string[] {
  if (platform() === "darwin") {
    const file = plistPath();
    run(["launchctl", "bootout", `gui/${userInfo().uid}/${LABEL}`]);
    rmSync(file, { force: true });
    return [`removed ${file}`];
  }
  run(["systemctl", "--user", "disable", "--now", UNIT]);
  rmSync(unitPath(), { force: true });
  run(["systemctl", "--user", "daemon-reload"]);
  return [`removed ${unitPath()}`];
}

export function restartService(): boolean {
  if (platform() === "darwin") return run(["launchctl", "kickstart", "-k", `gui/${userInfo().uid}/${LABEL}`]).ok;
  return run(["systemctl", "--user", "restart", UNIT]).ok;
}

export function serviceInstalled(): boolean {
  return existsSync(platform() === "darwin" ? plistPath() : unitPath());
}
