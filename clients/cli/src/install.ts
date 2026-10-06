import { existsSync } from "node:fs";
import { arch, hostname, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_PORT, INSTALL_STEPS, MidnaClient, type InstallEvent, type InstallStepId } from "@midna/protocol";
import { VERSION } from "@midna/daemon";
import type { Device } from "./discover.ts";

/**
 * Make a machine midna's home from wherever you're sitting: reach it (SSH
 * over makima or Tailscale, or just this machine), put the right `midna`
 * binary on it, check its brain is signed in, start it as a service, and
 * pair this machine with it. Every step reports as it goes, so the desktop
 * app can draw it.
 */

export type { InstallEvent } from "@midna/protocol";
type StepId = InstallStepId;
export const STEPS = INSTALL_STEPS;

export interface InstallOptions {
  model: string;
  timezone: string;
  mode: "autonomous" | "ask";
  port?: number;
  /** Isolated install (tests, a second instance): data dir and binary path on the target. */
  home?: string;
  bin?: string;
  /** Run it as a plain background process rather than a system service. */
  noService?: boolean;
  /** Don't let a fresh instance start its onboarding (trial installs). */
  noIntro?: boolean;
  /** Where to find midna builds for other platforms. */
  kits?: string[];
  /** Skip the live brain check (it costs a few tokens). */
  skipBrainCheck?: boolean;
  /** This computer's name, as the host will list it. */
  deviceName?: string;
}

// ── transports ───────────────────────────────────────────────────────────

export interface Result { code: number; stdout: string; stderr: string }

export interface Transport {
  /** Run a POSIX sh script there. It must not contain single quotes. */
  sh(script: string, opts?: { input?: Blob; timeoutMs?: number; onWrite?: (n: number) => void }): Promise<Result>;
  /** A command that opens an interactive terminal there running `cmd`. */
  terminal(cmd: string): string[];
}

