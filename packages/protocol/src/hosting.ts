/**
 * The contract between the desktop app and the `midna` binary it carries:
 * what `midna devices --json` and `midna host install --json` print. The app
 * drives hosting entirely through these — it never speaks SSH itself.
 */

export interface DiscoveredDevice {
  /** Stable key: "local", "makima:tenet", "tailscale:tenet". */
  id: string;
  name: string;
  via: "local" | "makima" | "tailscale";
  /** Where the machine answers: a mesh or tailnet address; 127.0.0.1 for this one. */
  address: string;
  /** What `ssh` is given to reach it (nothing for this machine). */
  sshTarget: string | null;
  online: boolean;
  self: boolean;
  os?: string;
  /** An address midna must listen on to be reachable this way — Tailscale doesn't carry loopback. */
  listen?: string;
  midna: { running: boolean; version?: string; name?: string; url?: string; /** Its HTTPS address on the tailnet, when it advertises one (hosts after 0.13.2). */ https?: string };
}

export type InstallStepId = "reach" | "binary" | "brain" | "start" | "hermes" | "pair";

export const INSTALL_STEPS: Record<InstallStepId, string> = {
  reach: "Reach the machine",
  binary: "Put midna on it",
  brain: "Check its brain",
  start: "Start midna",
  hermes: "Connect Hermes",
  pair: "Pair this computer",
};

export interface Connection {
  url: string;
  token: string;
  name: string;
  /** The machine's name, and how to SSH to it (for a sign-in there); null when it's this computer. */
  host: string;
  ssh: string | null;
  device: string;
  /** The daemon's Ed25519 public key from pairing (PairResponse.daemonKey), for device hands to pin. Absent before 0.8. */
  daemonKey?: string;
}

export type InstallEvent =
  | { type: "step"; id: InstallStepId; status: "running" | "done" | "skipped" | "failed"; title: string; detail?: string }
  | { type: "progress"; id: InstallStepId; done: number; total: number }
  | { type: "done"; connection: Connection }
  | { type: "failed"; id: InstallStepId; message: string; hint?: string; action?: { label: string; terminal: string[] } };

// ── HTTPS on the tailnet ─────────────────────────────────────────────────
// The app's web view refuses plain http to a Tailscale address (App Transport
// Security): chat never loads, while the hands connection, from Rust, works.
// So the app talks to midna through `tailscale serve`'s HTTPS address.

/** The port `tailscale serve` gives midna on the tailnet, by convention. */
export const TAILNET_HTTPS_PORT = 8443;

/** A Tailscale address: 100.64.0.0/10, Tailscale's fd7a:115c:a1e0::/48, or a MagicDNS name. */
export function onTailnet(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h.endsWith(".ts.net")) return true;
  if (h.startsWith("fd7a:115c:a1e0:")) return true;
  const v4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  return !!v4 && Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
}

/** Plain http to a tailnet address, which the app's window can't load. */
export function webViewBlocks(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && onTailnet(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Where midna may answer over HTTPS, most trusted first: the address it
 * advertises (Health.https), then its MagicDNS name on the conventional port
 * (a host of 0.13.2 or older advertises nothing). Each still has to answer as
 * midna before it's used.
 */
export function httpsCandidates(from: { ssh?: string | null; https?: string | null }): string[] {
  const out: string[] = [];
  if (from.https?.startsWith("https://")) out.push(from.https.replace(/\/+$/, ""));
  const name = from.ssh?.replace(/^[^@]*@/, "").replace(/\.$/, "");
  if (name?.toLowerCase().endsWith(".ts.net")) out.push(`https://${name}:${TAILNET_HTTPS_PORT}`);
  return [...new Set(out)];
}

/** What, run on midna's host, gives it an HTTPS address on the tailnet. */
export function serveCommand(port: number): string {
  return `tailscale serve --bg --https=${TAILNET_HTTPS_PORT} http://127.0.0.1:${port}`;
}

/** The answer to `midna host https <url> --json`: the HTTPS address found, or what to do about there being none. */
export type HttpsFound = { url: string } | { url: null; message: string; command: string };
