import { describe, expect, test } from "bun:test";
import type { Connection, HttpsFound } from "@midna/protocol";
import { secured } from "../src/host.ts";

const saved: Connection = { url: "http://100.74.137.16:7717", token: "t", name: "midna", host: "midna", ssh: "midna.tailddc9d9.ts.net", device: "d1", daemonKey: "k" };

describe("opening a saved connection", () => {
  test("plain http on the tailnet moves to midna's HTTPS address, and is saved so (the Mac mini and the MacBook Pro, 2026-11-15)", async () => {
    const writes: Connection[] = [];
    const s = await secured(saved, async () => ({ url: "https://midna.tailddc9d9.ts.net:8443" }), async (c) => void writes.push(c));
    expect(s).toEqual({ connection: { ...saved, url: "https://midna.tailddc9d9.ts.net:8443" } });
    expect(writes).toEqual([{ ...saved, url: "https://midna.tailddc9d9.ts.net:8443" }]);
  });

  test("with no HTTPS address it is blocked with what to run, never used over http", async () => {
    const none: HttpsFound = { url: null, message: "midna at http://100.74.137.16:7717 has no HTTPS address on the tailnet.", command: "tailscale serve --bg --https=8443 http://127.0.0.1:7717" };
    const writes: Connection[] = [];
    const s = await secured(saved, async () => none, async (c) => void writes.push(c));
    expect(s).toEqual({ blocked: none, connection: saved });
    expect(writes).toEqual([]);
  });

  test("an HTTPS, loopback or mesh connection is left as it is, without looking", async () => {
    const find = async (): Promise<HttpsFound> => {
      throw new Error("not asked");
    };
    for (const url of ["https://midna.tailddc9d9.ts.net:8443", "http://127.0.0.1:7717", "http://10.77.0.1:7717"]) {
      expect(await secured({ ...saved, url }, find, async () => {})).toEqual({ connection: { ...saved, url } });
    }
  });
});
