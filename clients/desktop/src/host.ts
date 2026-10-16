import type { Connection, DiscoveredDevice, InstallEvent } from "@midna/protocol";

/**
 * Everything the window asks of the computer it runs on. In the app that is
 * Rust (which runs the bundled `midna`); in a plain browser — the preview
 * used while working on the interface — it is the dev server running the CLI
 * from source, and localStorage.
 */

export const inApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The app on macOS draws into its title bar, around the traffic lights; elsewhere the system's title bar sits above the page. */
export const macTitleBar = inApp && /Mac/.test(navigator.userAgent);

interface RunResult { code: number; stderr: string }

/** Run `midna <args>`, calling `onLine` for each line it prints. */
async function runMidna(args: string[], onLine: (line: string) => void): Promise<RunResult> {
  if (inApp) {
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    const channel = new Channel<string>();
    channel.onmessage = onLine;
    return invoke<RunResult>("midna", { args, onLine: channel });
  }
  const res = await fetch("/dev/midna", { method: "POST", body: JSON.stringify(args) });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.startsWith("\u0000")) return JSON.parse(line.slice(1)) as RunResult;
      if (line) onLine(line);
    }
  }
  const tail = buf.lastIndexOf("\u0000");
  return tail >= 0 ? (JSON.parse(buf.slice(tail + 1)) as RunResult) : { code: 0, stderr: "" };
}

/** Machines midna could live on: this one, makima peers, Tailscale peers. */
export async function discoverDevices(): Promise<DiscoveredDevice[]> {
  let out = "";
  const r = await runMidna(["devices", "--json"], (l) => (out += l));
  if (r.code !== 0) throw new Error(r.stderr.trim() || "couldn't look for machines");
  return JSON.parse(out) as DiscoveredDevice[];
}

export interface InstallChoices { model: string; timezone: string; mode: "autonomous" | "ask"; deviceName: string }

/** Make `device` midna's home and pair this computer with it, reporting every step. */
export async function installOn(device: DiscoveredDevice, choices: InstallChoices, onEvent: (e: InstallEvent) => void): Promise<void> {
  const args = ["host", "install", device.id, "--json", "--model", choices.model, "--timezone", choices.timezone, "--mode", choices.mode, ...(choices.deviceName ? ["--device-name", choices.deviceName] : [])];
  const r = await runMidna(args, (line) => {
    try {
      onEvent(JSON.parse(line) as InstallEvent);
    } catch {
      /* not an event */
    }
  });
  if (r.code !== 0 && r.code !== 1) onEvent({ type: "failed", id: "reach", message: r.stderr.trim() || `midna exited with ${r.code}` });
}

// ── the connection: which midna, and this app's token for it ─────────────
const KEY = "midna.connection";

export async function loadConnection(): Promise<Connection | null> {
  if (inApp) return (await (await import("@tauri-apps/api/core")).invoke<Connection | null>("connection_load")) ?? null;
  const s = localStorage.getItem(KEY);
  return s ? (JSON.parse(s) as Connection) : null;
}

export async function saveConnection(c: Connection): Promise<void> {
  if (inApp) return (await import("@tauri-apps/api/core")).invoke("connection_save", { value: c });
  localStorage.setItem(KEY, JSON.stringify(c));
}

export async function clearConnection(): Promise<void> {
  if (inApp) return (await import("@tauri-apps/api/core")).invoke("connection_clear");
  localStorage.removeItem(KEY);
}

// ── small things a web view can't do alone ───────────────────────────────
export async function openTerminal(argv: string[]): Promise<void> {
  if (inApp) return (await import("@tauri-apps/api/core")).invoke("open_terminal", { argv });
  console.info("[preview] would open a terminal running:", argv.join(" "));
}

export async function openUrl(url: string): Promise<void> {
  if (inApp) return (await import("@tauri-apps/plugin-opener")).openUrl(url);
  window.open(url, "_blank", "noopener");
}

// ── files midna sent: the bytes go to Rust raw, the name in a header ─────
async function hand(command: string, blob: Blob, headers: Record<string, string>): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>(command, new Uint8Array(await blob.arrayBuffer()), { headers });
}

/** Save a file into Downloads, under a name of its own if that one is taken. Answers where it went (the preview hands it to the browser, and can't say). */
export async function saveToDownloads(name: string, blob: Blob): Promise<string | null> {
  if (inApp) return hand("save_download", blob, { "x-name": encodeURIComponent(name) });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return null;
}

/** Show a file this app saved in Finder (or the file manager). */
export async function showInFolder(path: string): Promise<void> {
  if (inApp) return (await import("@tauri-apps/api/core")).invoke("show_in_folder", { path });
}

/** Open a file in the app the system picks for it: Preview for a PDF, Archive Utility for a zip. */
export async function openInApp(id: string, name: string, blob: Blob): Promise<void> {
  if (inApp) return void (await hand("open_attachment", blob, { "x-id": id, "x-name": encodeURIComponent(name) }));
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Files copied in Finder, in the order they were copied: WebKit gives a paste only the first of several. Empty outside the app. */
export async function copiedFiles(): Promise<Array<{ name: string; size: number; read: () => Promise<ArrayBuffer> }>> {
  if (!inApp) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  const copied = await invoke<Array<{ path: string; name: string; size: number }>>("copied_files");
  return copied.map((c) => ({ name: c.name, size: c.size, read: () => invoke<ArrayBuffer>("read_copied", { path: c.path }) }));
}

export async function copy(text: string): Promise<void> {
  if (inApp) return (await import("@tauri-apps/plugin-clipboard-manager")).writeText(text);
  await navigator.clipboard.writeText(text);
}

/** A system notification, when the window isn't what the user is looking at. */
export async function notify(title: string, body: string): Promise<void> {
  if (document.hasFocus()) return;
  if (inApp) {
    const n = await import("@tauri-apps/plugin-notification");
    if (!(await n.isPermissionGranted()) && (await n.requestPermission()) !== "granted") return;
    n.sendNotification({ title, body });
    return;
  }
  if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
}

export async function launchAtLogin(on?: boolean): Promise<boolean> {
  if (!inApp) return false;
  const a = await import("@tauri-apps/plugin-autostart");
  if (on === true) await a.enable();
  if (on === false) await a.disable();
  return a.isEnabled();
}
