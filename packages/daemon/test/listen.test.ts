import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import type { Brain } from "@midna/agent";
import { listenAddresses, loadConfig } from "../src/config.ts";
import { startDaemon, type RunningDaemon } from "../src/index.ts";

/**
 * The extra addresses midna answers on — a tailnet's, so a phone away from
 * home can reach it — and nothing wider: never every network, never the LAN.
 */

const nic = (address: string): NetworkInterfaceInfo =>
  ({ address, family: address.includes(":") ? "IPv6" : "IPv4", internal: false, netmask: "", mac: "", cidr: null, ...(address.includes(":") ? { scopeid: 0 } : {}) }) as NetworkInterfaceInfo;
const tailnet = { tailscale0: [nic("100.101.102.103"), nic("fd7a:115c:a1e0::1234"), nic("fe80::5ee:1")], wlan0: [nic("192.168.1.115")] };

describe("listen", () => {
  test("an address stands for itself; an interface for the addresses it has now, link-local left out", () => {
    expect(listenAddresses("100.64.0.5", tailnet)).toEqual(["100.64.0.5"]);
    expect(listenAddresses("fd7a:115c:a1e0::1234", tailnet)).toEqual(["fd7a:115c:a1e0::1234"]);
    expect(listenAddresses("tailscale0", tailnet)).toEqual(["100.101.102.103", "fd7a:115c:a1e0::1234"]);
  });

  test("an interface that is down, not up yet, or uninstalled stands for nothing", () => {
    expect(listenAddresses("tailscale0", {})).toEqual([]);
    expect(listenAddresses("tailscale0", { tailscale0: [nic("fe80::5ee:1")] })).toEqual([]);
  });

  test("a wildcard never stands for anything: it would be every network, the LAN too", () => {
    for (const w of ["0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0", "0", ""]) expect(listenAddresses(w, tailnet)).toEqual([]);
  });

  test("a hand-edited listen that isn't a list still means what it says", () => {
    const home = mkdtempSync(join(tmpdir(), "midna-listen-"));
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ listen: "tailscale0" }));
      expect(loadConfig(home).listen).toEqual(["tailscale0"]);
      writeFileSync(join(home, "config.json"), JSON.stringify({ listen: null }));
      expect(loadConfig(home).listen).toEqual([]);
      writeFileSync(join(home, "config.json"), JSON.stringify({ port: 7717 }));
      expect(loadConfig(home).listen).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("a daemon with extra addresses", () => {
  const port = 17000 + Math.floor(Math.random() * 20000);
  const brain: Brain = async () => ({ text: "ok", sessionId: "s", costUsd: 0 });
  // This machine's loopback interface, by name (lo on Linux, lo0 on macOS), when it has ::1.
  const loopback = Object.entries(networkInterfaces()).find(([, a]) => a?.some((x) => x.address === "::1"))?.[0];
  // An address of this machine on a real network: midna must not answer there.
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && !a.internal && a.family === "IPv4")?.address;
  let home: string;
  let daemon: RunningDaemon;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "midna-listen-"));
    // 192.0.2.1 is reserved for documentation: never on any machine, like a VPN not up yet.
    writeFileSync(join(home, "config.json"), JSON.stringify({ listen: ["192.0.2.1", "tailscale9", "0.0.0.0", ...(loopback ? [loopback] : [])] }));
    daemon = await startDaemon({ home, port, brain, introDelayMs: -1 });
  });

  afterAll(async () => {
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const health = (host: string) => fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok);

  test("addresses and interfaces that aren't there don't stop it starting", async () => {
    expect(await health("127.0.0.1")).toBe(true);
  });

  test.if(!!loopback)("an interface named in listen is answered on, on each of its addresses", async () => {
    expect(await health("[::1]")).toBe(true);
  });

  test.if(!!lan)("a wildcard in listen opens nothing more: the LAN gets no answer", async () => {
    expect(await health(lan!).catch(() => false)).toBe(false);
  });
});
