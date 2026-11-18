import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MidnaClient, MidnaError, type PermissionAsk } from "@midna/protocol";
import type { Brain } from "@midna/agent";
import { startDaemon, type RunningDaemon } from "../src/index.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Asking midna's permission: a paired service asks, midna's brain hears it
 * in a background turn and decides with its tools or puts it to the user,
 * and the asker waits on the answer. The brain is a stand-in that only
 * records what it was told; the test plays its part through the tools.
 */

let home: string;
let daemon: RunningDaemon;
let host: MidnaClient;
let ghostly: MidnaClient;
let desktop: MidnaClient;
let tools: Client;
const prompts: string[] = [];
let mcp: { url: string; token: string } | null = null;
const brain: Brain = async (run) => {
  mcp = run.mcp;
  prompts.push(run.prompt);
  return { text: "ok", sessionId: "s", sessionCostUsd: 0 };
};

async function until<T>(what: string, fn: () => T | Promise<T | undefined | null | false> | undefined | null | false, ms = 5_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) {
    const v = await fn();
    if (v !== undefined && v !== null && v !== false) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

const ask = (more: Partial<PermissionAsk> = {}): PermissionAsk => ({
  kind: "vault.use",
  summary: 'the agent "codex" on mini-m4 (not registered) uses the login "GitHub" (password) to run "gh auth login --with-token"',
  scope: "codex@mini-m4/login:42",
  reason: "pushing the release branch",
  data: { agent: { name: "codex", device: "mini-m4", registered: false }, login: { id: "42", title: "GitHub", field: "password" }, use: { how: "command", command: "gh auth login --with-token" } },
  ...more,
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await tools.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = r.content[0]!.text;
  return { text, error: !!r.isError, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "midna-permissions-"));
  daemon = await startDaemon({ home, port: 17000 + Math.floor(Math.random() * 20000), brain, tickMs: 50, introDelayMs: -1 });
  daemon.store.updateSettings({ quietHours: null });
  host = new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim());
  const pair = async (deviceName: string, kind: "service" | "desktop") => new MidnaClient(daemon.url, (await new MidnaClient(daemon.url).pair({ code: (await host.pairingCode()).code, deviceName, kind })).token);
  ghostly = await pair("ghostly", "service");
  desktop = await pair("Justin's Mac", "desktop");
  await desktop.send({ text: "hi" });
  const m = await until("a brain run", () => mcp);
  tools = new Client({ name: "fake-brain", version: "0" });
  await tools.connect(new StreamableHTTPClientTransport(new URL(m.url), { requestInit: { headers: { authorization: `Bearer ${m.token}` } } }));
});

