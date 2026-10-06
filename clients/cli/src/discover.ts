import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { DEFAULT_PORT, MidnaClient, type DiscoveredDevice } from "@midna/protocol";

/**
 * Which machines midna could live on: this one, every peer on the makima
 * mesh, every machine on the Tailscale tailnet — each probed for a midna
 * already running there.
 */

export type Device = DiscoveredDevice;

export const MAKIMA_SOCKET = process.env.MAKIMA_GUI_SOCKET || "/etc/makima/makimad-gui.sock";

interface MakimaStatus {
  node?: { name: string; address: string };
  peers?: Array<{ name: string; address: string; online: boolean; services?: Array<{ name: string; port: number }> }>;
  ssh?: { active: boolean };
}

interface TailscaleStatus {
  Self?: TailscalePeer;
  Peer?: Record<string, TailscalePeer>;
}
interface TailscalePeer { HostName: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean; OS?: string }

const short = (name: string) => name.toLowerCase().replace(/\.local$/, "").split(".")[0]!;

export function fromMakima(status: MakimaStatus): Device[] {
  return (status.peers ?? []).map((p) => ({
    id: `makima:${p.name}`,
    name: p.name.replace(/\.local$/, ""),
    via: "makima" as const,
    address: p.address,
    sshTarget: p.address,
    online: p.online,
    self: false,
    midna: { running: !!p.services?.some((s) => s.port === DEFAULT_PORT || s.name === "midna") },
  }));
}

export function fromTailscale(status: TailscaleStatus): Device[] {
  return Object.values(status.Peer ?? {}).map((p) => {
    const ip = p.TailscaleIPs?.find((a) => !a.includes(":")) ?? p.TailscaleIPs?.[0] ?? "";
    return {
      id: `tailscale:${p.HostName}`,
      name: p.HostName,
      via: "tailscale" as const,
      address: ip,
      sshTarget: p.DNSName?.replace(/\.$/, "") || ip,
      online: !!p.Online,
      self: false,
      ...(p.OS ? { os: p.OS } : {}),
      listen: ip,
      midna: { running: false },
    };
  });
}

async function readMakima(): Promise<MakimaStatus | null> {
  if (!existsSync(MAKIMA_SOCKET)) return null;
  try {
    const res = await fetch("http://makimad/api/status", { unix: MAKIMA_SOCKET, signal: AbortSignal.timeout(3_000) } as RequestInit);
    return res.ok ? ((await res.json()) as MakimaStatus) : null;
  } catch {
    return null;
  }
}

async function readTailscale(): Promise<TailscaleStatus | null> {
  const candidates = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  for (const bin of candidates) {
    const path = Bun.which(bin) ?? (existsSync(bin) ? bin : null);
    if (!path) continue;
    try {
      const r = Bun.spawnSync([path, "status", "--json"], { stdout: "pipe", stderr: "ignore", timeout: 4_000 });
      if (r.exitCode === 0) return JSON.parse(r.stdout.toString()) as TailscaleStatus;
    } catch {
      /* not running */
    }
  }
  return null;
}

/** Is midna answering at `url`? */
export async function probe(url: string, ms = 1_500): Promise<Device["midna"]> {
  try {
    const h = await Promise.race([new MidnaClient(url).health(), Bun.sleep(ms).then(() => null)]);
    return h ? { running: true, version: h.version, name: h.name, url } : { running: false };
  } catch {
    return { running: false };
  }
}

/**
 * Everything reachable, merged by machine name (makima preferred when a
 * machine is on both), this machine first, each probed for midna.
 */
export async function discover(port = DEFAULT_PORT): Promise<Device[]> {
  const [makima, tailscale] = await Promise.all([readMakima(), readTailscale()]);
  const local: Device = {
    id: "local",
    name: hostname().replace(/\.local$/, ""),
    via: "local",
    address: "127.0.0.1",
    sshTarget: null,
    online: true,
    self: true,
    midna: { running: false },
  };
  const remote = new Map<string, Device>();
  for (const d of [...(makima ? fromMakima(makima) : []), ...(tailscale ? fromTailscale(tailscale) : [])]) {
    const key = short(d.name);
    if (key === short(local.name)) continue;
    if (!remote.has(key)) remote.set(key, d);
  }
  const devices = [local, ...[...remote.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))];
  await Promise.all(
    devices.map(async (d) => {
      if (!d.online || !d.address) return;
      const url = `http://${d.address.includes(":") ? `[${d.address}]` : d.address}:${port}`;
      d.midna = await probe(url);
    }),
  );
  return devices;
}
