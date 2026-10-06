#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { arch, hostname, platform } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { MidnaClient, MidnaError, type OutboxItem } from "@midna/protocol";
import {
  VERSION,
  checkBrainLive,
  checkModel,
  ensureHome,
  hostSettings,
  installService,
  installedBrains,
  loadConfig,
  midnaHome,
  paths,
  restartService,
  saveConfig,
  serviceInstalled,
  startDaemon,
  uninstallService,
  updateHostSettings,
  writePrivate,
  type BridgeSetup,
} from "@midna/daemon";
import { TelegramBridge, setupTelegram } from "@midna/telegram";
import { discover } from "./discover.ts";
import { STEPS, defaultKits, install, type InstallEvent } from "./install.ts";

const HELP = `midna ${VERSION} — a proactive personal assistant

  midna setup                     first-time setup on this machine (--yes for no questions)
  midna serve                     run midna in the foreground
  midna chat                      talk to midna here
  midna send <text>               send one message
  midna status                    mode, model, what it's doing
  midna mode [autonomous|ask]     show or switch the permission mode
  midna model [ref]               show or set the brain: claude:opus, codex:gpt-5.6-sol, gemini, …
  midna pair                      a one-time code for adding another device
  midna connect <url> <code>      point this machine's CLI at a midna elsewhere
  midna devices                   machines midna could live on (this one, makima, Tailscale)
  midna host install <machine>    make one of them midna's home, over SSH, and pair with it
  midna paired [revoke <id>]      devices paired with this midna
  midna telegram setup            connect a Telegram bot (your phone, for now)
  midna doctor [--live <model>]   which brains are here, and whether one answers
  midna service install|uninstall|restart

  --json on status, pair, version, doctor, devices, setup and host install prints machine-readable output.
`;

// ── helpers ────────────────────────────────────────────────────────────
interface ClientConfig { url: string; token: string }
const clientFile = () => join(midnaHome(), "client.json");
const args = process.argv.slice(2);
const json = args.includes("--json");
const out = (v: unknown) => console.log(JSON.stringify(v));

/** How to launch this same program again: the compiled binary, or bun + this script. */
function selfCommand(): string[] {
  return Bun.main.startsWith("/$bunfs/") || /^[A-Z]:\\~BUN/.test(Bun.main) ? [process.execPath] : [process.execPath, Bun.main];
}

function localUrl(): string {
  const c = loadConfig();
  return `http://${c.host.includes(":") ? `[${c.host}]` : c.host}:${c.port}`;
}

/** This machine's way in: the host's own token when midna lives here, else a connection made with `connect`. */
function client(): MidnaClient {
  if (process.env.MIDNA_URL && process.env.MIDNA_TOKEN) return new MidnaClient(process.env.MIDNA_URL, process.env.MIDNA_TOKEN);
  const tokenFile = paths().hostToken;
  if (existsSync(tokenFile)) return new MidnaClient(localUrl(), readFileSync(tokenFile, "utf8").trim());
  if (existsSync(clientFile())) {
    const c = JSON.parse(readFileSync(clientFile(), "utf8")) as ClientConfig;
    return new MidnaClient(c.url, c.token);
  }
  die("midna isn't set up on this machine. Run `midna setup` here, or `midna connect <url> <code>` to reach one elsewhere.");
}

function die(msg: string): never {
  if (json) out({ ok: false, error: msg });
  else console.error(msg);
  process.exit(1);
}

async function reach<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MidnaError) die(`midna: ${err.message}`);
    die(`can't reach midna — is it running? (\`midna serve\`, or \`midna service install\`)\n  ${(err as Error).message}`);
  }
}

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function flags(name: string): string[] {
  return args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));
}

async function waitForHealth(url: string, ms = 15_000): Promise<boolean> {
  const c = new MidnaClient(url);
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(300)) {
    if (await c.health().then(() => true, () => false)) return true;
  }
  return false;
}

