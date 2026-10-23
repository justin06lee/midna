import { existsSync, readFileSync } from "node:fs";
import { hostname, homedir, platform, release } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Store } from "@midna/core";
import { Assistant, type Brain } from "@midna/agent";
import { MAX_ATTACHMENT_BYTES, UNSENT_ATTACHMENT_TTL_MS, type BridgeSetupResult } from "@midna/protocol";
import { Bridges } from "./bridges.ts";
import { ensureHome, isWildcard, listenAddresses, loadConfig, midnaHome, saveConfig, writePrivate } from "./config.ts";
import { HandsHub } from "./hands.ts";
import { JobRunner } from "./jobs.ts";
import { createApp } from "./server.ts";
import { VERSION } from "./version.ts";

/** How long inbound events are kept, and so how long a resent id still counts as a duplicate. */
const INBOUND_EVENTS_KEPT = 30 * 24 * 60 * 60_000;
/** How long device hands' audit log keeps a command, and an approval. */
const DEVICE_COMMANDS_KEPT = 90 * 24 * 60 * 60_000;
/** How long an ended job's record and folder (its log, its result unless it put that elsewhere) are kept. */
const JOBS_KEPT = 30 * 24 * 60 * 60_000;

export interface DaemonOptions {
  home?: string;
  port?: number;
  host?: string;
  /** Swap the model for tests. */
  brain?: Brain;
  /** Scheduler tick; tests make it short. */
  tickMs?: number;
  /** How soon a brand-new midna introduces itself. */
  introDelayMs?: number;
  /** How close together the user's messages make one interrupt; tests make it short. */
  coalesceMs?: number;
  /** How soon after a due follow-up another may come due and still run in its turn (default 5 min). */
  joinMs?: number;
  /** Device hands: how long an approval waits, and how long past its timeout a result may come; tests make both short. */
  approvalMs?: number;
  handsGraceMs?: number;
  /** How jobs are launched, and how often they're looked at; tests set both. */
  jobs?: { launcher?: "systemd" | "setsid"; pollMs?: number; claudeBin?: string | null };
  /** Try the brain once at startup (a tiny real turn). Off by default when a brain is injected. */
  checkBrainOnStart?: boolean;
  /**
   * How to connect each kind of bridge. The daemon knows bridges only by
   * name: the program hosting it says what a bridge is and how to launch it.
   */
  bridgeSetups?: Record<string, BridgeSetup>;
}

/** Connect one bridge: given the user's input, set it up and say how to launch it. */
export type BridgeSetup = (
  input: Record<string, string>,
  ctx: { url: string; pairingCode: string; home: string },
) => Promise<{ command: string[]; result: BridgeSetupResult }>;

export interface RunningDaemon {
  url: string;
  store: Store;
  assistant: Assistant;
  hands: HandsHub;
  jobs: JobRunner;
  stop(): Promise<void>;
}

/**
 * The host's own device token lives in a private file beside the database,
 * so the CLI on this machine can always reach the daemon without pairing.
 */
