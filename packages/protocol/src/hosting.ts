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
  midna: { running: boolean; version?: string; name?: string; url?: string };
}

export type InstallStepId = "reach" | "binary" | "brain" | "start" | "pair";

export const INSTALL_STEPS: Record<InstallStepId, string> = {
  reach: "Reach the machine",
  binary: "Put midna on it",
  brain: "Check its brain",
  start: "Start midna",
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
}

export type InstallEvent =
  | { type: "step"; id: InstallStepId; status: "running" | "done" | "skipped" | "failed"; title: string; detail?: string }
  | { type: "progress"; id: InstallStepId; done: number; total: number }
  | { type: "done"; connection: Connection }
  | { type: "failed"; id: InstallStepId; message: string; hint?: string; action?: { label: string; terminal: string[] } };
