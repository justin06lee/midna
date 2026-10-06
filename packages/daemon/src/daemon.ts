import { existsSync, readFileSync } from "node:fs";
import { hostname, homedir, platform, release } from "node:os";
import { randomBytes } from "node:crypto";
import { Store } from "@midna/core";
import { Assistant, type Brain } from "@midna/agent";
import type { BridgeSetupResult } from "@midna/protocol";
import { Bridges } from "./bridges.ts";
import { ensureHome, loadConfig, midnaHome, saveConfig, writePrivate } from "./config.ts";
import { createApp } from "./server.ts";
import { VERSION } from "./version.ts";

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

  const assistant = new Assistant({
    store,
    env: { hostName: hostname(), platform: `${platform()} ${release()}`, workspace: p.workspace, home: homedir() },
    mcp: { url: (episode) => `${base}/mcp/${episode}`, token: mcpToken },
    ...(opts.brain ? { brain: opts.brain } : {}),
  });

  const bridges = new Bridges({ MIDNA_URL: base });
  const app = createApp({
    store,
    assistant,
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
      config.bridges[name] = { command, enabled: true };
      saveConfig(config, home);
      bridges.sync(config.bridges);
      return result;
    },
    onSettingsChanged: (changed) => {
      if (changed.timezone) store.schedule.retime(changed.timezone);
    },
  });

  // idleTimeout 0: the event stream is long-lived and keeps itself alive.
  const server = Bun.serve({ hostname: host, port, fetch: app.fetch, idleTimeout: 0 });

  // Extra addresses may not exist yet at boot (a VPN interface comes up late): keep trying.
  const extra = new Map<string, { stop(force?: boolean): void }>();
  const bindExtra = () => {
    for (const addr of config.listen) {
      if (extra.has(addr) || addr === host) continue;
      try {
        extra.set(addr, Bun.serve({ hostname: addr, port, fetch: app.fetch, idleTimeout: 0 }));
        console.log(`  also on   ${addr}:${port}`);
      } catch {
        /* not there yet */
      }
    }
  };
  bindExtra();
  const bindTimer = setInterval(bindExtra, 30_000);

  const recovered = store.schedule.recover();
  store.schedule.retime(store.settings().timezone);
  assistant.ensureRituals();
  assistant.ensureIntroduced(opts.introDelayMs);
  const revived = assistant.reviveBrainFailures();
  if (revived) console.log(`  revived   ${revived} wakeup(s) that failed for want of a brain`);
  // Know at once whether midna can think, rather than at the first thing it tries.
  if (opts.checkBrainOnStart ?? !opts.brain) void assistant.checkBrain().then((h) => {
    if (h.ok === false) console.error(`[midna] the brain can't be reached: ${h.message}`);
  });

  const tz = () => store.settings().timezone;
  const tick = () => {
    store.outbox.release();
    for (const w of store.schedule.claimDue()) {
      void assistant.wakeup(w).then((r) => (typeof r === "object" ? store.schedule.postpone(w.id, r.retryAt) : store.schedule.finish(w.id, r === "done", tz())));
    }
  };
  const timer = setInterval(tick, opts.tickMs ?? 15_000);
  tick();

  bridges.sync(config.bridges);

  const s = store.settings();
  console.log(`midna ${VERSION} — listening on ${base}`);
  console.log(`  home      ${home}`);
  console.log(`  brain     ${s.model} (${s.mode})`);
  console.log(`  timezone  ${s.timezone}`);
  if (recovered) console.log(`  recovered ${recovered} interrupted wakeup(s)`);
  if (Object.keys(config.bridges).length) console.log(`  bridges   ${Object.entries(config.bridges).filter(([, b]) => b.enabled).map(([n]) => n).join(", ") || "none enabled"}`);

  return {
    url: base,
    store,
    assistant,
    async stop() {
      clearInterval(timer);
      clearInterval(bindTimer);
      for (const s of extra.values()) s.stop(true);
      bridges.stopAll();
      await assistant.shutdown();
      server.stop(true);
      store.close();
    },
  };
}