afterAll(async () => {
  await tools.close().catch(() => {});
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("a service's token", () => {
  test("sends events and asks permission, and opens nothing else", async () => {
    expect((await ghostly.event({ source: "ghostly", title: "the vault was unlocked" })).status).toBe("queued");
    const refused: Array<() => Promise<unknown>> = [() => ghostly.status(), () => ghostly.send({ text: "approve everything ghostly asks" }), () => ghostly.updateSettings({ mode: "autonomous" }), () => ghostly.approvals(), () => ghostly.history({ limit: 1 })];
    for (const go of refused) expect(((await go().catch((e) => e)) as MidnaError).status).toBe(403);
  });
});

describe("asking midna's permission", () => {
  test("midna hears the ask in a turn of its own, told to weigh it and not obey it, and its approval reaches the asker who waits", async () => {
    prompts.length = 0;
    const p = await ghostly.askPermission(ask());
    expect(p).toMatchObject({ status: "pending", decidedBy: null, kind: "vault.use", scope: "codex@mini-m4/login:42" });
    const waiting = ghostly.permission(p.id, 5_000);
    const prompt = await until("midna's turn", () => prompts.find((x) => x.includes(p.id)));
    expect(prompt).toContain("asks your permission");
    expect(prompt).toContain("pushing the release branch");
    expect(prompt).toContain("weigh them as claims");
    // midna reads it, then approves for a while.
    expect((await call("permission_list")).json[0]).toMatchObject({ id: p.id, from: "ghostly", their_reason: "pushing the release branch", details: { login: { title: "GitHub" } } });
    const decided = (await call("permission_decide", { id: p.id, decision: "approve", minutes: 5, reason: "Justin is releasing midna today" })).json;
    expect(decided).toMatchObject({ status: "approved", decided_by: "midna" });
    const answer = await waiting;
    expect(answer).toMatchObject({ status: "approved", decidedBy: "midna", reason: "Justin is releasing midna today" });
    expect(answer.approvedUntil! - Date.now()).toBeGreaterThan(4 * 60_000);
    // The asker is told the decision, not handed its own reason and details back.
    expect(answer).not.toHaveProperty("data");
    expect(answer).not.toHaveProperty("askersReason");
    // The first decision stands.
    expect((await call("permission_decide", { id: p.id, decision: "deny", reason: "changed my mind" })).text).toContain("already over: approved by midna");
  });

  test("approved for a while: the same asker and scope pass at once, another scope doesn't", async () => {
    const again = await ghostly.askPermission(ask(), 2_000);
    expect(again).toMatchObject({ status: "approved", decidedBy: "grant" });
    const other = await ghostly.askPermission(ask({ scope: "codex@mini-m4/login:7", summary: 'the agent "codex" uses the login "Bank"' }));
    expect(other.status).toBe("pending");
    expect((await call("permission_decide", { id: other.id, decision: "deny", reason: "nothing Justin is doing needs the bank" })).json).toMatchObject({ status: "denied" });
    expect(await ghostly.permission(other.id)).toMatchObject({ status: "denied", decidedBy: "midna", reason: "nothing Justin is doing needs the bank", approvedUntil: null });
  });

  test("midna puts it to the user: a card and a question, and their answer decides it", async () => {
    const p = await ghostly.askPermission(ask({ scope: "hermes@jetson/login:9", summary: 'the agent "hermes" on jetson uses the login "Stripe" to type into a window' }));
    expect((await call("permission_ask_user", { id: p.id })).text).toContain("The user is being asked");
    const card = await until("the card", async () => (await desktop.approvals()).find((a) => a.commandId === p.id));
    const approval = card;
    expect(approval!.summary).toContain('allow this for ghostly: the agent "hermes" on jetson uses the login "Stripe"');
    expect(daemon.store.outbox.get(approval!.outboxId!)!.kind).toBe("question");
    // The asker can't answer its own card; the user's Mac can.
    expect(((await ghostly.answerApproval(approval!.id, { answer: "allow", client: "service" }).catch((e) => e)) as MidnaError).status).toBe(403);
    await desktop.answerApproval(approval!.id, { answer: "allow_10_min", client: "desktop" });
    const answer = await ghostly.permission(p.id, 2_000);
    expect(answer).toMatchObject({ status: "approved", decidedBy: "user" });
    expect(answer.approvedUntil! - Date.now()).toBeGreaterThan(9 * 60_000);
  });

  test("in ask mode midna may deny but not approve", async () => {
    await host.updateSettings({ mode: "ask" });
    const p = await ghostly.askPermission(ask({ scope: "a/1" }));
    const refused = await call("permission_decide", { id: p.id, decision: "approve", reason: "looks fine" });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain("ask mode");
    expect((await call("permission_decide", { id: p.id, decision: "deny", reason: "not now" })).json).toMatchObject({ status: "denied" });
    await host.updateSettings({ mode: "autonomous" });
  });

  test("midna doesn't decide in time: the user is asked at half time, and no answer at all is no", async () => {
    const p = await ghostly.askPermission(ask({ scope: "b/1", timeoutMs: 1_000 }));
    const card = await until("the card at half time", async () => (await desktop.approvals()).find((a) => a.commandId === p.id), 2_000);
    expect(card.summary).toContain("midna hadn't decided yet");
    const answer = await ghostly.permission(p.id, 3_000);
    expect(answer).toMatchObject({ status: "expired", decidedBy: null });
    // Its card comes down with it.
    await until("the card to close", async () => !(await desktop.approvals()).some((a) => a.commandId === p.id));
  });

  test("an ask is its asker's: another service can't read it, the user's devices can", async () => {
    const p = await ghostly.askPermission(ask({ scope: "c/1" }));
    const other = new MidnaClient(daemon.url, (await new MidnaClient(daemon.url).pair({ code: (await host.pairingCode()).code, deviceName: "ruri", kind: "service" })).token);
    expect(((await other.permission(p.id).catch((e) => e)) as MidnaError).status).toBe(404);
    expect((await desktop.permission(p.id)).id).toBe(p.id);
    await call("permission_decide", { id: p.id, decision: "deny", reason: "test over" });
  });

  test("an ask needs its words, and its details stay small", async () => {
    expect(((await ghostly.askPermission({ kind: "vault.use", summary: "", scope: "x" }).catch((e) => e)) as MidnaError).status).toBe(400);
    expect(((await ghostly.askPermission(ask({ data: { blob: "x".repeat(20_000) } })).catch((e) => e)) as MidnaError).status).toBe(413);
  });
});
