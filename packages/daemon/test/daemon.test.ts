import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MAX_ATTACHMENT_BYTES, MidnaClient, type OutboxItem, type StreamEvent } from "@midna/protocol";
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
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
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
});
