import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLedgerMcp, kogCommand, ledgerWatch } from "../src/ledger.ts";

const FAKE = join(import.meta.dir, "fake-kog.ts");
const root = mkdtempSync(join(tmpdir(), "midna-ledger-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ledgerWatch", () => {
  test("no CLI, no ledger, and nothing is asked", async () => {
    let asked = 0;
    const status = async () => (asked++, true);
    expect(await ledgerWatch(null, status)()).toBeNull();
    expect(await ledgerWatch(join(root, "not-there"), status)()).toBeNull();
    expect(asked).toBe(0);
    expect(kogCommand("/home/justin")).toBe("/home/justin/.local/bin/kog");
  });

  test("once kog says it is set up, it stays so without asking again", async () => {
    let asked = 0;
    const watch = ledgerWatch(FAKE, async () => (asked++, true));
    expect(await watch()).toBe(FAKE);
    expect(await watch()).toBe(FAKE);
    expect(asked).toBe(1);
  });

  test("a kog that isn't set up is asked again only after a minute, and found once it is", async () => {
    let asked = 0;
    let ready = false;
    let now = 1_000_000;
    const watch = ledgerWatch(FAKE, async () => (asked++, ready), () => now);
    expect(await watch()).toBeNull();
    ready = true;
    expect(await watch()).toBeNull();
    expect(asked).toBe(1);
    now += 61_000;
    expect(await watch()).toBe(FAKE);
    expect(asked).toBe(2);
  });

  test("turns asking at once share one `kog status`", async () => {
    let asked = 0;
    const watch = ledgerWatch(FAKE, async () => (asked++, await Bun.sleep(20), true));
    expect(await Promise.all([watch(), watch(), watch()])).toEqual([FAKE, FAKE, FAKE]);
    expect(asked).toBe(1);
  });

  test("the CLI gone again, the ledger is gone", async () => {
    const copy = join(root, "kog");
    writeFileSync(copy, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const watch = ledgerWatch(copy);
    expect(await watch()).toBe(copy);
    rmSync(copy);
    expect(await watch()).toBeNull();
  });

  test("`kog status` itself decides: exit 0 is set up, anything else is not", async () => {
    const yes = join(root, "yes");
    const no = join(root, "no");
    writeFileSync(yes, "#!/bin/sh\n[ \"$1\" = status ] && exit 0\nexit 3\n", { mode: 0o755 });
    writeFileSync(no, "#!/bin/sh\necho 'no ledger yet: kog init' >&2\nexit 1\n", { mode: 0o755 });
    expect(await ledgerWatch(yes)()).toBe(yes);
    expect(await ledgerWatch(no)()).toBeNull();
  });
});

describe("the ledger over HTTP, for the brains that can't start `kog mcp` themselves", () => {
  const book = join(root, "book.json");
  const rpc = async (method: string, params: unknown, id = 1) => {
    process.env.FAKE_KOG_BOOK = book;
    const res = await handleLedgerMcp(
      new Request("http://midna/mcp-kog", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }),
      FAKE,
    );
    return (await res.json()) as { result?: any; error?: { message: string } };
  };

  test("it lists kog's own tools and passes a call through, as midna", async () => {
    const hello = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } });
    expect(hello.result.serverInfo.name).toBe("kog");
    const listed = await rpc("tools/list", {});
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual(["log_transaction", "list_transactions"]);
    const logged = await rpc("tools/call", { name: "log_transaction", arguments: { amount: 5600, what: "starbucks" } });
    expect(logged.result.content[0].text).toBe("logged 5600 starbucks via midna");
    expect(JSON.parse(readFileSync(book, "utf8"))).toEqual([{ amount: 5600, what: "starbucks" }]);
    const read = await rpc("tools/call", { name: "list_transactions", arguments: {} });
    expect(read.result.content[0].text).toContain("starbucks");
  });

  test("a kog that won't start is an error the brain can read, not a hang", async () => {
    const broken = join(root, "broken");
    writeFileSync(broken, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const res = await handleLedgerMcp(new Request("http://midna/mcp-kog", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }), broken);
    expect(((await res.json()) as { error?: unknown }).error).toBeDefined();
  });
});
