import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EVENT_WINDOW_MS, MAX_ATTACHMENT_BYTES, MAX_EVENT_DATA_BYTES, MidnaClient, type EventKept, type EventReceipt, type OutboxItem, type StreamEvent } from "@midna/protocol";
import { BrainError, type Brain, type BrainRun } from "@midna/agent";
import { startDaemon, type RunningDaemon } from "../src/index.ts";

/**
 * The whole daemon with a stand-in brain. The stand-in drives midna's real
 * MCP tools over HTTP, exactly as Claude or Codex would, so this covers the
 * API, the event stream, the tool server, the scheduler and the episode
 * bookkeeping together.
 */

const runs: BrainRun[] = [];
let script: (run: BrainRun, tools: Client) => Promise<string> = async () => "ok";

async function mcp(run: BrainRun): Promise<Client> {
  const client = new Client({ name: "fake-brain", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(run.mcp.url), { requestInit: { headers: { authorization: `Bearer ${run.mcp.token}` } } }));
  return client;
}

const fakeBrain: Brain = async (run) => {
  runs.push(run);
  const sessionId = `session-${runs.length}`;
  const tools = await mcp(run);
  // Interrupted the way Claude Code is: the turn ends, and its session — what it did so far — survives.
  let stop = () => {};
  const interrupted = new Promise<never>((_, reject) => (stop = () => reject(new BrainError("claude turn interrupted", sessionId))));
  interrupted.catch(() => {});
  if (run.signal?.aborted) stop();
  else run.signal?.addEventListener("abort", stop, { once: true });
  try {
    const text = await Promise.race([script(run, tools), interrupted]);
    return { text, sessionId, sessionCostUsd: 0.01 };
  } finally {
    run.signal?.removeEventListener("abort", stop);
    await tools.close();
  }
};
/** A tool call that runs until the turn is interrupted. */
const forever = () => new Promise<string>(() => {});

const call = async (tools: Client, name: string, args: Record<string, unknown>) => {
  const r = (await tools.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  if (r.isError) throw new Error(r.content[0]!.text);
  return r.content[0]!.text;
};

let home: string;
let daemon: RunningDaemon;
let client: MidnaClient;
const events: StreamEvent[] = [];
const abort = new AbortController();

async function until<T>(what: string, fn: () => T | undefined, ms = 5_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
/** The receipt of an event midna kept; an ignored one fails the test. */
const kept = (r: EventReceipt): EventKept => {
  if (r.status === "ignored") throw new Error(`ignored: ${r.reason}`);
  return r;
};
const outbox = () => events.filter((e): e is { type: "outbox"; item: OutboxItem } => e.type === "outbox").map((e) => e.item);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "midna-test-"));
  script = async (run, tools) => {
    if (run.prompt.includes("First run")) {
      await call(tools, "message_user", { text: "Hi, I'm midna.", priority: "urgent" });
      return "introduced";
    }
    return "ok";
  };
  daemon = await startDaemon({
    home,
    port: 17000 + Math.floor(Math.random() * 20000),
    brain: fakeBrain,
    tickMs: 50,
    introDelayMs: 50,
    coalesceMs: 300,
    // A stand-in bridge: the daemon only knows bridges by name and launch command.
    bridgeSetups: {
      pager: async (input, ctx) => {
        if (input.token !== "good") throw new Error("the pager didn't accept that token");
        return { command: ["sleep", "60"], result: { instructions: `send this to the pager (code ${ctx.pairingCode.length} chars)`, code: "/start PAGER" } };
      },
    },
  });
  daemon.store.updateSettings({ quietHours: null }); // the clock must not decide what the tests see
  client = new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim());
  void (async () => {
    try {
      for await (const e of client.events(0, abort.signal)) events.push(e);
    } catch {
      /* aborted */
    }
  })();
});