function show(item: OutboxItem): void {
  const tag = item.kind === "message" ? "" : item.kind === "question" ? "[question] " : `[${item.priority}] `;
  console.log(`\n${tag}${item.text}${item.options?.length ? `\n  options: ${item.options.join(" / ")}` : ""}\n`);
}

/**
 * The PATH a login shell here would have. Over SSH, and under systemd, PATH is
 * bare (no ~/.local/bin, where `claude` usually lives); the service should see
 * what the user's own terminal sees.
 */
function loginPath(): string {
  const parts: string[] = [];
  const shell = process.env.SHELL;
  if (shell) {
    const r = Bun.spawnSync([shell, "-lic", 'printf "__MIDNA__%s__MIDNA__" "$PATH"'], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5_000 });
    const m = /__MIDNA__(.*?)__MIDNA__/s.exec(r.stdout.toString());
    if (m?.[1]) parts.push(...m[1].split(":"));
  }
  const home = process.env.HOME ?? "";
  parts.push(...(process.env.PATH ?? "").split(":"), `${home}/.local/bin`, `${home}/.bun/bin`, `${home}/.npm-global/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");
  return [...new Set(parts.filter(Boolean))].join(":");
}

// ── bridges: what the daemon is told about how to connect each one ────
const bridgeSetups: Record<string, BridgeSetup> = {
  telegram: async (input, ctx) => {
    if (!input.token) throw new Error("paste the bot token @BotFather gave you");
    const file = join(ctx.home, "telegram.json");
    const { username, pairCode } = await setupTelegram({ botToken: input.token.trim(), midnaUrl: ctx.url, pairingCode: ctx.pairingCode, deviceName: "Telegram bridge", file }).catch((err) => {
      throw new Error(/unauthorized|not found/i.test((err as Error).message) ? "Telegram didn't accept that token — copy it again from @BotFather" : (err as Error).message);
    });
    return {
      command: [...selfCommand(), "telegram", "run", "--state", file],
      result: { instructions: `Open @${username} in Telegram and send it this message. That makes the bot yours; it ignores everyone else.`, link: `https://t.me/${username}`, code: `/start ${pairCode}` },
    };
  },
};

// ── commands ───────────────────────────────────────────────────────────
async function serve(): Promise<void> {
  // MIDNA_NO_INTRO: a throwaway instance (tests, a trial install) shouldn't start an onboarding.
  const daemon = await startDaemon({ bridgeSetups, ...(process.env.MIDNA_NO_INTRO ? { introDelayMs: -1 } : {}) });
  const stop = async () => {
    console.log("stopping…");
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function chat(): Promise<void> {
  const c = client();
  const status = await reach(() => c.status());
  console.log(`${status.name} on ${status.host.name} · ${status.model} · ${status.mode}. Type to talk; Ctrl-D to leave.\n`);
  const abort = new AbortController();
  void (async () => {
    for (let since = status.outboxSeq; !abort.signal.aborted; await Bun.sleep(2_000)) {
      try {
        for await (const e of c.events(since, abort.signal)) {
          if (e.type === "outbox") {
            since = e.item.seq;
            show(e.item);
          } else if (e.type === "status" && e.state === "thinking") process.stdout.write("  …thinking\n");
          else if (e.type === "activity") process.stdout.write(`  · ${e.tool}\n`);
          else if (e.type === "user_message" && e.client !== "cli") console.log(`\n(you, via ${e.client}) ${e.text}`);
        }
      } catch {
        /* reconnect */
      }
    }
  })();
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  for await (const line of rl) {
    const text = line.trim();
    if (text) await reach(() => c.send({ text, client: "cli" }));
  }
  abort.abort();
}

/** Start the daemon here as a plain background process — for isolated installs without a service. */
async function startProcess(): Promise<void> {
  const log = openSync(join(paths().logs, "midna.log"), "a");
  const child = spawn(selfCommand()[0]!, [...selfCommand().slice(1), "serve"], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, PATH: loginPath() } });
  child.unref();
}

