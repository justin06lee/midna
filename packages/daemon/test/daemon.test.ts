import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MidnaClient, type OutboxItem, type StreamEvent } from "@midna/protocol";
import type { Brain, BrainRun } from "@midna/agent";
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
  const tools = await mcp(run);
  try {
    const text = await script(run, tools);
    return { text, sessionId: `session-${runs.length}`, costUsd: 0.01 };
  } finally {
    await tools.close();
  }
};

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
      expect(run.systemPrompt).toContain("Run a marathon"); // context is rendered fresh
      return "Done stretching? Good.";
    };
    await client.send({ text: "stretched", client: "test" });
    await until("second reply", () => outbox().find((i) => i.text === "Done stretching? Good."));
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
      if (run.prompt.includes("check the oven")) {
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
});