afterAll(async () => {
  abort.abort();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("midnad", () => {
  test("introduces itself unprompted on first run", async () => {
    const hello = await until("intro", () => outbox().find((i) => i.text === "Hi, I'm midna."));
    expect(hello.kind).toBe("notification");
    expect(runs[0]!.prompt).toContain("Wakeup");
  });

  test("status says what thinking cost: each of the last 7 days, today by what started each turn", async () => {
    await until("intro", () => outbox().find((i) => i.text === "Hi, I'm midna."));
    const spend = (await client.status()).spend!;
    expect(spend).toHaveLength(7);
    // The introduction is a follow-up midna set itself; each fake turn is a session of its own at $0.01.
    expect(spend[0]!.byKind.followup).toEqual({ usd: 0.01, turns: 1 });
    expect(spend[0]!.usd).toBeGreaterThanOrEqual(0.01);
    expect(spend.slice(1).every((d) => d.usd === 0 && d.turns === 0)).toBe(true);
  });

  test("health is open; everything else needs a device token", async () => {
    expect((await new MidnaClient(daemon.url).health()).service).toBe("midna");
    expect(new MidnaClient(daemon.url, "mdn_nope").status()).rejects.toThrow(/unauthorized/);
    const res = await fetch(`${daemon.url}/mcp/1`, { method: "POST", headers: { authorization: "Bearer mdn_nope" } });
    expect(res.status).toBe(401);
  });

  test("a chat turn uses the tools, replies on the stream, and records everything", async () => {
    script = async (run, tools) => {
      const { tools: list } = await tools.listTools();
      const names = list.map((t) => t.name);
      for (const n of ["goal_save", "task_save", "commitment_save", "remember", "recall", "schedule_wakeup", "message_user", "ask_user", "decision_save"]) expect(names).toContain(n);
      const goal = JSON.parse(await call(tools, "goal_save", { title: "Run a marathon", horizon: "year", why: "health" }));
      await call(tools, "remember", { content: "Training for a marathon in spring", kind: "context", importance: 7, about: [{ entity: "goal", id: goal.id }] });
      await call(tools, "schedule_wakeup", { reason: "stretch", when: "+0m", kind: "reminder" });
      await expect(call(tools, "goal_save", { id: goal.id, title: "Run an ultra" })).rejects.toThrow(/reason/);
      expect(run.resume).toBeUndefined();
      return "Noted — goal recorded.";
    };
    await client.send({ text: "I want to run a marathon", client: "test" });
    await until("reply", () => outbox().find((i) => i.text === "Noted — goal recorded."));
    await until("reminder", () => outbox().find((i) => i.text === "⏰ stretch"));
    expect(events.some((e) => e.type === "status" && e.state === "thinking")).toBe(true);
    expect(events.some((e) => e.type === "user_message" && e.text === "I want to run a marathon")).toBe(true);

    const overview = (await client.overview()) as { goals: Array<{ title: string }>; memory: { live: number } };
    expect(overview.goals.map((g) => g.title)).toContain("Run a marathon");
    expect(overview.memory.live).toBe(1);
    const audit = daemon.store.log.actions(0).map((a) => a.tool);
    expect(audit).toEqual(expect.arrayContaining(["goal_save", "remember", "schedule_wakeup"]));
  });

  test("the next turn resumes the session and hears what midna said on its own", async () => {
    script = async (run) => {
      expect(run.resume).toBeDefined();
      expect(run.prompt).toContain("you sent, on your own");
      expect(run.prompt).toContain("⏰ stretch");
      expect(run.prompt).toContain("Run a marathon"); // the objectives changed during its last turn
      return "Done stretching? Good.";
    };
    await client.send({ text: "stretched", client: "test" });
    await until("second reply", () => outbox().find((i) => i.text === "Done stretching? Good."));
  });

  test("the system prompt stays byte for byte the same; what changes ends each turn's prompt", async () => {
    script = async () => "noted";
    const from = runs.length;
    await client.send({ text: "first, before the new task", client: "test" });
    await until("first turn", () => runs.length > from && !daemon.store.log.unseen("main").length);
    const a = runs.at(-1)!;
    daemon.store.planning.saveTask({ title: "Renew the passport" });
    await client.send({ text: "second, after it", client: "test" });
    await until("second turn", () => runs.length > from + 1 && !daemon.store.log.unseen("main").length);
    const b = runs.at(-1)!;
    expect(b.resume).toBeDefined();
    expect(b.systemPrompt).toBe(a.systemPrompt);
    expect(a.systemPrompt).toContain("# Current state");
    expect(a.systemPrompt).not.toContain("## Now");
    // The resumed session hears the clock and what changed, not what it already holds.
    expect(b.prompt).toMatch(/\[midna\] The current state: the sections that changed since your last turn in this session\.[^]*## Now\n[^]*## Open tasks\n[^]*Renew the passport/);
    expect(b.prompt).not.toContain("## The user's objectives");
    // A wakeup starts a fresh session on the same system prompt, and hears all of it.
    daemon.store.schedule.add({ dueAt: Date.now(), reason: "check the passport form", tz: "UTC" });
    const w = await until("wakeup turn", () => runs.slice(from + 2).find((r) => r.prompt.includes("check the passport form")));
    expect(w.resume).toBeUndefined();
    expect(w.systemPrompt).toBe(a.systemPrompt);
    expect(w.prompt).toMatch(/\[midna\] The current state, from your database[^]*## The user's objectives\n[^]*Run a marathon[^]*## Open tasks\n[^]*Renew the passport/);
    // A pinned fact is in the system prompt, the one part that changes only when the user's world does.
    daemon.store.memory.remember({ content: "Allergic to penicillin", kind: "identity", importance: 10, pinned: true });
    await client.send({ text: "third", client: "test" });
    await until("third turn", () => runs.at(-1)!.prompt.includes("third") && !daemon.store.log.unseen("main").length);
    expect(runs.at(-1)!.systemPrompt).toContain("# Pinned memories\nWhat you pinned because it must never fade:\n- #");
    expect(runs.at(-1)!.systemPrompt).toContain("Allergic to penicillin");
    expect(runs.at(-1)!.prompt).not.toContain("Allergic to penicillin");
  });

  test("questions carry options and answers are tied back to them", async () => {
    script = async (run, tools) => {
      if (run.prompt.includes("decide")) {
        await call(tools, "ask_user", { question: "Morning or evening runs?", options: ["Morning", "Evening"] });
        return "";
      }
      expect(run.prompt).toContain('answering your question: "Morning or evening runs?"');
      return "Mornings it is.";
    };
    await client.send({ text: "help me decide when to train", client: "test" });
    const q = await until("question", () => outbox().find((i) => i.kind === "question"));
    expect(q.options).toEqual(["Morning", "Evening"]);
    await client.send({ text: "Morning", client: "test", replyTo: q.id });
    await until("answer reply", () => outbox().find((i) => i.text === "Mornings it is."));
  });

  test("a failing brain tells the user instead of going silent", async () => {
    script = async () => {
      throw new Error("rate limited");
    };
    await client.send({ text: "anything", client: "test" });
    const msg = await until("error message", () => outbox().find((i) => i.text.includes("rate limited")));
    expect(msg.kind).toBe("message");
  });

  test("settings are validated and reach the brain", async () => {
    await expect(client.updateSettings({ model: "nosuchprovider:x" })).rejects.toThrow(/unknown provider/);
    await expect(client.updateSettings({ timezone: "Mars/Olympus" })).rejects.toThrow(/timezone/);
    await expect(client.updateSettings({ fallback: ["nosuchprovider:x"] })).rejects.toThrow(/unknown provider/);
    const none = await client.updateSettings({ fallback: [] });
    expect(none.fallback).toEqual([]);
    expect(none.activeModel).toBe(none.model);
    expect(none.caps).toEqual({});
    const s = await client.updateSettings({ mode: "ask", timezone: "Asia/Seoul" });
    expect(s.mode).toBe("ask");
    script = async (run) => {
      expect(run.mode).toBe("ask");
      expect(run.systemPrompt).toContain("ASK mode");
      return "asking first from now on";
    };
    await client.send({ text: "ping", client: "test" });
    await until("ask-mode reply", () => outbox().find((i) => i.text === "asking first from now on"));
  });

  test("pairing gives another device its own token; replay resumes by seq", async () => {
    const { code } = await client.pairingCode();
    const paired = await new MidnaClient(daemon.url).pair({ code, deviceName: "laptop", kind: "desktop" });
    const laptop = new MidnaClient(daemon.url, paired.token);
    const all = await laptop.outbox(0);
    expect(all.length).toBeGreaterThan(3);
    const tail = await laptop.outbox(all[1]!.seq);
    expect(tail[0]!.seq).toBe(all[2]!.seq);
    expect((await client.devices()).map((d) => d.name)).toContain("laptop");
  });

  test("a client pairing again names its old token, and that pairing is retired", async () => {
    const first = await new MidnaClient(daemon.url).pair({ code: (await client.pairingCode()).code, deviceName: "tablet", kind: "desktop" });
    const again = await new MidnaClient(daemon.url).pair({ code: (await client.pairingCode()).code, deviceName: "tablet", kind: "desktop", replaces: first.token });
    expect(again.replaced).toBe(first.deviceId);
    await expect(new MidnaClient(daemon.url, first.token).status()).rejects.toMatchObject({ status: 401 });
    expect((await new MidnaClient(daemon.url, again.token).status()).version).toBeString();
    const ids = (await client.devices()).map((d) => d.id);
    expect(ids).toContain(again.deviceId);
    expect(ids).not.toContain(first.deviceId);
    // A token this daemon doesn't know (a reflashed host) doesn't stop the pairing.
    const fresh = await new MidnaClient(daemon.url).pair({ code: (await client.pairingCode()).code, deviceName: "tablet", kind: "desktop", replaces: "mdn_from_another_host" });
    expect(fresh.replaced).toBeUndefined();
    expect((await client.devices()).map((d) => d.id)).toContain(again.deviceId);
  });

  test("history redraws the conversation: questions keep their options and know they were answered", async () => {
    const history = await client.history({ limit: 200 });
    const q = history.find((h) => h.outbox?.kind === "question")!;
    expect(q.text).toBe("Morning or evening runs?");
    expect(q.outbox).toMatchObject({ options: ["Morning", "Evening"], answered: true });
    const answer = history.find((h) => h.role === "user" && h.replyTo === q.outbox!.id)!;
    expect(answer.text).toBe("Morning");
    expect(history.map((h) => h.id)).toEqual([...history.map((h) => h.id)].sort((a, b) => a - b));
    const older = await client.history({ before: answer.id, limit: 2 });
    expect(older.every((h) => h.id < answer.id)).toBe(true);
    expect(older.length).toBe(2);
  });

  test("the desktop app's web view may call it (CORS), with its token", async () => {
    const res = await fetch(`${daemon.url}/v1/status`, { method: "OPTIONS", headers: { origin: "tauri://localhost", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  test("bridges are connected through the API without the daemon knowing what they are", async () => {
    await expect(client.setupBridge("pager", { token: "bad" })).rejects.toThrow(/didn't accept/);
    await expect(client.setupBridge("smoke-signals", {})).rejects.toThrow(/doesn't know a bridge/);
    const r = await client.setupBridge("pager", { token: "good" });
    expect(r.code).toBe("/start PAGER");
    expect(await client.bridges()).toContainEqual({ name: "pager", enabled: true });
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config.bridges.pager.command).toEqual(["sleep", "60"]);
  });

  test("a signed-out brain: the user is told once, the work waits, and runs when the brain answers", async () => {
    await client.updateSettings({ mode: "autonomous" });
    const signedOut = new Error("claude: not logged in (Claude Code returned an error result: Not logged in · Please run /login). Run: claude (then /login)");
    let wakeupRuns = 0;
    script = async (run) => {
      // The wakeup's own turn: a chat turn's state lists it too, as a wakeup waiting.
      if (run.prompt.startsWith("[Wakeup") && run.prompt.includes("check the oven")) {
        wakeupRuns++;
        if (wakeupRuns === 1) throw signedOut;
        return "checked";
      }
      return "fine";
    };
    const w = daemon.store.schedule.add({ dueAt: Date.now(), reason: "check the oven", tz: "UTC" });
    const alert = await until("alert", () => outbox().find((i) => i.text.startsWith("I can't think right now")));
    expect(alert.priority).toBe("urgent");
    expect(alert.text).toContain("run `claude` there and type /login");
    const health = (await client.status()).brain;
    expect(health).toMatchObject({ ok: false, reason: "signed_out", loginCommand: "claude (then /login)" });
    const waiting = daemon.store.schedule.get(w.id)!;
    expect(waiting.status).toBe("pending");
    expect(waiting.due_at).toBeGreaterThan(Date.now() + 10 * 60_000);

    // Any successful turn proves the brain is back; what was waiting runs at once.
    await client.send({ text: "are you there?", client: "test" });
    await until("wakeup rerun", () => daemon.store.schedule.get(w.id)!.status === "done" || undefined);
    expect(wakeupRuns).toBe(2);
    expect((await client.status()).brain.ok).toBe(true);
  });
  test("midna sends images from its machine and the web; only a paired device gets the bytes", async () => {
    const chart = join(home, "workspace", "chart.png");
    writeFileSync(chart, PNG);
    const web = Bun.serve({ port: 0, fetch: () => new Response(PNG, { headers: { "content-type": "image/png" } }) });
    try {
      script = async (run, tools) => {
        if (!run.prompt.includes("show me")) return "";
        await call(tools, "message_user", { text: "Two pictures", attachments: [chart, `http://127.0.0.1:${web.port}/cat.png`] });
        expect(await call(tools, "attach", { files: [chart] })).toContain("chart.png (image");
        await expect(call(tools, "attach", { files: ["relative/x.png"] })).rejects.toThrow(/absolute path/);
        return `Here's the chart:\n\n![chart](${chart})\n\nand one from the web ![cat](https://example.com/cat.png)`;
      };
      await client.send({ text: "show me the chart", client: "test" });
      const note = await until("notification", () => outbox().find((i) => i.text === "Two pictures"));
      expect(note.attachments.map((a) => [a.name, a.kind, a.mime])).toEqual([
        ["chart.png", "image", "image/png"],
        ["cat.png", "image", "image/png"],
      ]);
      // The attached file and the Markdown image of a local file both go with the reply; the web image stays in the text.
      const reply = await until("reply", () => outbox().find((i) => i.text.startsWith("Here's the chart")));
      expect(reply.text).toBe("Here's the chart:\n\nand one from the web ![cat](https://example.com/cat.png)");
      expect(reply.attachments.map((a) => a.name)).toEqual(["chart.png", "chart.png"]);

      const id = reply.attachments[0]!.id;
      expect(new Uint8Array(await (await client.attachment(id)).arrayBuffer())).toEqual(PNG);
      const res = await fetch(`${daemon.url}/v1/attachments/${id}`, { headers: { authorization: `Bearer ${readFileSync(join(home, "host.token"), "utf8").trim()}` } });
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await fetch(`${daemon.url}/v1/attachments/${id}`)).status).toBe(401);
      await expect(client.attachment("att_nope")).rejects.toThrow(/no such attachment/);
      const line = (await client.history({ limit: 5 })).find((h) => h.outbox?.id === reply.id)!;
      expect(line.attachments.map((a) => a.id)).toEqual(reply.attachments.map((a) => a.id));
    } finally {
      web.stop(true);
    }
  });

  test("images the user sends reach the brain as files it can open", async () => {
    const photo = await client.upload(PNG, { name: "receipt.png", mime: "image/png" });
    expect(photo).toMatchObject({ kind: "image", name: "receipt.png", size: PNG.byteLength });
    let seen: Uint8Array | null = null;
    script = async (run) => {
      const path = /saved at `([^`]+)`/.exec(run.prompt)?.[1];
      if (path) seen = new Uint8Array(readFileSync(path));
      return "Got the receipt.";
    };
    await client.send({ text: "", attachments: [photo.id], client: "test" });
    await until("reply", () => outbox().find((i) => i.text === "Got the receipt."));
    expect(seen!).toEqual(PNG);
    const echo = events.find((e) => e.type === "user_message" && e.attachments.length) as Extract<StreamEvent, { type: "user_message" }>;
    expect(echo.attachments).toEqual([photo]);
    const line = (await client.history({ limit: 5 })).find((h) => h.role === "user" && h.attachments.length)!;
    expect(line.attachments).toEqual([photo]);
    await expect(client.send({ text: "look", attachments: ["att_nope"], client: "test" })).rejects.toThrow(/upload it first/);
    await expect(client.send({ text: " ", client: "test" })).rejects.toThrow(/text or an attachment/);
  });

  test("on a wakeup, files go with message_user: there is no reply to attach them to", async () => {
    let refused = "";
    script = async (run, tools) => {
      if (!run.prompt.includes("send the plot")) return "";
      await call(tools, "attach", { files: [join(home, "workspace", "chart.png")] }).catch((err) => (refused = (err as Error).message));
      await call(tools, "message_user", { text: "Tonight's plot", attachments: [join(home, "workspace", "chart.png")] });
      return "sent";
    };
    daemon.store.schedule.add({ dueAt: Date.now(), reason: "send the plot", tz: "UTC" });
    const sent = await until("plot", () => outbox().find((i) => i.text === "Tonight's plot"));
    expect(sent.attachments).toHaveLength(1);
    expect(refused).toMatch(/message_user/);
  });
  test("the user sends files of any type, up to 100 MB, and the brain opens them in the order sent", async () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const zip = await client.upload(enc("PK\u0003\u0004 fake archive"), { name: "results.zip", mime: "application/zip" });
    const pdf = await client.upload(enc("%PDF-1.7 fake"), { name: "Q4 plan.pdf", mime: "application/pdf", caption: "the plan" });
    const big = new Uint8Array(30 * 1024 * 1024);
    big.set(enc("not much"), 0);
    const dataset = await client.upload(big, { name: "dataset.bin", mime: "application/octet-stream" });
    const shot = await client.upload(PNG, { name: "screen.png", mime: "image/png", as: "file" });
    expect([zip, pdf, dataset, shot].map((a) => [a.name, a.kind, a.mime, a.size, a.caption])).toEqual([
      ["results.zip", "file", "application/zip", 17, null],
      ["Q4 plan.pdf", "file", "application/pdf", 13, "the plan"],
      ["dataset.bin", "file", "application/octet-stream", 30 * 1024 * 1024, null],
      ["screen.png", "file", "image/png", PNG.byteLength, null],
    ]);

    let prompt = "";
    script = async (run) => {
      prompt = run.prompt;
      return "Read them all.";
    };
    const order = [pdf.id, dataset.id, shot.id, zip.id];
    await client.send({ text: "everything for the review", attachments: order, client: "test" });
    await until("reply", () => outbox().find((i) => i.text === "Read them all."));

    const echo = events.findLast((e) => e.type === "user_message") as Extract<StreamEvent, { type: "user_message" }>;
    expect(echo.attachments.map((a) => a.id)).toEqual(order);
    const line = (await client.history({ limit: 5 })).find((h) => h.text === "everything for the review")!;
    expect(line.attachments.map((a) => a.id)).toEqual(order);
    // Each file waits in the workspace under its own name, listed in the order sent.
    const listed = [...prompt.matchAll(/Attached (\d)\/4 (\w+) "([^"]+)" \(([^,]+), [^)]+\)(?:, captioned "([^"]+)")?, saved at `([^`]+)`/g)];
    expect(listed.map((m) => [m[1], m[3], m[4], m[5] ?? null])).toEqual([
      ["1", "Q4 plan.pdf", "application/pdf", "the plan"],
      ["2", "dataset.bin", "application/octet-stream", null],
      ["3", "screen.png", "image/png", null],
      ["4", "results.zip", "application/zip", null],
    ]);
    for (const m of listed) expect(m[6]!).toEndWith(`/workspace/attachments/${order[Number(m[1]) - 1]}/${m[3]}`);
    expect(readFileSync(listed[1]![6]!).byteLength).toBe(30 * 1024 * 1024);
    expect(readFileSync(listed[3]![6]!, "utf8")).toStartWith("PK");
  });

  test("an upload the user removes before sending can be taken back; a sent one stays", async () => {
    const draft = await client.upload(PNG, { name: "draft.png", mime: "" });
    expect(draft.mime).toBe("image/png"); // an unknown type from the browser is fine: the bytes decide
    expect(await client.deleteAttachment(draft.id)).toEqual({ ok: true });
    await expect(client.deleteAttachment(draft.id)).rejects.toThrow(/no such attachment/);
    const sent = (await client.history({ limit: 50 })).flatMap((h) => h.attachments)[0]!;
    await expect(client.deleteAttachment(sent.id)).rejects.toThrow(/stays with it/);
  });

  test("an upload past the limit is turned away, even one that doesn't say its length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (sent > MAX_ATTACHMENT_BYTES) return ctl.close();
        sent += chunk.byteLength;
        ctl.enqueue(chunk);
      },
    });
    const res = await fetch(`${daemon.url}/v1/attachments?name=huge.bin`, {
      method: "POST",
      headers: { authorization: `Bearer ${readFileSync(join(home, "host.token"), "utf8").trim()}`, "content-type": "application/octet-stream" },
      body,
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain("100 MB");
  });

  test("midna sends any file, in the order it lists them, with the names, captions and form it chooses", async () => {
    const dir = join(home, "workspace");
    writeFileSync(join(dir, "notes.txt"), "raw notes");
    writeFileSync(join(dir, "report.pdf"), "%PDF-1.7 report");
    writeFileSync(join(dir, "chart.png"), PNG);
    script = async (run, tools) => {
      if (!run.prompt.includes("send the files")) return "";
      await call(tools, "message_user", {
        text: "The review pack",
        attachments: [{ file: join(dir, "notes.txt"), caption: "raw notes" }, { file: join(dir, "chart.png"), as: "file", name: "chart-full.png" }, join(dir, "report.pdf")],
      });
      // Attached across two calls, in call order.
      await call(tools, "attach", { files: [join(dir, "report.pdf")] });
      expect(await call(tools, "attach", { files: [{ file: join(dir, "notes.txt"), name: "notes-v2.txt" }] })).toContain("notes-v2.txt (text/plain");
      return "And for this chat:";
    };
    await client.send({ text: "send the files", client: "test" });
    const pack = await until("pack", () => outbox().find((i) => i.text === "The review pack"));
    expect(pack.attachments.map((a) => [a.name, a.kind, a.mime, a.caption])).toEqual([
      ["notes.txt", "file", "text/plain", "raw notes"],
      ["chart-full.png", "file", "image/png", null],
      ["report.pdf", "file", "application/pdf", null],
    ]);
    const reply = await until("reply", () => outbox().find((i) => i.text === "And for this chat:"));
    expect(reply.attachments.map((a) => a.name)).toEqual(["report.pdf", "notes-v2.txt"]);
    expect(new TextDecoder().decode(await (await client.attachment(reply.attachments[1]!.id)).arrayBuffer())).toBe("raw notes");
  });
  test("a reply swallowed by a background-task notification is asked for again, once, plainly", async () => {
    const asked: BrainRun[] = [];
    script = async (run) => {
      if (!run.prompt.includes("meeting is tonight")) return "ok";
      asked.push(run);
      return asked.length === 1 ? "No response requested." : "Noted — see you there.";
    };
    await client.send({ text: "the meeting is tonight", client: "test" });
    await until("reply", () => outbox().find((i) => i.text === "Noted — see you there."));
    expect(outbox().some((i) => /no response requested/i.test(i.text))).toBe(false);
    expect(asked[0]!.prompt).toStartWith("[midna] A message from the user — real user input, and it needs a reply.");
    expect(asked[1]!.prompt).toContain("ended without a reply to the user");
    expect(asked[1]!.prompt).toContain("User: the meeting is tonight");
    expect(asked[1]!.resume).toBe(`session-${runs.indexOf(asked[0]!) + 1}`);
    expect(daemon.store.log.unseen("main")).toEqual([]);
  });

  test("when asking again gets nothing too, the user hears it arrived and a follow-up answers it", async () => {
    script = async (run, tools) => {
      if (run.prompt.includes("[Wakeup") && run.prompt.includes("dentist")) {
        await call(tools, "message_user", { text: "Booked the dentist for Tuesday." });
        return "answered";
      }
      return run.prompt.includes("dentist") ? "" : "ok";
    };
    await client.send({ text: "book the dentist", client: "test" });
    const fallback = await until("fallback", () => outbox().find((i) => i.text.startsWith("Got your message")));
    expect(fallback.kind).toBe("message");
    const followup = daemon.store.schedule.pending(100).find((w) => w.reason.includes("book the dentist"))!;
    expect(followup.due_at).toBeGreaterThan(Date.now() + 30_000);
    daemon.store.schedule.reschedule(followup.id, Date.now());
    await until("follow-up answer", () => outbox().find((i) => i.text === "Booked the dentist for Tuesday."));
    expect(daemon.store.log.unseen("main").filter((m) => m.role === "user")).toEqual([]);
  });

  test("a message starting /queue waits, unhandled, for the turn in progress and then gets its own", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const prompts: string[] = [];
    script = async (run) => {
      if (run.prompt.includes("first thing")) {
        prompts.push(run.prompt);
        await gate;
        return "Reply to the first.";
      }
      if (run.prompt.includes("second thing")) {
        prompts.push(run.prompt);
        return "Reply to the second.";
      }
      return "ok";
    };
    await client.send({ text: "first thing", client: "test" });
    await until("first turn running", () => prompts.length === 1 || undefined);
    await client.send({ text: "/queue second thing", client: "telegram" });
    await Bun.sleep(400); // longer than the coalescing window: nothing is interrupted
    // Neither counts as handled while the first turn runs; the prefix is gone.
    const waiting = daemon.store.log.unseen("main").filter((m) => m.role === "user").map((m) => m.text);
    release();
    expect(waiting).toEqual(["first thing", "second thing"]);
    await until("second reply", () => outbox().find((i) => i.text === "Reply to the second."));
    expect(outbox().some((i) => i.text === "Reply to the first.")).toBe(true);
    const userPart = prompts[1]!.split("\n\n")[0]!;
    expect(userPart).toContain("User: second thing");
    expect(userPart).not.toContain("first thing");
    expect(prompts[1]).not.toContain("/queue");
    expect(prompts[1]).not.toContain("You were interrupted");
    expect(daemon.store.log.unseen("main")).toEqual([]);
    await expect(client.send({ text: "/queue  ", client: "test" })).rejects.toThrow(/text or an attachment/);
  });

  test("a new message interrupts the turn mid-tool-call; the next carries on in its session and answers both", async () => {
    const said = outbox().length;
    const seen = events.length;
    const turns: BrainRun[] = [];
    script = async (run, tools) => {
      if (!run.prompt.includes("build the slides")) return "ok";
      turns.push(run);
      if (turns.length > 1) return "Stopped the slides — Friday it is, noted.";
      await call(tools, "remember", { content: "The slides are for tonight's meeting", kind: "context", importance: 4 });
      run.onActivity?.("Bash", "render the deck");
      return forever();
    };
    await client.send({ text: "build the slides for tonight", client: "desktop" });
    await until("mid-tool", () => events.slice(seen).some((e) => e.type === "activity" && e.tool === "Bash") || undefined);
    await client.send({ text: "stop — the meeting moved to Friday", client: "telegram" });
    await until("reply", () => outbox().find((i) => i.text === "Stopped the slides — Friday it is, noted."));

    const [cut, next] = turns as [BrainRun, BrainRun];
    // The next turn resumes the interrupted session, whose transcript holds what it did.
    expect(next.resume).toBe(`session-${runs.indexOf(cut) + 1}`);
    expect(next.prompt).toStartWith("[midna] A message from the user — real user input");
    const userPart = next.prompt.split("\n\n")[0]!;
    expect(userPart).toContain("User: build the slides for tonight");
    expect(userPart).toContain("User: stop — the meeting moved to Friday");
    expect(next.prompt).toContain("You were interrupted: the user wrote again while your previous turn was still working");
    expect(next.prompt).toContain("in the middle of Bash (render the deck)");
    expect(next.prompt).toContain("in your transcript above");
    // What the interrupted turn's tools did stands, and its episode says why it ended.
    expect((await client.overview() as { memory: { live: number } }).memory.live).toBeGreaterThanOrEqual(2);
    const ended = daemon.store.db.query("SELECT error FROM episodes WHERE brain_session = $s").get({ s: `session-${runs.indexOf(cut) + 1}` }) as { error: string | null };
    expect(ended.error).toBe("interrupted by a message from the user");
    // Nothing went out for the interrupted turn: no error, no fallback. Both messages are answered.
    expect(outbox().slice(said).map((i) => i.text)).toEqual(["Stopped the slides — Friday it is, noted."]);
    expect(daemon.store.log.unseen("main").filter((m) => m.role === "user")).toEqual([]);
  });

  test("a burst of messages is one interrupt, answered together in one turn", async () => {
    const turns: BrainRun[] = [];
    script = async (run) => {
      if (!run.prompt.includes("plan the trip")) return "ok";
      turns.push(run);
      return turns.length === 1 ? forever() : "Busan, two nights, KTX — on it.";
    };
    const before = runs.length;
    await client.send({ text: "plan the trip", client: "test" });
    await until("turn running", () => turns.length === 1 || undefined);
    const burst = ["actually make it Busan", "two nights", "and book the KTX"];
    for (const text of burst) {
      await client.send({ text, client: "telegram" });
      await Bun.sleep(60);
    }
    await until("reply", () => outbox().find((i) => i.text === "Busan, two nights, KTX — on it."));
    await daemon.assistant.idle();
    expect(runs.length - before).toBe(2); // the interrupted turn and one more: not one per message
    const userPart = turns[1]!.prompt.split("\n\n")[0]!;
    for (const text of ["plan the trip", ...burst]) expect(userPart).toContain(`User: ${text}`);
    expect(daemon.store.log.unseen("main").filter((m) => m.role === "user")).toEqual([]);
  });

  test("the user's message interrupts a wakeup, which carries on afterwards in its own session", async () => {
    const wakeups: BrainRun[] = [];
    script = async (run, tools) => {
      if (run.prompt.includes("quick question")) return "Sure — what is it?";
      if (!run.prompt.includes("tidy the inbox")) return "ok";
      wakeups.push(run);
      if (wakeups.length === 1) {
        run.onActivity?.("Bash", "archive old mail");
        return forever();
      }
      await call(tools, "message_user", { text: "Inbox tidied." });
      return "tidied";
    };
    const w = daemon.store.schedule.add({ dueAt: Date.now(), reason: "tidy the inbox", tz: "UTC" });
    await until("wakeup running", () => wakeups.length === 1 || undefined);
    await Bun.sleep(50);
    await client.send({ text: "quick question", client: "test" });
    await until("chat reply", () => outbox().find((i) => i.text === "Sure — what is it?"));
    const chat = runs.findLast((r) => r.prompt.includes("quick question"))!;
    expect(chat.prompt).toContain('your own wakeup "tidy the inbox" was set aside while you were in the middle of Bash (archive old mail)');

    // It waits, and when it runs again it picks up in the session that did the work so far.
    const waiting = await until("set aside", () => (daemon.store.schedule.get(w.id)!.status === "pending" ? daemon.store.schedule.get(w.id)! : undefined));
    expect(waiting.due_at).toBeGreaterThan(Date.now() + 30_000);
    daemon.store.schedule.reschedule(w.id, Date.now());
    await until("carried on", () => outbox().find((i) => i.text === "Inbox tidied."));
    expect(wakeups[1]!.resume).toBe(`session-${runs.indexOf(wakeups[0]!) + 1}`);
    expect(wakeups[1]!.prompt).toContain("You set this aside part-way through, in the middle of Bash (archive old mail), to answer a message from the user.");
    await until("done", () => daemon.store.schedule.get(w.id)!.status === "done" || undefined);
  });

  test("a wakeup that comes due mid-turn never interrupts it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    script = async (run, tools) => {
      if (run.prompt.includes("long answer")) {
        started = true;
        await gate;
        return "Here's the long answer.";
      }
      if (run.prompt.includes("water the plants")) {
        await call(tools, "message_user", { text: "Plants watered." });
        return "watered";
      }
      return "ok";
    };
    await client.send({ text: "long answer please", client: "test" });
    await until("chat turn running", () => started || undefined);
    daemon.store.schedule.add({ dueAt: Date.now(), reason: "water the plants", tz: "UTC" });
    await until("wakeup ran", () => outbox().find((i) => i.text === "Plants watered."));
    release();
    await until("chat reply", () => outbox().find((i) => i.text === "Here's the long answer."));
  });

  test("a turn that fails leaves the user's message waiting for the next one", async () => {
    let prompt = "";
    script = async (run) => {
      if (run.prompt.includes("try again")) {
        prompt = run.prompt;
        return "Both handled.";
      }
      if (run.prompt.includes("flaky question")) throw new Error("overloaded");
      return "ok";
    };
    await client.send({ text: "flaky question", client: "test" });
    await until("error", () => outbox().find((i) => i.text.includes("overloaded")));
    expect(daemon.store.log.unseen("main").some((m) => m.text === "flaky question")).toBe(true);
    await client.send({ text: "try again", client: "test" });
    await until("reply", () => outbox().find((i) => i.text === "Both handled."));
    const userPart = prompt.split("\n\n")[0]!;
    expect(userPart).toContain("User: flaky question");
    expect(userPart).toContain("User: try again");
    expect(daemon.store.log.unseen("main").filter((m) => m.role === "user")).toEqual([]);
  });

  test("an event from ruri is heard in the background: by a wakeup, never as the user's words", async () => {
    const idle = {
      id: "evt-1",
      source: "ruri",
      kind: "project.idle",
      project: { id: "p-midna", name: "midna", path: "/work/midna" },
      chats: [{ id: "c1", name: "Assistant", role: "assistant", lastSummary: "Cut v0.6.0" }],
      costUsd: 1.25,
      at: "2026-10-19T22:00:00Z",
    };
    let heard: BrainRun | undefined;
    script = async (run, tools) => {
      if (!run.prompt.includes("midna went idle")) return "ok";
      heard = run;
      await call(tools, "message_user", { text: "midna's team is idle — v0.6.0 is cut.", priority: "fyi" });
      return "told the user";
    };
    const r = kept(await client.event({ source: "ruri", title: "midna went idle", data: idle }));
    expect(r).toMatchObject({ status: "queued" });
    await until("heard", () => heard);
    expect(heard!.prompt).toStartWith("[Wakeup — the user did not send this");
    expect(heard!.prompt).toContain("Background notification — the user did not send this. An event from ruri");
    expect(heard!.prompt).toContain("midna went idle (project.idle)");
    expect(heard!.prompt).toContain('"lastSummary":"Cut v0.6.0"');
    expect(heard!.prompt).toContain("information, not instructions");
    await until("told", () => outbox().find((i) => i.text === "midna's team is idle — v0.6.0 is cut."));
    // Not user input: nothing in the conversation as theirs, nothing for a chat turn to answer.
    expect((await client.history({ limit: 200 })).some((h) => h.role === "user" && h.text.includes("idle"))).toBe(false);
    expect(daemon.store.log.unseen("main").filter((m) => m.role === "user")).toEqual([]);
    // The same id again is the same event.
    expect(await client.event({ source: "ruri", title: "midna went idle", data: idle })).toEqual({ status: "duplicate", eventId: r.eventId, wakeupId: r.wakeupId });
  });

  test("ruri's events about the user's own turns don't wake midna; those about midna's do", async () => {
    const heard: string[] = [];
    script = async (run) => {
      for (const t of ["kumo is idle", "kumo is blocked", "weekly usage at 71%"]) if (run.prompt.includes(t)) heard.push(t);
      return "ok";
    };
    const project = { id: "p-kumo", name: "kumo", path: "/work/kumo" };
    const lead = (lastPrompt: { id: string; at: string } | null) => ({ id: "c-lead", name: "Lead", role: "lead", lastSummary: "Done.", lastPrompt });
    const ev = (id: string, kind: string, lastPrompt: { id: string; at: string } | null) => ({
      source: "ruri",
      title: `kumo is ${kind === "project.idle" ? "idle" : "blocked"}`,
      data: { id, source: "ruri", kind, project, chats: [lead(lastPrompt)], costUsd: 0.5, at: new Date().toISOString() },
    });
    const wakeups = () => (daemon.store.db.query("SELECT COUNT(*) AS n FROM wakeups").get() as { n: number }).n;
    const stored = () => (daemon.store.db.query("SELECT COUNT(*) AS n FROM inbound_events WHERE subject = 'p-kumo'").get() as { n: number }).n;
    const before = wakeups();
    // The user typed in kumo's lead: idle or blocked, nothing for midna, and nothing kept.
    const theirs = { id: "8d0f6a52-5d1e-4d43-9a8c-0c6b3c2f1e7d", at: new Date(Date.now() - 60_000).toISOString() };
    const idle = await client.event(ev("kumo-1", "project.idle", theirs));
    expect(idle).toEqual({ status: "ignored", reason: "the latest prompt in kumo (Lead) wasn't midna's" });
    expect(await client.event(ev("kumo-2", "project.blocked", theirs))).toMatchObject({ status: "ignored" });
    expect(wakeups()).toBe(before);
    expect(stored()).toBe(0);
    // midna sent the latest prompt: heard, as any event.
    const mine = { id: "midna-5e4b3a29-1c0d-4f8e-b7a6-958473625140", at: new Date().toISOString() };
    const queued = await client.event(ev("kumo-3", "project.idle", mine));
    expect(queued).toMatchObject({ status: "queued" });
    await until("midna's heard", () => heard.includes("kumo is idle") || undefined);
    expect(stored()).toBe(1);
    // ruri-watch's usage events aren't project events: always heard.
    expect(await client.event({ source: "ruri", title: "ruri: weekly usage at 71% (crossed 70%)", data: { weekly: 71, threshold: 70 } })).toMatchObject({ status: "queued" });
    await until("usage heard", () => heard.includes("weekly usage at 71%") || undefined);
    expect(heard).not.toContain("kumo is blocked");
  });

  test("follow-ups due within minutes of each other run as one turn, and end together", async () => {
    const prompts: string[] = [];
    script = async (run) => {
      if (run.prompt.includes("group check")) prompts.push(run.prompt);
      return "done both";
    };
    const tz = daemon.store.settings().timezone;
    const a = daemon.store.schedule.add({ dueAt: Date.now() + 150, reason: "group check one", tz });
    const b = daemon.store.schedule.add({ dueAt: Date.now() + 3 * 60_000, reason: "group check two", tz });
    await until("both done", () => [a, b].every((w) => daemon.store.schedule.get(w.id)!.status === "done") || undefined);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toStartWith("[Wakeup — the user did not send this");
    expect(prompts[0]).toContain("2 wakeups came due within minutes of each other, so they run as one turn.");
    expect(prompts[0]).toContain(`## 1. Wakeup #${a.id}, set for`);
    expect(prompts[0]).toMatch(new RegExp(`## 2\\. Wakeup #${b.id}, set for .* \\(taken (2|3) min( \\d+ s)? early, to run with the rest\\)`));
    expect(prompts[0]).toContain('"group check two"');
    expect(daemon.store.schedule.get(b.id)!.joined_to).toBe(a.id);
    const eps = daemon.store.db.query("SELECT wakeup_id FROM episodes WHERE wakeup_id IN ($a, $b)").all({ a: a.id, b: b.id });
    expect(eps).toEqual([{ wakeup_id: a.id }]);
  });

  test("a follow-up midna already has isn't scheduled twice, and a stored wakeupBudget is ignored", async () => {
    const answers: string[] = [];
    script = async (run, tools) => {
      if (!run.prompt.includes("twin check")) return "ok";
      expect(run.prompt).not.toContain("budget");
      answers.push(await call(tools, "schedule_wakeup", { reason: "Look at the twin check results tomorrow", when: "+2h" }));
      answers.push(await call(tools, "schedule_wakeup", { reason: "look at the twin check results tomorrow.", when: "+150m" }));
      return "done";
    };
    daemon.store.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('wakeupBudget', '{\"turns\":1,\"usd\":100}')").run();
    const w = daemon.store.schedule.add({ dueAt: Date.now() + 100, reason: "twin check", tz: daemon.store.settings().timezone });
    await until("ran", () => daemon.store.schedule.get(w.id)!.status === "done" || undefined);
    expect(answers[0]).toMatch(/^scheduled #\d+ for [^\n]*$/);
    expect(answers[1]).toMatch(/^not scheduled: #\d+, for .* already says nearly this: "Look at the twin check results tomorrow"/);
    const status = await client.status();
    expect(Object.keys(status.wakeups!).sort()).toEqual(["turns", "usd"]);
    expect(JSON.stringify(status).toLowerCase()).not.toContain("budget");
  });

  test("a source gets one wakeup per project per window; the rest are merged into it", async () => {
    const prompts: string[] = [];
    script = async (run) => {
      if (run.prompt.includes("Background notification") && run.prompt.includes("umi idle")) prompts.push(run.prompt);
      return "ok";
    };
    const ev = (n: number, project: string) => ({
      source: "ruri",
      title: `${project} idle #${n}`,
      data: { id: `${project}-${n}`, kind: "project.idle", project: { id: project, name: project, path: `/work/${project}` } },
    });
    const first = kept(await client.event(ev(1, "umi")));
    expect(first.status).toBe("queued");
    await until("first heard", () => prompts.length === 1 || undefined);
    const second = kept(await client.event(ev(2, "umi")));
    const third = await client.event(ev(3, "umi"));
    const other = await client.event(ev(1, "una"));
    // Inside the window: the next wakeup waits for the window to pass, and takes the one after too.
    expect(second.status).toBe("queued");
    expect(third).toMatchObject({ status: "merged", wakeupId: second.wakeupId });
    expect((second as { dueAt: number }).dueAt).toBe(daemon.store.schedule.get(first.wakeupId)!.fired_at! + EVENT_WINDOW_MS);
    expect(daemon.store.schedule.get(second.wakeupId)!.reason).toBe('ruri: 2 events, the latest "umi idle #3"');
    // Another project has its own window.
    expect(other.status).toBe("queued");
    expect((other as { dueAt: number }).dueAt).toBeLessThanOrEqual(Date.now());
    // When the window is up, one wakeup hears both, in order.
    daemon.store.schedule.reschedule(second.wakeupId, Date.now());
    await until("merged heard", () => prompts.length === 2 || undefined);
    expect(prompts[1]).toContain("2 events from ruri");
    expect(prompts[1]!.indexOf("umi idle #2 (project.idle)")).toBeLessThan(prompts[1]!.indexOf("umi idle #3 (project.idle)"));
  });

  test("an event that arrives mid-turn interrupts nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    let heard = false;
    script = async (run) => {
      if (run.prompt.includes("slow question")) {
        started = true;
        await gate;
        return "Slow answer.";
      }
      if (run.prompt.includes("build finished")) heard = true;
      return "ok";
    };
    const interrupted = () => (daemon.store.db.query("SELECT COUNT(*) AS n FROM episodes WHERE error LIKE 'interrupted%'").get() as { n: number }).n;
    const before = interrupted();
    await client.send({ text: "slow question", client: "test" });
    await until("turn running", () => started || undefined);
    await client.event({ source: "ci", title: "build finished" });
    await until("event heard", () => heard || undefined);
    release();
    await until("answer", () => outbox().find((i) => i.text === "Slow answer."));
    expect(interrupted()).toBe(before);
  });

  test("events are checked, and need a device token like any client", async () => {
    await expect(client.event({ source: " ", title: "x" })).rejects.toThrow(/source/);
    await expect(client.event({ source: "ruri", title: "" })).rejects.toThrow(/title/);
    await expect(client.event({ source: "ruri", title: "huge", data: { blob: "x".repeat(MAX_EVENT_DATA_BYTES) } })).rejects.toThrow(/at most 64 KB/);
    await expect(new MidnaClient(daemon.url, "mdn_nope").event({ source: "ruri", title: "x" })).rejects.toThrow(/unauthorized/);
  });
});