/** `setup --yes`: everything from flags, nothing asked — what a remote install runs. */
async function setupUnattended(): Promise<void> {
  ensureHome();
  const model = flag("--model");
  if (model) {
    const problem = checkModel(model);
    if (problem) die(problem);
  }
  const mode = flag("--mode");
  if (mode && mode !== "autonomous" && mode !== "ask") die("--mode is autonomous or ask");
  updateHostSettings({
    ...(model ? { model } : {}),
    ...(flag("--timezone") ? { timezone: flag("--timezone")! } : {}),
    ...(mode ? { mode: mode as "autonomous" | "ask" } : {}),
  });
  const config = loadConfig();
  if (flag("--port")) config.port = Number(flag("--port"));
  config.listen = [...new Set([...config.listen, ...flags("--listen")])];
  saveConfig(config);

  let service = "process";
  let notes: string[] = [];
  if (args.includes("--no-service")) await startProcess();
  else {
    notes = installService([...selfCommand(), "serve"], { PATH: loginPath() });
    service = platform() === "darwin" ? "launchd" : "systemd";
  }
  const url = localUrl();
  if (!(await waitForHealth(url, 30_000))) die(`midna didn't come up on ${url} — see ${join(paths().logs, "midna.log")}${service === "systemd" ? " or journalctl --user -u midna" : ""}`);
  if (json) out({ ok: true, url, version: VERSION, service, notes });
  else console.log(`midna ${VERSION} is running (${service}) on ${url}\n${notes.map((n) => `  ${n}`).join("\n")}`);
}

async function setup(): Promise<void> {
  if (args.includes("--yes")) return setupUnattended();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def = "") => (await rl.question(def ? `${q} [${def}] ` : `${q} `)).trim() || def;
  const yes = async (q: string, def: boolean) => /^y/i.test(await ask(`${q} (${def ? "Y/n" : "y/N"})`, def ? "y" : "n"));

  console.log(`Setting up midna on ${hostname()}.\n`);
  const current = hostSettings();
  const brains = installedBrains().filter((b) => b.installed);
  if (!brains.length) die("No agent CLI found. Install and sign in to one first — Claude Code (`claude`) is the default.");
  console.log(`Agent CLIs on this machine: ${brains.map((b) => b.id).join(", ")}`);
  console.log(`The brain is "<provider>:<model>" — e.g. claude:opus, claude:sonnet, codex:gpt-5.6-sol — or just a provider.`);
  let model = await ask("Brain?", current.model);
  for (let problem = checkModel(model); problem; problem = checkModel(model)) model = await ask(`${problem}\nBrain?`, "claude:opus");

  const timezone = await ask("Timezone?", current.timezone);
  const mode = (await yes("Let midna act on its own (autonomous mode)? You can switch to ask-first any time.", current.mode === "autonomous")) ? "autonomous" : "ask";
  updateHostSettings({ model, timezone, mode });
  console.log(`\nSaved: ${model}, ${timezone}, ${mode}.`);

  const url = localUrl();
  if (await yes(`\nRun midna in the background now and at every boot?`, true)) {
    for (const n of installService([...selfCommand(), "serve"], { PATH: loginPath() })) console.log(`  ${n}`);
    if (!(await waitForHealth(url))) console.log(`  midna didn't answer on ${url} yet — check the logs.`);
  } else {
    console.log("  Start it yourself with `midna serve`.");
  }

  if (await yes(`\nConnect a Telegram bot so midna can reach your phone?`, false)) {
    if (!(await waitForHealth(url, 2_000))) console.log("  midna isn't running, so Telegram can't be connected yet: start it, then `midna telegram setup`.");
    else await telegramSetup(rl);
  }
  rl.close();
  console.log(`\nDone. Talk to midna with \`midna chat\`${loadConfig().bridges.telegram ? " or on Telegram" : ""}. It will introduce itself and start getting to know you.`);
  console.log(`From another computer, the desktop app finds it over makima or Tailscale — or \`midna pair\` here and \`midna connect\` there.`);
}