function hostToken(store: Store, file: string): string {
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (store.devices.authenticate(token)) return token;
  }
  const { token } = store.devices.create(`${hostname()} (host)`, "host");
  writePrivate(file, token + "\n");
  return token;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const home = opts.home ?? midnaHome();
  const p = ensureHome(home);
  const config = loadConfig(home);
  const store = Store.open(p.db);
  hostToken(store, p.hostToken);
  const mcpToken = "mcp_" + randomBytes(24).toString("base64url");

  const port = opts.port ?? config.port;
  const host = opts.host ?? config.host;
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

  const hands = new HandsHub({
    store,
    keyFile: p.handsKey,
    ...(opts.approvalMs !== undefined ? { approvalMs: opts.approvalMs } : {}),
    ...(opts.handsGraceMs !== undefined ? { graceMs: opts.handsGraceMs } : {}),
  });

  // A job that ends queues its wakeup; the scheduler runs it now rather than at its next tick.
  let tickSoon = () => {};
  const jobs = new JobRunner({
    store,
    root: join(home, "jobs"),
    workspace: p.workspace,
    ...opts.jobs,
    onEnded: () => tickSoon(),
  });

  const assistant = new Assistant({
    store,
    hands,
    env: { hostName: hostname(), platform: `${platform()} ${release()}`, workspace: p.workspace, home: homedir() },
    mcp: { url: (episode) => `${base}/mcp/${episode}`, token: mcpToken },
    ...(opts.brain ? { brain: opts.brain } : {}),
    ...(opts.coalesceMs !== undefined ? { coalesceMs: opts.coalesceMs } : {}),
  });

  const bridges = new Bridges({ MIDNA_URL: base });
  const app = createApp({
    store,
    assistant,
    hands,
    jobs,
    workspace: p.workspace,
    mcpToken,
    reloadBridges: () => bridges.sync(loadConfig(home).bridges),
    bridges: () => {
      const configured = loadConfig(home).bridges;
      const names = new Set([...Object.keys(opts.bridgeSetups ?? {}), ...Object.keys(configured)]);
      return [...names].map((name) => ({ name, enabled: !!configured[name]?.enabled }));
    },
    setupBridge: async (name, input) => {
      const setup = opts.bridgeSetups?.[name];
      if (!setup) throw new Error(`midna doesn't know a bridge called "${name}"`);
      const { command, result } = await setup(input, { url: base, pairingCode: store.devices.pairingCode().code, home });
      const config = loadConfig(home);
      // Setting a bridge up again keeps how it was told to behave.
      config.bridges[name] = { command, enabled: true, ...(config.bridges[name]?.mode ? { mode: config.bridges[name]!.mode } : {}) };
      saveConfig(config, home);
      bridges.sync(config.bridges);
      return result;
    },
    onSettingsChanged: (changed) => {
      if (changed.timezone) store.schedule.retime(changed.timezone);
      if (changed.hands === "paused") hands.pauseAll();
    },
  });

  // idleTimeout 0: the event stream is long-lived and keeps itself alive. Bodies may carry
  // an attachment up to the limit; past it the upload route answers 413 itself.
  const serving = { fetch: app.fetch, idleTimeout: 0, maxRequestBodySize: MAX_ATTACHMENT_BYTES + 1024 * 1024 };
  const server = Bun.serve({ hostname: host, port, ...serving });

  // Extra addresses may not exist yet at boot (a VPN interface comes up late), or ever
  // again once the VPN is gone: keep trying, and say once what isn't there.
  const extra = new Map<string, { stop(force?: boolean): void }>();
  const told = new Set<string>();
  const waiting = (what: string) => told.has(what) || (told.add(what), console.log(`  waiting   for ${what}`));
  for (const entry of config.listen.filter(isWildcard)) console.error(`[midna] not listening on "${entry}": that is every network, the LAN too — name one address or interface`);
  const bindExtra = () => {
    for (const entry of config.listen.filter((e) => !isWildcard(e))) {
      const addrs = listenAddresses(entry);
      if (!addrs.length) waiting(entry);
      for (const addr of addrs) {
        if (extra.has(addr) || addr === host) continue;
        const at = `${addr.includes(":") ? `[${addr}]` : addr}:${port}`;
        try {
          extra.set(addr, Bun.serve({ hostname: addr, port, ...serving }));
          console.log(`  also on   ${at}`);
        } catch {
          waiting(at);
        }
      }
    }
  };
  bindExtra();
  const bindTimer = setInterval(bindExtra, 30_000);

  const recovered = store.schedule.recover();
  store.schedule.retime(store.settings().timezone);
  assistant.ensureRituals();
  assistant.ensureIntroduced(opts.introDelayMs);
  const stillRunning = jobs.reconcile();
  const revived = assistant.reviveBrainFailures();
  if (revived) console.log(`  revived   ${revived} wakeup(s) that failed for want of a brain`);
  if (assistant.answerLeftovers()) console.log(`  answering what the user wrote before the restart`);
  // Know at once whether midna can think, rather than at the first thing it tries.
  if (opts.checkBrainOnStart ?? !opts.brain) void assistant.checkBrain().then((h) => {
    if (h.ok === false) console.error(`[midna] the brain can't be reached: ${h.message}`);
  });

  const tz = () => store.settings().timezone;
  let swept = 0;
  const tick = () => {
    store.outbox.release();
    // Hourly: uploads nobody sent, files staged by turns that never replied, and old events.
    if (Date.now() - swept > 60 * 60_000) {
      swept = Date.now();
      const n = store.attachments.sweep(swept - UNSENT_ATTACHMENT_TTL_MS);
      if (n) console.log(`[midna] deleted ${n} attachment(s) never sent`);
      store.inbound.prune(swept - INBOUND_EVENTS_KEPT);
      store.hands.prune(swept - DEVICE_COMMANDS_KEPT);
      jobs.prune(swept - JOBS_KEPT);
    }
    // Follow-ups due within minutes of each other run as one turn; what becomes of it becomes of each.
    for (const [first, ...joined] of store.schedule.claimTurns(Date.now(), opts.joinMs)) {
      void assistant.wakeup(first!, joined).then((r) => {
        for (const w of [first!, ...joined]) {
          if (typeof r === "object") store.schedule.postpone(w.id, r.retryAt);
          else store.schedule.finish(w.id, r === "done", tz());
        }
      });
    }
  };
  const timer = setInterval(tick, opts.tickMs ?? 15_000);
  tickSoon = () => void setTimeout(tick, 0);
  tick();

  bridges.sync(config.bridges);

  const s = store.settings();
  console.log(`midna ${VERSION} — listening on ${base}`);
  console.log(`  home      ${home}`);
  console.log(`  brain     ${s.model} (${s.mode})`);
  console.log(`  timezone  ${s.timezone}`);
  if (recovered) console.log(`  recovered ${recovered} interrupted wakeup(s)`);
  if (stillRunning) console.log(`  jobs      ${stillRunning} still running`);
  if (Object.keys(config.bridges).length) console.log(`  bridges   ${Object.entries(config.bridges).filter(([, b]) => b.enabled).map(([n]) => n).join(", ") || "none enabled"}`);

  return {
    url: base,
    store,
    assistant,
    hands,
    jobs,
    async stop() {
      clearInterval(timer);
      // The jobs themselves keep running: the next start picks them up.
      jobs.shutdown();
      clearInterval(bindTimer);
      for (const s of extra.values()) s.stop(true);
      bridges.stopAll();
      hands.shutdown();
      await assistant.shutdown();
      server.stop(true);
      store.close();
    },
  };
}
