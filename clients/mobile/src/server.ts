import { DEFAULT_PORT } from "@midna/protocol";

/**
 * Where midna is, as typed on a phone: "midna", "midna:7717", "10.77.0.1"
 * or a whole URL. Inside a private network it is plain HTTP on midna's port; a URL
 * with its own scheme is taken as it is. Null when it isn't an address.
 */
export function serverUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const schemed = /^[a-z][a-z0-9+.-]*:\/\//i.test(t);
  try {
    const u = new URL(schemed ? t : `http://${t}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    if (!schemed && !u.port) u.port = String(DEFAULT_PORT);
    return u.origin;
  } catch {
    return null;
  }
}

/** Whether two URLs are the same midna — the only one an old token may be named to (as `replaces`). */
export function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
