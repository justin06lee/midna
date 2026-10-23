import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir, networkInterfaces, platform } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT } from "@midna/protocol";

/**
 * Where midna lives on the host. One directory holds the database, the
 * daemon config, the host's own token, the agent's workspace and logs.
 * MIDNA_HOME overrides it (tests, a second instance).
 */
export function midnaHome(): string {
  if (process.env.MIDNA_HOME) return process.env.MIDNA_HOME;
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "midna");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "midna");
}

export interface BridgeConfig {
  /** argv of the bridge process; it reaches midna through the public API only. */
  command: string[];
  enabled: boolean;
  /** How much the bridge forwards, handed to it as MIDNA_BRIDGE_MODE; the bridge decides what a value means. */
  mode?: string;
}

export interface DaemonConfig {
  /** Loopback by default — makima publishes loopback services to the mesh by itself. */
  host: string;
  port: number;
  /**
   * More addresses to answer on, e.g. this machine's Tailscale IP — Tailscale,
   * unlike makima, does not carry loopback services to the other machines.
   * An entry is an IP, or an interface by name ("tailscale0"): whatever
   * addresses it has. Never a wildcard — see listenAddresses.
   */
  listen: string[];
  bridges: Record<string, BridgeConfig>;
}

const DEFAULTS: DaemonConfig = { host: "127.0.0.1", port: DEFAULT_PORT, listen: [], bridges: {} };

export function paths(home = midnaHome()) {
  return {
    home,
    db: join(home, "midna.db"),
    config: join(home, "config.json"),
    hostToken: join(home, "host.token"),
    /** The Ed25519 key device hands' commands are signed with. */
    handsKey: join(home, "hands.key"),
    workspace: join(home, "workspace"),
    logs: join(home, "logs"),
  };
}

export function ensureHome(home = midnaHome()): ReturnType<typeof paths> {
  const p = paths(home);
  for (const dir of [p.home, p.workspace, p.logs]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return p;
}

export function loadConfig(home = midnaHome()): DaemonConfig {
  const file = paths(home).config;
  if (!existsSync(file)) return structuredClone(DEFAULTS);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<DaemonConfig>;
  // A hand-edited `"listen": "tailscale0"` or `null` still means what it says.
  return { ...structuredClone(DEFAULTS), ...raw, listen: [raw.listen ?? []].flat(), bridges: { ...raw.bridges } };
}

/** 0.0.0.0, ::, "" and their spellings: every network at once, the LAN included. */
export const isWildcard = (addr: string) => /^(::ffff:)?[0:.]*$/i.test(addr);

/**
 * The addresses one `listen` entry stands for right now. An IP stands for
 * itself; anything else names an interface and stands for the addresses it
 * has at the moment — none while it is down or gone. Link-local addresses
 * are left out, and a wildcard is never one: it would open midna to every
 * network instead of one.
 */
export function listenAddresses(entry: string, interfaces = networkInterfaces()): string[] {
  const addrs = isIP(entry) ? [entry] : (interfaces[entry] ?? []).map((a) => a.address).filter((a) => !/^fe[89ab]/i.test(a));
  return addrs.filter((a) => !isWildcard(a));
}

/** Written atomically and private: it may hold bridge launch commands with secrets in their state paths. */
export function saveConfig(config: DaemonConfig, home = midnaHome()): void {
  const file = paths(home).config;
  writeFileSync(file + ".tmp", JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
  chmodSync(file, 0o600);
}

export function writePrivate(file: string, contents: string): void {
  writeFileSync(file + ".tmp", contents, { mode: 0o600 });
  renameSync(file + ".tmp", file);
  chmodSync(file, 0o600);
}
