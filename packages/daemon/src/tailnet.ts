import { existsSync } from "node:fs";

/**
 * midna's HTTPS address on the tailnet, as `tailscale serve` gives it: the
 * address /healthz advertises, so the desktop app (whose window can't use
 * plain http to a Tailscale address) connects through it.
 */

interface ServeStatus {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string }> }>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "0.0.0.0"]);

/** The `https://name[:port]` whose root `tailscale serve` proxies to midna on `port`, from `tailscale serve status --json`. */
export function servedHttps(status: ServeStatus | null | undefined, port: number): string | null {
  for (const [hostPort, web] of Object.entries(status?.Web ?? {})) {
    const proxy = web.Handlers?.["/"]?.Proxy;
    if (!proxy) continue;
    let target: URL;
    try {
      target = new URL(proxy);
    } catch {
      continue;
    }
    if (target.protocol !== "http:" || target.port !== String(port) || !LOOPBACK.has(target.hostname)) continue;
    const [, name, p] = /^(.+):(\d+)$/.exec(hostPort) ?? [];
    if (!name) continue;
    return p === "443" ? `https://${name}` : `https://${name}:${p}`;
  }
  return null;
}

async function serveStatus(): Promise<ServeStatus | null> {
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    const path = Bun.which(bin) ?? (existsSync(bin) ? bin : null);
    if (!path) continue;
    try {
      // TAILSCALE_BE_CLI: the Mac app's binary answers as the CLI rather than opening its window.
      const proc = Bun.spawn([path, "serve", "status", "--json"], { stdout: "pipe", stderr: "ignore", env: { ...process.env, TAILSCALE_BE_CLI: "1" } });
      const timer = setTimeout(() => proc.kill(), 3_000);
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      clearTimeout(timer);
      if (code === 0) return out.trim() ? (JSON.parse(out) as ServeStatus) : {};
    } catch {
      /* not running, or not JSON */
    }
  }
  return null;
}

/**
 * The address, looked up at most once a minute: /healthz is asked often, and
 * `tailscale serve` can be set up while midna runs.
 */
export function tailnetHttps(port: number, ttlMs = 60_000, read: () => Promise<ServeStatus | null> = serveStatus): () => Promise<string | null> {
  let cached: { at: number; url: string | null } | null = null;
  let pending: Promise<string | null> | null = null;
  return () => {
    if (cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.url);
    pending ??= read()
      .then((s) => servedHttps(s, port), () => null)
      .then((url) => {
        cached = { at: Date.now(), url };
        pending = null;
        return url;
      });
    return pending;
  };
}
