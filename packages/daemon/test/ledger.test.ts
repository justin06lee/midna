import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BrainRun } from "@midna/agent";
import { MidnaClient } from "@midna/protocol";
import { startDaemon, type RunningDaemon } from "../src/index.ts";

/**
 * The user's ledger (King of Greed), against a stand-in for its CLI
 * (packages/agent/test/fake-kog.ts): where it is set up, the brain is
 * handed it as a second MCP server and told how to keep the money; where
 * it isn't, a turn knows nothing of it.
 */

const FAKE = join(import.meta.dir, "../../agent/test/fake-kog.ts");

async function until<T>(what: string, fn: () => T | undefined, ms = 5_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
    const v = fn();
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function midnaWith(ledger: string | null | undefined) {
  const home = mkdtempSync(join(tmpdir(), "midna-ledger-"));
  const runs: BrainRun[] = [];
  const daemon = await startDaemon({
    home,
    port: 17000 + Math.floor(Math.random() * 20000),
    brain: async (run) => (runs.push(run), { text: "Logged.", sessionId: "s" }),
    tickMs: 50,
    introDelayMs: -1,
    coalesceMs: 20,
    https: null,
    vault: null,
    ...(ledger !== undefined ? { ledger } : {}),
  });
  const client = new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim());
  const turn = async (text: string) => {
    await client.send({ text, client: "test" });
    return until(`the turn for "${text}"`, () => runs.find((r) => r.prompt.includes(text)));
  };
  return { home, daemon, turn };
}

describe("a midna whose host has the ledger set up", () => {
  let m: { home: string; daemon: RunningDaemon; turn: (text: string) => Promise<BrainRun> };
  const book = join(tmpdir(), `midna-ledger-book-${process.pid}.json`);
  beforeAll(async () => {
    process.env.FAKE_KOG_BOOK = book;
    m = await midnaWith(FAKE);
  });
  afterAll(async () => {
    await m.daemon.stop();
    rmSync(m.home, { recursive: true, force: true });
    rmSync(book, { force: true });
  });

  test("its brain gets kog beside midna's own tools, and the prompt says how to keep the money", async () => {
    const run = await m.turn("5,600원 starbucks");
    expect(run.ledger).toEqual({ command: FAKE, url: `${m.daemon.url}/mcp-kog` });
    expect(run.systemPrompt).toContain("# Money");
    expect(run.systemPrompt).toContain("King of Greed");
  });

  test("the bridge is behind the brain's own token, and passes kog's tools through", async () => {
    const run = await m.turn("how much on coffee this month?");
    const refused = await fetch(run.ledger!.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(refused.status).toBe(401);
    const kog = new Client({ name: "codex", version: "1" });
    await kog.connect(new StreamableHTTPClientTransport(new URL(run.ledger!.url), { requestInit: { headers: { authorization: `Bearer ${run.mcp.token}` } } }));
    try {
      expect((await kog.listTools()).tools.map((t) => t.name)).toEqual(["log_transaction", "list_transactions"]);
      const logged = (await kog.callTool({ name: "log_transaction", arguments: { amount: 1, what: "test" } })) as { content: Array<{ text: string }> };
      expect(logged.content[0]!.text).toBe("logged 1 test via midna");
      expect(JSON.parse(readFileSync(book, "utf8"))).toEqual([{ amount: 1, what: "test" }]);
    } finally {
      await kog.close();
    }
  });
});

describe("a midna whose host has no ledger", () => {
  test("a turn hears nothing of it, and the bridge says there is none", async () => {
    for (const ledger of [null, undefined, join(tmpdir(), "no-kog-here")]) {
      const m = await midnaWith(ledger);
      try {
        const run = await m.turn("5,600원 starbucks");
        expect(run.ledger).toBeUndefined();
        expect(run.systemPrompt).not.toContain("King of Greed");
        const res = await fetch(`${m.daemon.url}/mcp-kog`, { method: "POST", headers: { authorization: `Bearer ${run.mcp.token}`, "content-type": "application/json" }, body: "{}" });
        expect(res.status).toBe(503);
      } finally {
        await m.daemon.stop();
        rmSync(m.home, { recursive: true, force: true });
      }
    }
  });
});