async function run(argv: string[], input: Blob | undefined, timeoutMs: number, onWrite?: (n: number) => void): Promise<Result> {
  const proc = Bun.spawn(argv, { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  if (input) {
    const sink = proc.stdin as import("bun").FileSink;
    let sent = 0;
    for await (const chunk of input.stream() as unknown as AsyncIterable<Uint8Array>) {
      sink.write(chunk);
      await sink.flush();
      sent += chunk.byteLength;
      onWrite?.(sent);
    }
    await sink.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

export function localTransport(): Transport {
  return {
    sh: (script, o = {}) => run(["sh", "-c", script], o.input, o.timeoutMs ?? 120_000, o.onWrite),
    terminal: (cmd) => ["sh", "-c", cmd],
  };
}

/**
 * SSH with no prompts: keys only, and a host seen for the first time is
 * trusted — over makima or Tailscale the tunnel has already proven which
 * machine it is. A key that *changed* still fails. One connection is reused
 * for every step.
 */
export function sshTransport(target: string): Transport {
  const base = [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${join(tmpdir(), "midna-ssh-%C")}`,
    "-o", "ControlPersist=60",
  ];
  return {
    sh: (script, o = {}) => {
      if (script.includes("'")) throw new Error("internal: remote scripts must not contain single quotes");
      // `sh -c '…'` reads the same in bash, zsh and fish, whatever the login shell is.
      return run([...base, target, `sh -c '${script}'`], o.input, o.timeoutMs ?? 120_000, o.onWrite);
    },
    terminal: (cmd) => ["ssh", "-t", "-o", "StrictHostKeyChecking=accept-new", target, cmd],
  };
}

/** A value made safe inside a double-quoted sh string. */
export function dq(v: string): string {
  if (v.includes("'")) throw new Error(`can't pass a value with a single quote: ${v}`);
  return `"${v.replace(/(["\\$`])/g, "\\$1")}"`;
}

// ── builds ───────────────────────────────────────────────────────────────

export function platformOf(uname: string): string | null {
  const [os, machine] = uname.trim().split(/\s+/);
  const o = os === "Linux" ? "linux" : os === "Darwin" ? "darwin" : null;
  const a = machine === "x86_64" || machine === "amd64" ? "x64" : machine === "aarch64" || machine === "arm64" ? "arm64" : null;
  return o && a ? `${o}-${a}` : null;
}

export const ownPlatform = () => `${platform()}-${arch() === "x64" ? "x64" : "arm64"}`;

/** True when this process is the compiled `midna` (rather than bun running the source). */
export const compiled = () => Bun.main.startsWith("/$bunfs/") || /^[A-Z]:\\~BUN/.test(Bun.main);

/** A midna build for `plat`: this binary when it matches, else a kit (plain or .gz). */
export function findBuild(plat: string, kits: string[]): { path: string; gz: boolean } | null {
  if (plat === ownPlatform() && compiled()) return { path: process.execPath, gz: false };
  for (const dir of kits) {
    for (const [name, gz] of [[`midna-${plat}.gz`, true], [`midna-${plat}`, false]] as const) {
      const p = join(dir, name);
      if (existsSync(p)) return { path: p, gz };
    }
  }
  return null;
}

export function defaultKits(): string[] {
  const dirs = [process.env.MIDNA_KITS, join(dirname(process.execPath), "kits"), join(dirname(process.execPath), "..", "Resources", "kits")];
  // Running from source: the repo's own builds.
  if (!compiled()) dirs.push(join(import.meta.dir, "..", "..", "..", "dist"));
  return dirs.filter((d): d is string => !!d && existsSync(d));
}

// ── the install ──────────────────────────────────────────────────────────

class StepFailed extends Error {
  constructor(readonly id: StepId, message: string, readonly hint?: string, readonly action?: { label: string; terminal: string[] }) {
    super(message);
  }
}

/** Why an SSH attempt failed, in words someone can act on. */
export function explainSsh(stderr: string, device: Pick<Device, "name" | "via">): { message: string; hint?: string } {
  const s = stderr.toLowerCase();
  if (s.includes("connection refused"))
    return {
      message: `${device.name} isn't accepting SSH.`,
      hint: device.via === "makima" ? `Turn on makima's SSH on ${device.name}: run \`makima sshd -on\` there.` : `Turn on its SSH server (on a Mac: System Settings → General → Sharing → Remote Login).`,
    };
  if (s.includes("permission denied"))
    return { message: `${device.name} doesn't accept this computer's SSH key.`, hint: `Add your public key (~/.ssh/id_ed25519.pub) to ~/.ssh/authorized_keys on ${device.name}.` };
  if (s.includes("host key verification failed") || s.includes("remote host identification has changed"))
    return { message: `${device.name}'s SSH host key doesn't match the one this computer remembers.`, hint: "If you reinstalled it, remove the old key with `ssh-keygen -R <address>` and try again." };
  if (s.includes("timed out") || s.includes("no route"))
    return { message: `${device.name} didn't answer.`, hint: "Check that it's on and connected to the mesh." };
  return { message: `Couldn't reach ${device.name}: ${stderr.trim().split("\n").pop() || "ssh failed"}` };
}

export async function install(device: Device, opts: InstallOptions, emit: (e: InstallEvent) => void): Promise<boolean> {
  const t = device.self ? localTransport() : sshTransport(device.sshTarget ?? device.address);
  const port = opts.port ?? DEFAULT_PORT;
  const env = (opts.home ? `MIDNA_HOME=${dq(opts.home)} ` : "") + (opts.noIntro ? "MIDNA_NO_INTRO=1 " : "");
  const bin = opts.bin ? dq(opts.bin) : `"$HOME/.local/bin/midna"`;
  const ours = VERSION;
  const step = (id: StepId, status: "running" | "done" | "skipped", detail?: string) => emit({ type: "step", id, status, title: STEPS[id], ...(detail ? { detail } : {}) });

  try {
    // 1 ── reach it, learn what it is, and whether midna is already there.
    step("reach", "running");
    const probe = await t.sh(`uname -sm; ${env}${bin} version --json 2>/dev/null || echo "{}"; ${env}${bin} status --json 2>/dev/null || echo "{}"`, { timeoutMs: 30_000 });
    if (probe.code !== 0 && probe.code !== 255 && !probe.stdout) throw new StepFailed("reach", `Couldn't run commands on ${device.name}.`, probe.stderr.trim());
    if (probe.code === 255) {
      const why = explainSsh(probe.stderr, device);
      throw new StepFailed("reach", why.message, why.hint);
    }
    const [uname = "", versionLine = "{}", statusLine = "{}"] = probe.stdout.trim().split("\n");
    const plat = platformOf(uname);
    if (!plat) throw new StepFailed("reach", `midna doesn't run on ${uname.trim() || "that system"} yet — Linux and macOS only.`);
    // Older builds print a bare version and human status; read both kinds.
    const v = safeJson<{ version?: string; configured?: boolean }>(versionLine);
    const installed = v.version ?? /^\d+\.\d+\.\d+\S*$/.exec(versionLine.trim())?.[0];
    const configured = v.configured ?? !!installed;
    // What is actually running can be older than the binary on disk (replaced, not yet restarted).
    const runningVersion = safeJson<{ version?: string }>(statusLine).version ?? (device.midna.running ? device.midna.version : undefined);
    const running = runningVersion !== undefined;
    step("reach", "done", `${plat.replace("-", " · ")}${running ? ` · midna ${runningVersion} running` : installed ? ` · midna ${installed} installed` : ""}`);

    // 2 ── the binary: leave a current one alone, replace an old one.
    const fresh = installed !== ours;
    if (!fresh) step("binary", "skipped", `midna ${ours} is already there`);
    else {
      step("binary", "running");
      const build = findBuild(plat, opts.kits ?? defaultKits());
      if (!build)
        throw new StepFailed("binary", `This computer has no midna build for ${plat}.`, "Build one with `bun run build:all` (or `bun run kits`) and try again.");
      const file = Bun.file(build.path);
      const total = file.size;
      let lastReport = 0;
      const target = opts.bin ? dq(opts.bin) : `"$HOME/.local/bin/midna"`;
      const up = await t.sh(
        // The binary it replaces is kept as .prev — an upgrade can be undone by hand.
        `set -e; d=$(dirname ${target}); mkdir -p "$d"; ${build.gz ? "gzip -dc" : "cat"} > ${target}.part; chmod 755 ${target}.part; if [ -f ${target} ]; then cp -f ${target} ${target}.prev; fi; mv -f ${target}.part ${target}; ${target} version --json`,
        {
          input: file,
          timeoutMs: 15 * 60_000,
          onWrite: (n) => {
            if (n - lastReport > 2_000_000 || n === total) {
              lastReport = n;
              emit({ type: "progress", id: "binary", done: n, total });
            }
          },
        },
      );
      if (up.code !== 0) throw new StepFailed("binary", "Copying midna failed.", up.stderr.trim() || undefined);
      step("binary", "done", `${installed ? `updated ${installed} → ${ours}` : `midna ${ours}`} (${(total / 1_048_576).toFixed(0)} MB${build.gz ? " compressed" : ""})`);
    }

    // 3 ── the brain must be installed and signed in on that machine.
    if (running) step("brain", "skipped", "midna is already running there");
    else if (opts.skipBrainCheck) step("brain", "skipped");
    else {
      step("brain", "running");
      const doc = await t.sh(`${env}${bin} doctor --json --live ${dq(opts.model)}`, { timeoutMs: 120_000 });
      const live = safeJson<{ live?: { ok: boolean; reason?: string; message?: string; loginCommand?: string; installHint?: string } }>(doc.stdout.trim().split("\n").pop() ?? "{}").live;
      if (!live) throw new StepFailed("brain", "Couldn't check the brain.", doc.stderr.trim() || undefined);
      if (!live.ok) {
        if (live.reason === "signed_out")
          throw new StepFailed("brain", `${opts.model} isn't signed in on ${device.name}.`, signInHint(device.name, live.loginCommand), {
            label: `Sign in on ${device.name}`,
            terminal: t.terminal((live.loginCommand ?? "claude").split(" ")[0]!),
          });
        if (live.reason === "not_installed") throw new StepFailed("brain", `The agent CLI for ${opts.model} isn't installed on ${device.name}.`, live.installHint);
        throw new StepFailed("brain", live.message ?? "The brain didn't answer.");
      }
      step("brain", "done", `${opts.model} answers`);
    }

    // 4 ── configure and start it — or, when it was already running, restart it on the new binary.
    //      An existing install keeps its own settings; only a new one takes ours.
    if (running && runningVersion === ours) step("start", "skipped", "already running");
    else if (running) {
      step("start", "running");
      const r = await t.sh(`${env}${bin} service restart`, { timeoutMs: 60_000 });
      if (r.code !== 0) throw new StepFailed("start", "midna was updated but didn't restart.", r.stderr.trim() || r.stdout.trim() || undefined);
      step("start", "done", `restarted on ${ours}`);
    } else {
      step("start", "running");
      const settings = configured ? [] : [`--model ${dq(opts.model)}`, `--timezone ${dq(opts.timezone)}`, `--mode ${opts.mode}`];
      const flags = [
        ...settings,
        `--port ${port}`,
        ...(device.listen ? [`--listen ${dq(device.listen)}`] : []),
        ...(opts.noService ? ["--no-service"] : []),
      ];
      const out = await t.sh(`${env}${bin} setup --yes --json ${flags.join(" ")}`, { timeoutMs: 120_000 });
      const res = safeJson<{ ok?: boolean; service?: string; error?: string; notes?: string[] }>(out.stdout.trim().split("\n").pop() ?? "{}");
      if (!res.ok) throw new StepFailed("start", res.error ?? "midna didn't start.", out.stderr.trim().split("\n").slice(-3).join("\n") || undefined);
      step("start", "done", res.service === "process" ? "running in the background" : `running as a ${res.service} service`);
    }

    // 5 ── pair: a code minted there, spent from here over the network.
    step("pair", "running");
    // A service that was just (re)started may not be listening yet: ask until it answers.
    let code: string | undefined;
    let last = "";
    for (const end = Date.now() + 30_000; !code && Date.now() < end; await Bun.sleep(1_000)) {
      const r = await t.sh(`${env}${bin} pair --json`, { timeoutMs: 30_000 });
      const out = safeJson<{ code?: string; error?: string }>(r.stdout.trim().split("\n").pop() ?? "");
      code = out.code;
      last = out.error ?? r.stderr.trim();
    }
    if (!code) throw new StepFailed("pair", "midna there wouldn't give out a pairing code.", last || undefined);
    const url = `http://${device.address.includes(":") ? `[${device.address}]` : device.address}:${port}`;
    // makima puts a loopback service on the mesh once it has been up a few seconds.
    const client = new MidnaClient(url);
    let reachable = false;
    for (const end = Date.now() + 45_000; Date.now() < end; await Bun.sleep(750)) {
      if (await client.health().then(() => true, () => false)) {
        reachable = true;
        break;
      }
    }
    if (!reachable)
      throw new StepFailed(
        "pair",
        `midna is running on ${device.name} but this computer can't reach ${url}.`,
        device.via === "makima" ? "makima publishes it within a few seconds; check `makima status` there." : "Check the firewall on that machine.",
      );
    const paired = await client.pair({ code, deviceName: opts.deviceName ?? `${hostname().replace(/\.local$/, "")} (desktop)`, kind: "desktop" });
    step("pair", "done");
    emit({ type: "done", connection: { url, token: paired.token, name: paired.name, host: device.name, ssh: device.self ? null : (device.sshTarget ?? device.address), device: paired.deviceId } });
    return true;
  } catch (err) {
    if (err instanceof StepFailed) {
      emit({ type: "step", id: err.id, status: "failed", title: STEPS[err.id] });
      emit({ type: "failed", id: err.id, message: err.message, ...(err.hint ? { hint: err.hint } : {}), ...(err.action ? { action: err.action } : {}) });
    } else {
      emit({ type: "failed", id: "reach", message: (err as Error).message });
    }
    return false;
  }
}

/** "claude (then /login)" → "Run `claude` on tenet and type /login to sign in, then try again." */
export function signInHint(machine: string, loginCommand = "claude"): string {
  const [cmd = "claude"] = loginCommand.split(" ");
  const then = /\(then ([^)]+)\)/.exec(loginCommand)?.[1];
  return `Run \`${cmd}\` on ${machine}${then ? ` and type ${then}` : ""} to sign in, then try again.`;
}

function safeJson<T>(s: string): Partial<T> {
  try {
    return JSON.parse(s) as T;
  } catch {
    return {};
  }
}
