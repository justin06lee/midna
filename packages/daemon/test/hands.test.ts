import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  HandsCommand,
  MidnaClient,
  MidnaError,
  type Approval,
  type ApprovalAnswer,
  type Capability,
  type HandsHello,
  type HandsResult,
  type HandsStreamEvent,
  type HandsWelcome,
  type StreamEvent,
} from "@midna/protocol";
import { devicesSection, type Brain, type BrainRun } from "@midna/agent";
import { answerIn, decide, startDaemon, summarize, type RunningDaemon } from "../src/index.ts";

/**
 * Device hands against a real daemon, with a fake device: a desktop that
 * pairs, says hello, keeps the command stream open, checks every command
 * the way the app must (signature against the pinned key, its connection's
 * nonce, a rising seq, a new id), and answers. midna's side is its real
 * MCP tools, called as a brain would call them.
 */

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

let home: string;
let daemon: RunningDaemon;
let host: MidnaClient;
let tools: Client;
let episodeId: number;
let mcp: BrainRun["mcp"];
const runs: BrainRun[] = [];
/** How long an approval waits here, instead of 2 minutes. */
const APPROVAL_MS = 4_000;
const ALL_ON = Object.fromEntries((["screen", "input", "script", "shell", "files", "clipboard", "open", "notify"] as Capability[]).map((c) => [c, "on"])) as Record<Capability, "on">;

const brain: Brain = async (run) => {
  runs.push(run);
  return { text: "ok", sessionId: `s-${runs.length}`, sessionCostUsd: 0 };
};

async function until<T>(what: string, fn: () => T | undefined | false, ms = 5_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; content: Content; error: boolean }> {
  const r = (await tools.callTool({ name, arguments: args })) as { content: Content; isError?: boolean };
  return { text: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), content: r.content, error: !!r.isError };
}

/** An SSE body, event by event. */
async function readEvents(res: Response, on: (e: HandsStreamEvent) => void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        buf = buf.slice(i + 2);
        if (data) on(JSON.parse(data));
      }
    }
  } catch {
    /* aborted */
  }
}

const HELLO: Omit<HandsHello, "nonce"> = {
  protocol: 1,
  app: { version: "0.8.0" },
  os: { family: "macos", version: "26.0", arch: "arm64", hostname: "air", session: "quartz" },
  displays: [{ id: "1", name: "Built-in Retina Display", primary: true, x: 0, y: 0, width: 1470, height: 956, scale: 2 }],
  offers: { screen: "on", open: "on", notify: "on" },
  permissions: { screen_recording: "granted", notifications: "granted", accessibility: "not_asked" },
  state: "ready",
};

/** The app's side, as docs/device-hands.md asks it to behave. */
class FakeDevice {
  id = "";
  token = "";
  /** The daemon's key, pinned at pairing. */
  key!: KeyObject;
  pairedKey = "";
  welcome!: HandsWelcome;
  nonce = "";
  lastSeq = 0;
  readonly ran = new Set<string>();
  readonly events: HandsStreamEvent[] = [];
  readonly commands: HandsCommand[] = [];
  readonly refused: string[] = [];
  client!: MidnaClient;
  private abort: AbortController | null = null;
  ended: Promise<void> = Promise.resolve();
  /** How it answers a command it accepted; null: it never answers. */
  answer: (c: HandsCommand) => Promise<HandsResult | null> | HandsResult | null = (c) => ({ id: c.id, ok: true, data: {}, ms: 5 });

  /** Every approval it was shown, as it stands now. */
  readonly approvals = new Map<string, Approval>();
  /** How the panel on the machine answers an approval; null: nobody is at it. */
  onApproval: (a: Approval) => ApprovalAnswer | null = () => null;

  pending(op?: string): Approval[] {
    return [...this.approvals.values()].filter((a) => a.state === "pending" && (!op || a.op === op));
  }

  static async pair(name: string, kind: "desktop" | "cli" | "bridge" = "desktop"): Promise<FakeDevice> {
    const d = new FakeDevice();
    const paired = await new MidnaClient(daemon.url).pair({ code: (await host.pairingCode()).code, deviceName: name, kind });
    d.id = paired.deviceId;
    d.token = paired.token;
    d.pairedKey = paired.daemonKey!;
    d.key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: paired.daemonKey! }, format: "jwk" });
    d.client = new MidnaClient(daemon.url, paired.token);
    return d;
  }

  async hello(change: Partial<HandsHello> = {}): Promise<HandsWelcome> {
    this.nonce = `nonce-${crypto.randomUUID()}`;
    this.welcome = await this.client.handsHello({ ...HELLO, nonce: this.nonce, ...change });
    this.lastSeq = 0;
    return this.welcome;
  }

  async connect(session = this.welcome.session): Promise<void> {
    this.abort = new AbortController();
    const res = await fetch(`${daemon.url}/v1/hands/stream?session=${session}`, { headers: { authorization: `Bearer ${this.token}` }, signal: this.abort.signal });
    if (!res.ok) throw new MidnaError(res.status, ((await res.json()) as { error: string }).error);
    this.ended = readEvents(res, (e) => this.receive(e));
    await until("the device online", () => daemon.hands.online(this.id));
  }

  disconnect(): void {
    this.abort?.abort();
  }

  /** Why the app must refuse this event, or null when it may run it. */
  check(e: HandsStreamEvent): string | null {
    if (e.type !== "command") return null;
    if (!verify(null, Buffer.from(e.signed), this.key, Buffer.from(e.sig, "base64url"))) return "bad signature";
    const c = HandsCommand.parse(JSON.parse(e.signed));
    if (c.nonce !== this.nonce) return "not this connection's";
    if (c.seq <= this.lastSeq) return "seq not rising";
    if (this.ran.has(c.id)) return "already ran";
    return null;
  }

  receive(e: HandsStreamEvent): void {
    this.events.push(e);
    if (e.type === "approval") {
      this.approvals.set(e.approval.id, e.approval);
      const answer = e.approval.state === "pending" ? this.onApproval(e.approval) : null;
      if (answer) void this.client.answerApproval(e.approval.id, { answer, client: "device" }).catch(() => {});
      return;
    }
    if (e.type !== "command") return;
    const why = this.check(e);
    if (why) {
      this.refused.push(why);
      return;
    }
    const c = HandsCommand.parse(JSON.parse(e.signed));
    this.lastSeq = c.seq;
    this.ran.add(c.id);
    this.commands.push(c);
    void (async () => {
      const r = await this.answer(c);
      if (r) await this.client.handsResult(r).catch(() => {});
    })();
  }
}

