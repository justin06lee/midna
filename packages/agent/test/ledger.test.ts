import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLedgerMcp, kogCommand, LedgerError, ledgerReader, ledgerWatch, readLedger } from "../src/ledger.ts";
import { fakeLedger } from "./fake-ledger.ts";

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

describe("reading the ledger for the apps", () => {
  const seeded = () => {
    const file = join(tmpdir(), `midna-fake-ledger-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(fakeLedger()));
    return file;
  };
  const env = (vars: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  };
  afterEach(() => env({ FAKE_KOG_LEDGER: undefined, FAKE_KOG_FAIL: undefined, FAKE_KOG_STATUS: undefined }));

  test("balances, this month, budgets, interest, zakat and the latest entries, from kog's own commands", async () => {
    const file = seeded();
    env({ FAKE_KOG_LEDGER: file });
    try {
      const ledger = await readLedger(FAKE, undefined, () => 1234);
      expect(ledger.name).toBe("midna");
      expect(ledger.worth).toEqual({ total: 7_646_550, currency: "KRW", missingRates: [] });
      // kog's own extras (ids, the value in the primary currency) stay behind.
      expect(ledger.accounts[0]).toEqual({ name: "Toss", kind: "asset", currency: "KRW", balance: 1_842_300 });
      expect(ledger.accounts.find((a) => a.kind === "owed")).toEqual({ name: "Minjun", kind: "owed", currency: "KRW", balance: 35_000, person: "Minjun" });
      expect(ledger.owed).toEqual([{ person: "Minjun", amount: 35_000, currency: "KRW" }]);
      expect(ledger.month).toMatchObject({ month: "2026-11", count: 41, spent: { KRW: 612_400, USD: 20 }, earned: { KRW: 2_400_000 } });
      expect(ledger.month.categories[0]).toEqual({ name: "Food", currency: "KRW", amount: 248_600 });
      expect(ledger.budgets.find((b) => b.name === "Coffee")).toEqual({ name: "Coffee", limit: 60_000, spent: 61_600, left: -1_600, currency: "KRW" });
      expect(ledger.riba.toPurify).toEqual({ KRW: 1_240 });
      expect(ledger.zakat).toEqual({ wealth: 7_646_550, currency: "KRW", nisab: 1_194_102, aboveNisab: true, dueOn: "2027-06-06", daysLeft: 192 });
      expect(ledger.recent).toHaveLength(12);
      expect(ledger.recent[0]).toEqual({ id: "41", date: "2026-11-26T13:12:00+09:00", kind: "spend", amount: 5_600, currency: "KRW", description: "Starbucks", account: "Toss", other: "Starbucks", category: "Coffee", via: "midna" });
      expect(ledger.recent.map((e) => e.date)).toEqual([...ledger.recent.map((e) => e.date)].sort().reverse());
      expect(ledger.at).toBe(1234);
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("a ledger with nothing in it reads as empty, not as a failure", async () => {
    const ledger = await readLedger(FAKE);
    expect(ledger).toMatchObject({ accounts: [], owed: [], budgets: [], recent: [], worth: { total: 0, currency: "KRW" } });
    expect(ledger.zakat).toEqual({ wealth: 0, currency: "KRW" });
  });

  test("a part that fails comes empty; without `kog status` there is no view, and the failure says what kog said", async () => {
    const file = seeded();
    env({ FAKE_KOG_LEDGER: file, FAKE_KOG_FAIL: "zakat,budget,list" });
    try {
      const ledger = await readLedger(FAKE);
      expect(ledger).toMatchObject({ zakat: null, budgets: [], recent: [] });
      expect(ledger.accounts).toHaveLength(4);
      env({ FAKE_KOG_FAIL: "status" });
      const failed = await readLedger(FAKE).catch((e) => e);
      expect(failed).toBeInstanceOf(LedgerError);
      expect((failed as Error).message).toBe("kog: status could not reach the ledger's server");
      expect(await readLedger(join(tmpdir(), "no-kog-here")).catch((e) => e)).toBeInstanceOf(LedgerError);
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("what kog prints is read leniently: a row it garbles is dropped, a field it drops is left out", async () => {
    const raw = fakeLedger();
    const ask = async (_: string, args: string[]) =>
      args[0] === "status"
        ? { ...raw.status, accounts: [...raw.status.accounts, { name: 7 }], owed: "none" }
        : args[0] === "list"
          ? [{ ...raw.list[0], kind: "barter" }, { ...raw.list[1], category: 5 }, null]
          : (raw as Record<string, unknown>)[args[0]!];
    const ledger = await readLedger("kog", ask);
    expect(ledger.accounts).toHaveLength(4);
    expect(ledger.owed).toEqual([]);
    expect(ledger.recent.map((e) => [e.id, e.category])).toEqual([["40", undefined]]);
    await expect(readLedger("kog", async () => ({ nothing: "kog would print" }))).rejects.toBeInstanceOf(LedgerError);
  });

  test("the apps' reads are remembered a few seconds, one read at a time, and `fresh` reads again", async () => {
    let reads = 0;
    let clock = 0;
    const read = ledgerReader(async () => ({ ...(await readLedger("kog", async (_, args) => (fakeLedger() as Record<string, unknown>)[args[0]!])), at: ++reads }), 10_000, () => clock);
    const [a, b] = await Promise.all([read("kog"), read("kog")]);
    expect([a.at, b.at, reads]).toEqual([1, 1, 1]);
    clock = 9_000;
    expect((await read("kog")).at).toBe(1);
    expect((await read("kog", true)).at).toBe(2);
    clock = 30_000;
    expect((await read("kog")).at).toBe(3);
  });
});