async function telegramSetup(existing?: ReturnType<typeof createInterface>): Promise<void> {
  const rl = existing ?? createInterface({ input: process.stdin, output: process.stdout });
  let token = flag("--token");
  if (!token) {
    console.log("  1. In Telegram, open @BotFather and send /newbot. Pick any name.");
    console.log("  2. Paste the token it gives you.");
    token = (await rl.question("  Bot token: ")).trim();
  }
  if (!existing) rl.close();
  const r = await reach(() => client().setupBridge("telegram", { token: token! }));
  console.log(`\n  ${r.instructions}\n\n      ${r.link}\n      ${r.code}\n`);
}

async function hostInstall(): Promise<void> {
  const target = args[2];
  if (!target || target.startsWith("--")) die("usage: midna host install <machine> — `midna devices` lists them");
  const devices = await discover();
  const device = devices.find((d) => d.id === target || d.name.toLowerCase() === target.toLowerCase() || d.address === target);
  if (!device) die(`no machine called "${target}" — \`midna devices\` lists the ones this computer can see`);
  if (!device.online) die(`${device.name} is offline`);
  const current = hostSettings();
  const emit = (e: InstallEvent) => {
    if (json) return out(e);
    if (e.type === "step") console.log(`${e.status === "done" ? "✓" : e.status === "failed" ? "✗" : e.status === "skipped" ? "–" : "…"} ${e.title}${e.detail ? ` — ${e.detail}` : ""}`);
    else if (e.type === "failed") console.log(`\n${e.message}${e.hint ? `\n${e.hint}` : ""}${e.action ? `\n  to fix: ${e.action.terminal.join(" ")}` : ""}`);
    else if (e.type === "done") {
      ensureHome();
      writePrivate(clientFile(), JSON.stringify({ url: e.connection.url, token: e.connection.token } satisfies ClientConfig, null, 2) + "\n");
      console.log(`\nmidna lives on ${e.connection.host} now (${e.connection.url}). This machine's CLI is paired with it.`);
    }
  };
  const ok = await install(
    device,
    {
      model: flag("--model") ?? current.model,
      timezone: flag("--timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      mode: (flag("--mode") as "autonomous" | "ask") ?? "autonomous",
      ...(flag("--port") ? { port: Number(flag("--port")) } : {}),
      ...(flag("--home") ? { home: flag("--home")! } : {}),
      ...(flag("--bin") ? { bin: flag("--bin")! } : {}),
      ...(flag("--device-name") ? { deviceName: flag("--device-name")! } : {}),
      noService: args.includes("--no-service"),
      noIntro: args.includes("--no-intro"),
      skipBrainCheck: args.includes("--skip-brain-check"),
      kits: [...flags("--kits"), ...defaultKits()],
    },
    emit,
  );
  if (!ok) process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "serve":
      return serve();
    case "setup":
      return setup();
    case "chat":
      return chat();
    case "send": {
      const text = rest.filter((a) => a !== "--json").join(" ").trim();
      if (!text) die("usage: midna send <text>");
      await reach(() => client().send({ text, client: "cli" }));
      return console.log("sent — the reply arrives on your clients (or `midna chat`).");
    }
    case "status": {
      const s = await reach(() => client().status());
      if (json) return out(s);
      return console.log(`${s.name} ${s.version} on ${s.host.name}\n  mode      ${s.mode}\n  model     ${s.model}\n  timezone  ${s.timezone}\n  ${s.busy ? "working" : "idle"} · ${s.pendingWakeups} scheduled wakeup(s)`);
    }
    case "version":
    case "--version":
      if (json) return out({ version: VERSION, platform: `${platform()}-${arch()}`, configured: existsSync(paths().db) });
      return console.log(VERSION);
    case "doctor": {
      const live = flag("--live");
      const report = { version: VERSION, brains: installedBrains(), ...(live ? { live: await checkBrainLive(live) } : {}) };
      if (json) return out(report);
      for (const b of report.brains) console.log(`${b.installed ? "✓" : "·"} ${b.id.padEnd(10)} ${b.label}${b.installed ? "" : `  (${b.installHint})`}`);
      if (report.live) console.log(report.live.ok ? `\n${live} answers.` : `\n${live}: ${report.live.message}`);
      return;
    }
    case "mode": {
      const c = client();
      if (!rest[0]) return console.log((await reach(() => c.status())).mode);
      if (rest[0] !== "autonomous" && rest[0] !== "ask") die("mode is `autonomous` or `ask`");
      return console.log(`mode: ${(await reach(() => c.updateSettings({ mode: rest[0] as "autonomous" | "ask" }))).mode}`);
    }
    case "model": {
      const c = client();
      if (!rest[0]) return console.log((await reach(() => c.status())).model);
      return console.log(`model: ${(await reach(() => c.updateSettings({ model: rest[0] }))).model}`);
    }
    case "pair": {
      const { code, expiresAt } = await reach(() => client().pairingCode());
      if (json) return out({ code, expiresAt });
      return console.log(`Pairing code: ${code}  (single use, expires ${new Date(expiresAt).toLocaleTimeString()})\nOn the other machine: midna connect <url> ${code}`);
    }
    case "connect": {
      const [url, code] = rest;
      if (!url || !code) die("usage: midna connect <url> <code>   e.g. midna connect http://10.77.0.1:7717 ABCD2345");
      const c = new MidnaClient(url);
      const health = await reach(() => c.health());
      const paired = await reach(() => c.pair({ code, deviceName: `${hostname()} (cli)`, kind: "cli" }));
      ensureHome();
      writePrivate(clientFile(), JSON.stringify({ url, token: paired.token } satisfies ClientConfig, null, 2) + "\n");
      return console.log(`Connected to ${health.name} at ${url}. Try \`midna chat\`.`);
    }
    case "devices": {
      const devices = await discover();
      if (json) return out(devices);
      for (const d of devices) {
        const state = !d.online ? "offline" : d.midna.running ? `midna ${d.midna.version} running` : "online";
        console.log(`${d.id.padEnd(24)} ${d.name.padEnd(20)} ${(d.self ? "this computer" : `${d.via} ${d.address}`).padEnd(22)} ${state}`);
      }
      return;
    }
    case "host":
      if (rest[0] === "install") return hostInstall();
      return die(`usage: midna host install <machine>   (steps: ${Object.values(STEPS).join(" → ")})`);
    case "paired": {
      const c = client();
      if (rest[0] === "revoke" && rest[1]) {
        await reach(() => c.revokeDevice(rest[1]!));
        return console.log(`revoked ${rest[1]}`);
      }
      for (const d of await reach(() => c.devices())) {
        console.log(`${d.id}  ${d.kind.padEnd(7)} ${d.name}${d.last_seen_at ? `  (seen ${new Date(d.last_seen_at).toLocaleString()})` : ""}`);
      }
      return;
    }
    case "telegram": {
      if (rest[0] === "setup") return telegramSetup();
      if (rest[0] === "run") {
        const file = flag("--state") ?? join(midnaHome(), "telegram.json");
        const bridge = new TelegramBridge(file, process.env.MIDNA_URL ? { midnaUrl: process.env.MIDNA_URL } : {});
        process.on("SIGTERM", () => (bridge.stop(), process.exit(0)));
        return bridge.run();
      }
      return die("usage: midna telegram setup | run [--state <file>]");
    }
    case "service": {
      if (rest[0] === "install") return void installService([...selfCommand(), "serve"], { PATH: loginPath() }).forEach((n) => console.log(n));
      if (rest[0] === "uninstall") return void uninstallService().forEach((n) => console.log(n));
      if (rest[0] === "restart") return restartService() ? console.log("restarted") : die("restart failed — is the service installed? (`midna service install`)");
      if (rest[0] === "status" || !rest[0]) return console.log(serviceInstalled() ? "installed" : "not installed");
      return die("usage: midna service install|uninstall|restart|status");
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return console.log(HELP);
    default:
      die(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

await main();