let air: FakeDevice;
const status = (e: unknown) => (e as MidnaError).status;
const setState = (u: Omit<Parameters<MidnaClient["handsState"]>[0], "session">) => air.client.handsState({ session: air.welcome.session, ...u });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "midna-hands-"));
  daemon = await startDaemon({ home, port: 17000 + Math.floor(Math.random() * 20000), brain, tickMs: 50, introDelayMs: 10, coalesceMs: 50, handsGraceMs: 100, approvalMs: APPROVAL_MS });
  daemon.store.updateSettings({ quietHours: null });
  host = new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim());
  // The intro wakeup's episode lends the tools an episode to be called in.
  const intro = await until("a brain run", () => runs[0]);
  mcp = intro.mcp;
  episodeId = Number(mcp.url.split("/").pop());
  tools = new Client({ name: "fake-brain", version: "0" });
  await tools.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { authorization: `Bearer ${mcp.token}` } } }));
});

afterAll(async () => {
  await tools.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("the policy and mode gate", () => {
  test("off is refused, ask always asks, on runs — except acting in ask mode", () => {
    for (const mode of ["autonomous", "ask"] as const) {
      expect(decide(undefined, mode, "screenshot")).toBe("refuse");
      expect(decide("ask", mode, "screenshot")).toBe("approve");
      expect(decide("ask", mode, "notify")).toBe("approve");
    }
    for (const op of ["screenshot", "open", "notify", "shell", "click"] as const) expect(decide("on", "autonomous", op)).toBe("run");
    for (const op of ["screenshot", "notify", "file_read", "file_list", "clipboard_read"] as const) expect(decide("on", "ask", op)).toBe("run");
    for (const op of ["open", "click", "type", "shell", "script", "file_write", "clipboard_write"] as const) expect(decide("on", "ask", op)).toBe("approve");
  });

  test("what counts as looking is the policy's to say, so Justin's answer is a value", () => {
    expect(decide("on", "ask", "screenshot", { observe: [] })).toBe("approve");
    expect(decide("on", "ask", "open", { observe: ["open"] })).toBe("run");
  });
});

describe("approval words", () => {
  test("a reply answers with a button's label or a plain yes or no; anything else is a message", () => {
    expect(["Allow", "allow", " yes ", "OK", "go ahead"].map(answerIn)).toEqual(["allow", "allow", "allow", "allow", "allow"]);
    expect(["Allow for 10 min", "allow for 10 minutes"].map(answerIn)).toEqual(["allow_10_min", "allow_10_min"]);
    expect(["Deny", "no", "nope"].map(answerIn)).toEqual(["deny", "deny", "deny"]);
    expect(answerIn("no, use Safari instead")).toBeNull();
  });

  test("a summary says what would happen, and never shows secret text", () => {
    expect(summarize("shell", { command: "brew upgrade" }, "MacBook Air")).toBe("run `brew upgrade` on MacBook Air");
    expect(summarize("type", { text: "hunter2", secret: true }, "MacBook Air")).toBe("type 7 secret characters on MacBook Air");
    expect(summarize("drag", { path: [{ x: 1, y: 2 }, { x: 5, y: 6 }] }, "air")).toBe("drag from 1, 2 to 5, 6 on air");
    expect(summarize("file_write", { path: "~/a", mode: "append" }, "air")).toBe("append to ~/a on air");
  });
});

describe("device hands", () => {
  test("a desktop pairs with the daemon's key, says hello, and is listed once its stream is open", async () => {
    air = await FakeDevice.pair("MacBook Air");
    const welcome = await air.hello();
    expect(air.pairedKey).toBe(daemon.hands.publicKey);
    expect(welcome.daemonKey).toBe(air.pairedKey);
    expect(Buffer.from(welcome.daemonKey, "base64url").byteLength).toBe(32);
    expect(welcome.fingerprint).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    expect(welcome.session).toMatch(/^hs_/);
    // Said hello, no stream yet: known, but offline.
    expect((await host.handsDevices())[0]).toMatchObject({ id: air.id, name: "MacBook Air", online: false });
    await air.connect();
    const [listed] = await host.handsDevices();
    expect(listed).toMatchObject({ online: true, state: "ready", os: { family: "macos" }, displays: [{ id: "1" }] });
    expect(listed!.capabilities).toContainEqual({ capability: "screen", policy: "on", missing: [] });
    expect(listed!.capabilities).toContainEqual({ capability: "input", policy: "off", missing: ["accessibility"] });
    const list = await tool("device_list");
    expect(JSON.parse(list.text)).toEqual([
      expect.objectContaining({ name: "MacBook Air", id: air.id, online: true, state: "ready", os: "macos 26.0 (arm64)", can: { screen: "on", open: "on", notify: "on" } }),
    ]);
    // The key is the daemon's own, kept across restarts in MIDNA_HOME.
    expect(readFileSync(join(home, "hands.key"), "utf8")).toContain("PRIVATE KEY");
  });

  test("only a paired desktop says hello, with a well-formed hello and a fresh nonce", async () => {
    await expect(new MidnaClient(daemon.url).handsHello({ ...HELLO, nonce: "n".repeat(16) })).rejects.toThrow(/unauthorized/);
    const cli = await FakeDevice.pair("a terminal", "cli");
    await expect(cli.client.handsHello({ ...HELLO, nonce: "n".repeat(16) }).catch(status)).resolves.toBe(403);
    await expect(air.client.handsHello({ ...HELLO, nonce: "short" }).catch(status)).resolves.toBe(400);
    await expect(air.client.handsHello({ ...HELLO, protocol: 2 } as never).catch(status)).resolves.toBe(400);
    // Reusing a nonce would let an old connection's commands verify on the new one.
    await expect(air.client.handsHello({ ...HELLO, nonce: air.nonce }).catch((e) => (e as Error).message)).resolves.toMatch(/nonce was used before/);
    expect(daemon.hands.online(air.id)).toBe(true);
  });

  test("a screenshot goes out signed and comes back as an image midna sees, in the audit log", async () => {
    air.answer = async (c) => {
      const png = await air.client.upload(PNG, { name: `screenshot-${c.args.display ?? "1"}.png`, mime: "image/png" });
      return { id: c.id, ok: true, data: { width: 1, height: 1, display: "1", scale: 2, cursor: { x: 0, y: 0 } }, attachments: [png.id], ms: 40 };
    };
    const shot = await tool("device_screenshot", { device: "macbook air" });
    expect(shot.error).toBe(false);
    expect(shot.content[0]).toEqual({ type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" });
    expect(shot.text).toMatch(/^MacBook Air, display 1: 1×1 px, pointer at 0,0: attachment att_\S+ \(screenshot-1\.png, 1 KB\), saved at `.+screenshot-1\.png`$/);
    const [c] = air.commands;
    expect(c).toMatchObject({ op: "screenshot", nonce: air.nonce, seq: 1, episodeId, timeoutMs: 10_000 });
    expect(c!.id).toMatch(/^cmd_/);
    expect(air.refused).toEqual([]);
    const attachment = shot.text.match(/att_\S+/)![0];
    const [row] = await host.deviceCommands(air.id);
    expect(row).toMatchObject({ id: c!.id, deviceId: air.id, episodeId, op: "screenshot", decision: "allowed", decidedBy: "policy", outcome: "ok", attachments: [attachment] });
    expect(row!.endedAt).toBeGreaterThanOrEqual(row!.startedAt);
    // midna can send it on to the user as it is.
    expect((await tool("message_user", { text: "your screen", attachments: [{ file: attachment, name: "desk.png" }] })).text).toMatch(/with 1 attachment/);
  });

  test("open and notify go the same way, each with the next seq", async () => {
    air.answer = (c) => ({ id: c.id, ok: true, data: {}, ms: 3 });
    expect((await tool("device_open", { url: "https://example.com" })).text).toBe("opened https://example.com on MacBook Air");
    expect((await tool("device_notify", { device: air.id, title: "Hi", body: "from midna" })).text).toBe("notified on MacBook Air");
    expect(air.commands.slice(-2).map((c) => [c.seq, c.op, c.args])).toEqual([
      [2, "open", { url: "https://example.com" }],
      [3, "notify", { title: "Hi", body: "from midna" }],
    ]);
    expect((await tool("device_open", { url: "https://a", app: "Safari" })).text).toMatch(/exactly one of url, app or path/);
    expect((await host.deviceCommands(air.id)).map((r) => r.op)).toEqual(["notify", "open", "screenshot"]);
    // A failure on the device comes back in its words.
    air.answer = (c) => ({ id: c.id, ok: false, ms: 1, error: { code: "permission", message: "Notifications are off for midna", permission: "notifications" } });
    expect((await tool("device_notify", { title: "Hi", body: "" })).text).toBe("error: MacBook Air: Notifications are off for midna (needs Notifications)");
    expect((await host.deviceCommands(air.id, 1))[0]).toMatchObject({ outcome: "error", errorCode: "permission" });
  });

  test("the app refuses a forged, tampered or replayed command, and the daemon a wrong or second result", async () => {
    const real = air.events.find((e): e is Extract<HandsStreamEvent, { type: "command" }> => e.type === "command")!;
    const forger = generateKeyPairSync("ed25519").privateKey;
    expect(air.check({ ...real, signed: real.signed.replace('"seq":1', '"seq":99') })).toBe("bad signature");
    expect(air.check({ ...real, sig: sign(null, Buffer.from(real.signed), forger).toString("base64url") })).toBe("bad signature");
    expect(air.check(real)).toBe("seq not rising");
    // A command from an earlier connection, replayed into a new one, fails on its nonce.
    const before = air.nonce;
    await air.hello();
    await air.connect();
    expect(air.nonce).not.toBe(before);
    expect(air.check(real)).toBe("not this connection's");

    // The daemon takes each result once, from the device it sent the command to.
    let held!: HandsCommand;
    air.answer = (c) => ((held = c), null);
    const pending = daemon.hands.run({ device: "MacBook Air", op: "notify", args: { title: "t", body: "b" }, episodeId: null });
    await until("the command", () => held);
    const other = await FakeDevice.pair("spare");
    await other.hello();
    const result: HandsResult = { id: held.id, ok: true, data: {}, ms: 1 };
    await expect(other.client.handsResult(result).catch(status)).resolves.toBe(403);
    await expect(air.client.handsResult({ ...result, id: "cmd_nope" }).catch(status)).resolves.toBe(404);
    await expect(
      fetch(`${daemon.url}/v1/hands/results/cmd_other`, { method: "POST", headers: { authorization: `Bearer ${air.token}`, "content-type": "application/json" }, body: JSON.stringify(result) }).then((r) => r.status),
    ).resolves.toBe(400);
    await air.client.handsResult(result);
    expect((await pending).ok).toBe(true);
    await expect(air.client.handsResult(result).catch(status)).resolves.toBe(409);
    await expect(other.client.handsResult(result).catch(status)).resolves.toBe(403);
  });

  test("a new hello ends the old session: its stream says bye, its commands fail, its id is refused", async () => {
    const old = air.welcome.session;
    const oldEvents = air.events.length;
    let held!: HandsCommand;
    air.answer = (c) => ((held = c), null);
    const pending = daemon.hands.run({ op: "open", args: { app: "Notes" }, episodeId: null });
    await until("the command", () => held);
    const oldStream = air.ended;
    const fresh = new FakeDevice();
    Object.assign(fresh, { id: air.id, token: air.token, key: air.key, client: air.client });
    await fresh.hello();
    await oldStream;
    expect(air.events.slice(oldEvents)).toContainEqual({ type: "bye", reason: "replaced" });
    expect(await pending).toEqual({ ok: false, code: "disconnected", message: "open on MacBook Air: the device started a new session — it may or may not have happened" });
    await expect(fresh.connect(old).catch(status)).resolves.toBe(409);
    await expect(air.client.handsState({ session: old, state: "locked" }).catch(status)).resolves.toBe(409);
    await fresh.connect();
    air = fresh;
  });

  test("an offline device fails fast, and nothing is kept for when it's back", async () => {
    air.disconnect();
    await until("offline", () => !daemon.hands.online(air.id));
    const started = Date.now();
    const r = await tool("device_notify", { device: "MacBook Air", title: "Hi", body: "" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.text).toMatch(/^error: MacBook Air is offline \(last seen \d{4}-\d\d-\d\d \w{3} \d\d:\d\d\); nothing is queued for later$/);
    expect((await host.deviceCommands(air.id, 1))[0]).toMatchObject({ op: "notify", decision: "refused", outcome: null });
    expect((await host.handsDevices())[0]).toMatchObject({ online: false });
    const seen = air.events.length;
    await air.connect();
    await Bun.sleep(100);
    expect(air.events.slice(seen).filter((e) => e.type === "command")).toEqual([]);
  });

  test("a command with no answer is cancelled when its time is up, and may or may not have run", async () => {
    air.answer = () => null;
    const r = await daemon.hands.run({ op: "open", args: { url: "https://slow" }, timeoutMs: 50, episodeId: null });
    expect(r).toEqual({ ok: false, code: "timeout", message: "MacBook Air didn't finish open in time, so it was cancelled — it may or may not have happened" });
    const cmd = air.commands.at(-1)!;
    expect(cmd.timeoutMs).toBe(50);
    await until("the cancel", () => air.events.find((e) => e.type === "cancel" && e.id === cmd.id));
    expect((await host.deviceCommands(air.id, 1))[0]).toMatchObject({ id: cmd.id, outcome: "timeout" });
    // The most a command may ask for is its operation's cap.
    const capped = daemon.hands.run({ op: "notify", args: { title: "t", body: "" }, timeoutMs: 999_999, episodeId: null });
    const long = await until("the command", () => air.commands.find((c) => c.op === "notify" && c.seq > cmd.seq));
    expect(long.timeoutMs).toBe(5_000);
    await air.client.handsResult({ id: long.id, ok: true, data: {}, ms: 1 });
    expect((await capped).ok).toBe(true);
  });

  test("a tool call the brain gives up on cancels its command on the device", async () => {
    air.answer = () => null;
    const abort = new AbortController();
    const call = fetch(mcp.url, {
      method: "POST",
      headers: { authorization: `Bearer ${mcp.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "device_open", arguments: { app: "Mail" } } }),
      signal: abort.signal,
    }).catch(() => null);
    const cmd = await until("the command", () => air.commands.find((c) => c.args.app === "Mail"));
    abort.abort();
    await call;
    await until("the cancel", () => air.events.find((e) => e.type === "cancel" && e.id === cmd.id));
    expect((await host.deviceCommands(air.id, 5)).find((r) => r.id === cmd.id)).toMatchObject({ outcome: "cancelled" });
  });

  test("ask mode, the toggles, both pauses, the lock and permissions decide before anything is sent", async () => {
    air.answer = (c) => ({ id: c.id, ok: true, data: {}, ms: 1 });
    const sent = () => air.commands.length;
    const state = (u: Omit<Parameters<MidnaClient["handsState"]>[0], "session">) => air.client.handsState({ session: air.welcome.session, ...u });
    const n = sent();

    // Ask mode: looking runs; acting asks, and a no stops it.
    await host.updateSettings({ mode: "ask" });
    expect((await tool("device_notify", { title: "t", body: "" })).error).toBe(false);
    air.onApproval = () => "deny";
    expect((await tool("device_open", { url: "https://x" })).text).toBe("error: open https://x on MacBook Air: MacBook Air (device) said no");
    expect((await host.deviceCommands(air.id, 1))[0]).toMatchObject({ op: "open", decision: "denied", endedAt: expect.any(Number) });
    expect(sent()).toBe(n + 1);
    // A yes lets it go, carrying who said it.
    air.onApproval = (a) => (a.summary === "open https://x on MacBook Air" ? "allow" : null);
    expect((await tool("device_open", { url: "https://x" })).error).toBe(false);
    expect(air.commands.at(-1)!.approval).toEqual({ by: "MacBook Air (device)", at: expect.any(Number) });
    expect((await host.deviceCommands(air.id, 1))[0]).toMatchObject({ decision: "approved", decidedBy: "MacBook Air (device)", outcome: "ok" });
    air.onApproval = () => null;
    await host.updateSettings({ mode: "autonomous" });

    // A capability set to Ask on the device asks even in autonomous mode.
    await state({ offers: { screen: "on", open: "ask" } });
    air.onApproval = () => "deny";
    expect((await tool("device_open", { url: "https://x" })).text).toMatch(/said no$/);
    air.onApproval = () => null;
    // Turned off: refused.
    expect((await tool("device_notify", { title: "t", body: "" })).text).toBe("error: MacBook Air has notify turned off; only the user can turn it on, in the midna app on that computer");
    await state({ offers: { screen: "on", open: "on", notify: "on" } });

    // The global pause, from any client.
    expect((await host.updateSettings({ hands: "paused" })).hands).toBe("paused");
    expect((await tool("device_notify", { title: "t", body: "" })).text).toBe("error: the user has paused every device's hands (midna's hands setting)");
    await host.updateSettings({ hands: "on" });
    // Paused on the device.
    await state({ state: "paused" });
    expect((await tool("device_screenshot")).text).toBe("error: MacBook Air is paused by the user");
    // Locked: no looking at the lock screen, but a notification still shows.
    await state({ state: "locked" });
    expect((await tool("device_screenshot")).text).toBe("error: MacBook Air is locked");
    expect((await tool("device_notify", { title: "t", body: "" })).error).toBe(false);
    // Display asleep: only when asked to wake it.
    await state({ state: "display_asleep" });
    expect((await tool("device_screenshot")).text).toMatch(/display is asleep: take the screenshot with wake: true/);
    const woke = air.commands.length;
    await tool("device_screenshot", { wake: true });
    expect(air.commands[woke]).toMatchObject({ op: "screenshot", args: { wake: true } });
    await state({ state: "ready" });
    // A permission not granted.
    await state({ permissions: { screen_recording: "denied" } });
    expect((await tool("device_screenshot")).text).toBe(
      "error: MacBook Air can't use screen until the user grants the midna app Screen Recording there (System Settings → Privacy & Security)",
    );
    expect((await host.handsDevices())[0]!.capabilities).toContainEqual({ capability: "screen", policy: "on", missing: ["screen_recording"] });
    await state({ permissions: { screen_recording: "granted" } });

    // Refusals never reach the device, and each is in the audit log with its reason.
    const refused = (await host.deviceCommands(air.id, 50)).filter((r) => r.decision === "refused").map((r) => r.reason);
    expect(refused).toContain("MacBook Air is locked");
    expect(refused).toContain("the user has paused every device's hands (midna's hands setting)");
  });

  test("pausing everything cancels what's in flight", async () => {
    air.answer = () => null;
    const pending = daemon.hands.run({ op: "open", args: { path: "/tmp" }, episodeId: null });
    const cmd = await until("the command", () => air.commands.find((c) => c.args.path === "/tmp"));
    await host.updateSettings({ hands: "paused" });
    expect(await pending).toMatchObject({ ok: false, code: "cancelled", message: "open on MacBook Air: the user paused every device's hands — it may or may not have happened" });
    await until("the cancel", () => air.events.find((e) => e.type === "cancel" && e.id === cmd.id));
    await host.updateSettings({ hands: "on" });
  });

  test("with two devices, midna says which, by name or id", async () => {
    const tenet = await FakeDevice.pair("tenet");
    await tenet.hello({ os: { family: "linux", version: "6.17", arch: "x86_64", hostname: "tenet", session: "wayland" }, permissions: {} });
    await tenet.connect();
    expect((await tool("device_notify", { title: "t", body: "" })).text).toBe("error: more than one device can do that (MacBook Air, tenet): say which");
    expect((await tool("device_notify", { device: "TENET", title: "t", body: "" })).text).toBe("notified on tenet");
    // Linux has no such permissions to grant.
    expect((await host.handsDevices()).find((d) => d.name === "tenet")!.capabilities).toContainEqual({ capability: "screen", policy: "on", missing: [] });
    expect((await tool("device_notify", { device: "nope", title: "t", body: "" })).text).toMatch(/no device called "nope" offers its hands; these do: MacBook Air, .*tenet/);
    tenet.disconnect();
  });

  test("the prompt names the user's computers once one offers its hands", async () => {
    expect(devicesSection([])).toBe("");
    const before = runs.length;
    await host.send({ text: "what's on my screen?", client: "cli" });
    const run = await until("a chat turn", () => runs.slice(before).find((r) => r.prompt.includes("what's on my screen?")));
    expect(run.systemPrompt).toContain("# The user's computers");
    expect(run.systemPrompt).not.toContain("MacBook Air"); // whether it's online changes: that ends the prompt
    expect(run.prompt).toContain("## The user's computers\n- MacBook Air: online; screen, open, notify");
  });

  test("an approval asks everywhere at once, and the first answer wins", async () => {
    air.answer = (c) => ({ id: c.id, ok: true, data: c.op === "shell" ? { exit: 0, stdout: "upgraded\n", stderr: "", truncated: false } : {}, ms: 1 });
    await setState({ offers: ALL_ON, permissions: { screen_recording: "granted", accessibility: "granted", automation: "granted", notifications: "granted" } });
    await host.updateSettings({ mode: "ask" });
    const seen: StreamEvent[] = [];
    const stop = new AbortController();
    void (async () => {
      try {
        for await (const e of host.events((await host.status()).outboxSeq, stop.signal)) seen.push(e);
      } catch {
        /* stopped */
      }
    })();
    const telegram = await FakeDevice.pair("Telegram bridge", "bridge");
    const pending = tool("device_shell", { command: "brew upgrade" });
    const asked = await until("the approval", () => air.pending("shell")[0]);
    expect(asked).toMatchObject({ deviceId: air.id, deviceName: "MacBook Air", capability: "shell", op: "shell", summary: "run `brew upgrade` on MacBook Air", episodeId, state: "pending", answer: null });
    expect(asked.expiresAt - asked.requestedAt).toBe(APPROVAL_MS);
    expect(await host.approvals()).toEqual([asked]);
    // The same question is in chat, with the answers as its options.
    const question = await until("the question", () => seen.find((e): e is Extract<StreamEvent, { type: "outbox" }> => e.type === "outbox" && e.item.id === asked.outboxId));
    expect(question.item).toMatchObject({ kind: "question", priority: "urgent", options: ["Allow", "Allow for 10 min", "Deny"], text: "midna wants to run `brew upgrade` on MacBook Air. Allow? No answer in 4 seconds means no." });
    await until("the approval event", () => seen.find((e) => e.type === "approval" && e.approval.id === asked.id));
    // Tapping Allow on Telegram answers it, and midna never hears it as a message.
    const turns = runs.length;
    const answered = (await telegram.client.send({ text: "Allow", client: "telegram", replyTo: asked.outboxId! })) as unknown as { approval: Approval };
    expect(answered.approval).toMatchObject({ id: asked.id, state: "allowed", answer: "allow", answeredBy: "Telegram bridge", answeredVia: "telegram" });
    expect((await pending).text).toBe("MacBook Air: exit 0\nstdout:\nupgraded\n");
    expect(air.commands.at(-1)).toMatchObject({ op: "shell", approval: { by: "Telegram bridge (telegram)", at: expect.any(Number) } });
    expect((await host.deviceCommands(air.id, 1))[0]).toMatchObject({ decision: "approved", decidedBy: "Telegram bridge (telegram)", approvalId: asked.id, outcome: "ok" });
    // The first answer won: later ones are turned away, and midna's own host can't answer at all.
    await expect(air.client.answerApproval(asked.id, { answer: "deny", client: "device" }).catch(status)).resolves.toBe(409);
    await expect(telegram.client.send({ text: "Deny", client: "telegram", replyTo: asked.outboxId! }).catch(status)).resolves.toBe(409);
    await expect(host.answerApproval(asked.id, { answer: "allow" }).catch(status)).resolves.toBe(403);
    await expect(air.client.answerApproval("apr_nope", { answer: "allow" }).catch(status)).resolves.toBe(404);
    // Everyone hears it closed, its question is answered, and no turn ran for it.
    await until("closed on the device", () => air.approvals.get(asked.id)?.state === "allowed");
    await until("closed on the event stream", () => seen.find((e) => e.type === "approval" && e.approval.id === asked.id && e.approval.state === "allowed"));
    expect(seen.find((e) => e.type === "user_message" && e.text === "Allow")).toMatchObject({ replyTo: asked.outboxId, client: "telegram" });
    expect(daemon.store.db.query("SELECT answered_at FROM outbox WHERE id = $id").get({ id: asked.outboxId })).toEqual({ answered_at: expect.any(Number) });
    await Bun.sleep(100);
    expect(runs.length).toBe(turns);
    expect(await host.approvals()).toEqual([]);
    stop.abort();
  });

  test("no answer in time is no, and the panel on the machine can say no too", async () => {
    expect((await tool("device_open", { app: "Mail" })).text).toBe("error: open Mail on MacBook Air: no answer within 4 seconds, so no");
    expect((await host.deviceCommands(air.id, 1))[0]).toMatchObject({ op: "open", decision: "denied", reason: "no answer within 4 seconds, so no", approvalId: expect.stringMatching(/^apr_/) });
    air.onApproval = () => "deny";
    expect((await tool("device_open", { app: "Mail" })).text).toBe("error: open Mail on MacBook Air: MacBook Air (device) said no");
    expect((await host.deviceCommands(air.id, 1))[0]).toMatchObject({ decision: "denied", decidedBy: "MacBook Air (device)" });
    air.onApproval = () => null;
  }, 15_000);

  test("allow for 10 min lets that device and capability through, even what was already waiting", async () => {
    const first = tool("device_click", { x: 1, y: 1, then_screenshot: false });
    const second = tool("device_key", { keys: "return", then_screenshot: false });
    const [a] = await until("two approvals", () => (air.pending("click").length && air.pending("key").length ? air.pending("click") : undefined));
    await air.client.answerApproval(a!.id, { answer: "allow_10_min", client: "desktop" });
    expect((await first).text).toBe("clicked at 1,1 on MacBook Air");
    expect((await second).text).toBe("pressed return on MacBook Air");
    const asked = air.approvals.size;
    expect((await tool("device_type", { text: "hi", then_screenshot: false })).text).toBe("typed 2 characters on MacBook Air");
    expect(air.approvals.size).toBe(asked);
    expect((await host.deviceCommands(air.id, 1))[0]).toMatchObject({ op: "type", decision: "approved", decidedBy: "MacBook Air (desktop), allowed for 10 min", approvalId: expect.stringMatching(/^apr_/) });
    // Another capability still asks.
    air.onApproval = () => "deny";
    expect((await tool("device_clipboard_write", { text: "x" })).text).toBe("error: set the clipboard on MacBook Air: MacBook Air (device) said no");
    air.onApproval = () => null;
  });

  test("a tool call given up, or pausing everything, drops what waits for a yes", async () => {
    const paused = daemon.hands.run({ op: "script", args: { source: "beep" }, episodeId: null });
    const first = await until("an approval", () => air.pending("script")[0]);
    await host.updateSettings({ hands: "paused" });
    expect(await paused).toEqual({ ok: false, code: "denied", message: 'run AppleScript "beep" on MacBook Air: the request for approval was dropped' });
    expect(daemon.store.hands.approval(first.id)).toMatchObject({ state: "cancelled" });
    await host.updateSettings({ hands: "on" });
    const abort = new AbortController();
    const dropped = daemon.hands.run({ op: "script", args: { source: "beep" }, episodeId: null, signal: abort.signal });
    const second = await until("another approval", () => air.pending("script")[0]);
    abort.abort();
    expect(await dropped).toMatchObject({ ok: false, code: "denied" });
    await until("closed on the device", () => air.approvals.get(second.id)?.state === "cancelled");
    await host.updateSettings({ mode: "autonomous" });
  });

  test("pointer and keyboard tools act, then look", async () => {
    air.answer = async (c) => {
      if (c.op !== "screenshot") return { id: c.id, ok: true, data: {}, ms: 1 };
      const png = await air.client.upload(PNG, { name: "screenshot-1.png", mime: "image/png" });
      return { id: c.id, ok: true, data: { width: 1, height: 1, display: "1", scale: 2, cursor: null }, attachments: [png.id], ms: 1 };
    };
    const click = await tool("device_click", { x: 100, y: 200, count: 2 });
    expect(click.content[0]).toEqual({ type: "text", text: "double-clicked at 100,200 on MacBook Air" });
    expect(click.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(click.content[2]!.text).toMatch(/^MacBook Air, display 1: 1×1 px: attachment att_\S+ \(screenshot-1\.png, 1 KB\), saved at `.+\/workspace\/attachments\/att_\S+\/screenshot-1\.png`$/);
    expect(air.commands.slice(-2).map((c) => [c.op, c.args])).toEqual([["click", { x: 100, y: 200, count: 2 }], ["screenshot", {}]]);
    expect((await tool("device_move", { x: 5, y: 6, then_screenshot: false })).text).toBe("moved the pointer to 5,6 on MacBook Air");
    expect((await tool("device_drag", { path: [{ x: 1, y: 2 }, { x: 3, y: 4 }], then_screenshot: false })).text).toBe("dragged from 1,2 to 3,4 on MacBook Air");
    expect((await tool("device_scroll", { dy: 300, then_screenshot: false })).text).toBe("scrolled 0,300 on MacBook Air");
    expect(air.commands.at(-1)!.args).toEqual({ dx: 0, dy: 300 });
    // Typing gets time by its length, and secret text stays out of the audit log.
    await tool("device_type", { text: "x".repeat(450), secret: true, then_screenshot: false });
    expect(air.commands.at(-1)).toMatchObject({ op: "type", timeoutMs: 15_000, args: { text: "x".repeat(450), secret: true } });
    expect((await host.deviceCommands(air.id, 1))[0]!.args).toEqual({ text: "[450 characters, secret]", secret: true });
  });

  test("scripts, the shell, files and the clipboard", async () => {
    const lines = "line\n".repeat(20_000);
    const ok = (c: HandsCommand, data: unknown, attachments?: string[]): HandsResult => ({ id: c.id, ok: true, data, ...(attachments ? { attachments } : {}), ms: 1 });
    let fetched: Uint8Array | null = null;
    air.answer = async (c) => {
      switch (c.op) {
        case "script":
          return ok(c, { result: "3 unread" });
        case "shell": {
          const out = await air.client.upload(new TextEncoder().encode(lines), { name: "stdout.txt", mime: "text/plain" });
          return ok(c, { exit: 0, stdout: "line\nline\n", stderr: "warn", truncated: true }, [out.id]);
        }
        case "file_read": {
          if (c.args.path === "~/notes.txt") return ok(c, { path: "/Users/j/notes.txt", size: 5, text: "hello" });
          const pdf = await air.client.upload(new TextEncoder().encode("%PDF-1.7\n…"), { name: "report.pdf", mime: "application/pdf" });
          return ok(c, { path: "/Users/j/report.pdf", size: 12, text: null }, [pdf.id]);
        }
        case "file_list":
          return ok(c, { path: "/Users/j", entries: [{ name: "Documents", kind: "dir", size: null, modifiedAt: 1_792_447_200_000 }], truncated: false });
        case "file_write": {
          if (typeof c.args.attachmentId === "string") fetched = new Uint8Array(await (await fetch(`${daemon.url}/v1/attachments/${c.args.attachmentId}`, { headers: { authorization: `Bearer ${air.token}` } })).arrayBuffer());
          return ok(c, { bytes: fetched?.byteLength ?? String(c.args.text).length });
        }
        case "clipboard_read": {
          const png = await air.client.upload(PNG, { name: "clipboard.png", mime: "image/png" });
          return ok(c, { text: null }, [png.id]);
        }
        default:
          return ok(c, {});
      }
    };
    expect((await tool("device_applescript", { source: 'tell application "Mail" to count messages of inbox' })).text).toBe("result on MacBook Air:\n3 unread");
    expect(air.commands.at(-1)).toMatchObject({ op: "script", args: { language: "applescript" }, timeoutMs: 30_000 });

    const sh = await tool("device_shell", { command: "brew upgrade", timeout_s: 300 });
    expect(air.commands.at(-1)).toMatchObject({ op: "shell", args: { command: "brew upgrade" }, timeoutMs: 300_000 });
    const [, savedAt] = sh.text.match(/^MacBook Air: exit 0\nstdout:\nline\nline\n\nstderr:\nwarn\n\(stdout\.txt in full: attachment att_\S+ \(stdout\.txt, 98 KB\), saved at `(.+)`\)$/)!;
    expect(readFileSync(savedAt!, "utf8")).toBe(lines);

    expect((await tool("device_file_read", { path: "~/notes.txt" })).text).toBe("/Users/j/notes.txt on MacBook Air (1 KB):\nhello");
    expect((await tool("device_file_read", { path: "~/report.pdf" })).text).toMatch(/^\/Users\/j\/report\.pdf on MacBook Air \(1 KB\): attachment att_\S+ \(report\.pdf, 1 KB\), saved at `.+report\.pdf`$/);
    expect(JSON.parse((await tool("device_file_list", { path: "~" })).text)).toMatchObject({ path: "/Users/j", device: "MacBook Air", entries: [{ name: "Documents/", kind: "dir", size: null }] });

    // A file midna has goes to the device as an attachment it fetches.
    const local = join(home, "chart.png");
    writeFileSync(local, PNG);
    expect((await tool("device_file_write", { path: "~/Desktop/chart.png", file: local, mode: "overwrite" })).text).toBe("wrote 1 KB to ~/Desktop/chart.png on MacBook Air");
    expect(air.commands.at(-1)!.args).toEqual({ path: "~/Desktop/chart.png", attachmentId: expect.stringMatching(/^att_/), mode: "overwrite" });
    expect(fetched as Uint8Array | null).toEqual(PNG);
    expect((await tool("device_file_write", { path: "~/a.txt", text: "hi" })).text).toBe("wrote 1 KB to ~/a.txt on MacBook Air");
    expect(air.commands.at(-1)!.args).toEqual({ path: "~/a.txt", text: "hi", mode: "create" });
    expect((await tool("device_file_write", { path: "~/a.txt", text: "hi", file: local })).text).toBe("error: give text or file, not both");

    const clip = await tool("device_clipboard_read");
    expect(clip.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(clip.content[1]!.text).toMatch(/^clipboard on MacBook Air: attachment att_\S+ \(clipboard\.png/);
    expect((await tool("device_clipboard_write", { text: "copied" })).text).toBe("set the clipboard on MacBook Air");
  });

  test("in ask mode, reading runs and writing asks", async () => {
    await host.updateSettings({ mode: "ask" });
    air.onApproval = () => "deny";
    const before = air.approvals.size;
    expect((await tool("device_file_read", { path: "~/notes.txt" })).error).toBe(false);
    expect((await tool("device_file_list", { path: "~" })).error).toBe(false);
    expect((await tool("device_clipboard_read")).error).toBe(false);
    expect(air.approvals.size).toBe(before);
    expect((await tool("device_file_write", { path: "~/x", text: "y" })).text).toBe("error: write ~/x on MacBook Air: MacBook Air (device) said no");
    expect((await tool("device_applescript", { source: "beep" })).text).toBe('error: run AppleScript "beep" on MacBook Air: MacBook Air (device) said no');
    air.onApproval = () => null;
    await host.updateSettings({ mode: "autonomous" });
  });

  test("unpairing a device ends its stream at once", async () => {
    await host.revokeDevice(air.id);
    await air.ended;
    expect(air.events.at(-1)).toEqual({ type: "bye", reason: "revoked" });
    expect(daemon.hands.online(air.id)).toBe(false);
    expect((await host.handsDevices()).map((d) => d.name)).not.toContain("MacBook Air");
    await expect(air.client.handsHello({ ...HELLO, nonce: "n".repeat(20) }).catch(status)).resolves.toBe(401);
    // Its audit log stays.
    expect((await host.deviceCommands(air.id)).length).toBeGreaterThan(5);
  });
});
