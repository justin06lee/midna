import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MidnaClient } from "@midna/protocol";
import { servedHttps, tailnetHttps } from "../src/tailnet.ts";
import { startDaemon, type RunningDaemon } from "../src/index.ts";

// `tailscale serve status --json` on midna's host, 2026-11-15.
const STATUS = {
  TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true }, "8444": { HTTPS: true } },
  Web: {
    "midna.tailddc9d9.ts.net:443": { Handlers: { "/": { Proxy: "https+insecure://localhost:8222" } } },
    "midna.tailddc9d9.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7717" } } },
    "midna.tailddc9d9.ts.net:8444": { Handlers: { "/": { Path: "/srv/hermes" } } },
  },
};

describe("midna's HTTPS address from tailscale serve", () => {
  test("the address whose root proxies to midna's port", () => {
    expect(servedHttps(STATUS, 7717)).toBe("https://midna.tailddc9d9.ts.net:8443");
    expect(servedHttps({ Web: { "box.tail1.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:7717" } } } } }, 7717)).toBe("https://box.tail1.ts.net");
  });

  test("none when nothing proxies to it", () => {
    expect(servedHttps(STATUS, 7718)).toBeNull();
    expect(servedHttps({}, 7717)).toBeNull();
    expect(servedHttps(null, 7717)).toBeNull();
    expect(servedHttps({ Web: { "x.ts.net:8443": { Handlers: { "/api": { Proxy: "http://127.0.0.1:7717" } } } } }, 7717)).toBeNull();
  });

  test("looked up once per minute, not on every /healthz", async () => {
    let reads = 0;
    const https = tailnetHttps(7717, 60_000, async () => (reads++, STATUS));
    expect(await Promise.all([https(), https()])).toEqual(["https://midna.tailddc9d9.ts.net:8443", "https://midna.tailddc9d9.ts.net:8443"]);
    expect(await https()).toBe("https://midna.tailddc9d9.ts.net:8443");
    expect(reads).toBe(1);
  });

  test("a failed lookup is no address", async () => {
    expect(await tailnetHttps(7717, 60_000, async () => Promise.reject(new Error("no tailscale")))()).toBeNull();
  });
});

describe("/healthz advertises it", () => {
  const port = 17000 + Math.floor(Math.random() * 20000);
  let home: string;
  let daemon: RunningDaemon;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "midna-tailnet-"));
    daemon = await startDaemon({ home, port, brain: async () => ({ text: "ok", sessionId: "s" }), introDelayMs: -1, https: "https://midna.tailddc9d9.ts.net:8443" });
  });

  afterAll(async () => {
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("so a client set up over plain http can move to it", async () => {
    const h = await new MidnaClient(`http://127.0.0.1:${port}`).health();
    expect(h.https).toBe("https://midna.tailddc9d9.ts.net:8443");
  });
});
