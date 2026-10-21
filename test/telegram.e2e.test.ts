import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MidnaClient } from "@midna/protocol";
import type { Brain, BrainRun } from "@midna/agent";
import { startDaemon, type RunningDaemon } from "@midna/daemon";
import { TelegramBridge, setupTelegram, loadState } from "@midna/telegram";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

/** A fake Telegram Bot API: records what the bot sends, serves queued updates by long-poll, and files by path. */
class FakeTelegram {
  sent: Array<{ chat_id: number; text: string; parse_mode?: string; reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }; message_id: number }> = [];
  /** Photos and files the bot sent: a URL, or an uploaded file with its bytes. */
  media: Array<{ method: string; chat_id: number; caption?: string; parse_mode?: string; url?: string; name?: string; bytes?: Uint8Array; reply_markup?: string; message_id: number }> = [];
  calls: string[] = [];
  /** What getFile hands over, by file id; a PNG for any other. */
  files = new Map<string, Uint8Array>();
  private updates: unknown[] = [];
  private nextUpdate = 1;
  private nextMessage = 100;
  private waiter: (() => void) | null = null;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/file/")) return new Response(this.files.get(path.split("/").pop()!) ?? PNG);
      const method = path.split("/").pop()!;
      const multipart = req.headers.get("content-type")?.startsWith("multipart/form-data");
      const form = multipart ? await req.formData() : null;
      const body = form ? Object.fromEntries(form.entries()) : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
      this.calls.push(method);
      const ok = (result: unknown) => Response.json({ ok: true, result });
      switch (method) {
        case "getMe":
          return ok({ id: 1, username: "midna_test_bot", first_name: "midna" });
        case "getUpdates": {
          const offset = (body.offset as number | undefined) ?? 0;
          const pending = () => this.updates.filter((u) => (u as { update_id: number }).update_id >= offset);
          if (!pending().length) await Promise.race([new Promise<void>((r) => (this.waiter = r)), Bun.sleep(500)]);
          return ok(pending());
        }
        case "sendMessage": {
          const msg = { ...(body as never as FakeTelegram["sent"][number]), message_id: this.nextMessage++ };
          this.sent.push(msg);
          return ok({ message_id: msg.message_id, chat: { id: msg.chat_id, type: "private" }, text: msg.text });
        }
        case "sendPhoto":
        case "sendDocument": {
          const file = body.photo ?? body.document;
          const media = {
            method,
            chat_id: Number(body.chat_id),
            message_id: this.nextMessage++,
            ...(typeof body.caption === "string" ? { caption: body.caption, parse_mode: body.parse_mode as string } : {}),
            ...(typeof body.reply_markup === "string" ? { reply_markup: body.reply_markup } : {}),
            ...(typeof file === "string" ? { url: file } : { name: (file as File).name, bytes: new Uint8Array(await (file as File).arrayBuffer()) }),
          };
          this.media.push(media);
          return ok({ message_id: media.message_id, chat: { id: media.chat_id, type: "private" } });
        }
        case "getFile":
          return ok({ file_id: body.file_id, file_path: `files/${body.file_id}` });
        default:
          return ok(true);
      }
    },
  });

  get url() {
    return `http://127.0.0.1:${this.server.port}`;
  }

  push(update: Record<string, unknown>): void {
    this.updates.push({ update_id: this.nextUpdate++, ...update });
    this.waiter?.();
  }

  text(chatId: number, text: string, extra: Record<string, unknown> = {}): void {
    this.push({ message: { message_id: this.nextMessage++, chat: { id: chatId, type: "private" }, from: { id: chatId }, text, ...extra } });
  }

  tap(chatId: number, messageId: number, data: string): void {
    this.push({ callback_query: { id: `cb${this.nextUpdate}`, from: { id: chatId }, data, message: { message_id: messageId, chat: { id: chatId, type: "private" } } } });
  }
}

/** A fake una: POST /v1/dictations answers with `text`, or stalls, or refuses — and keeps what it was sent. */
class FakeUna {
  mode: "ok" | "slow" | "down" = "ok";
  text = "remind me to call mom at six";
  got: Array<{ name: string; type: string; bytes: number; fields: Record<string, string> }> = [];
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (new URL(req.url).pathname !== "/v1/dictations") return new Response("?", { status: 404 });
      const form = await req.formData();
      const audio = form.get("audio") as File;
      const fields = Object.fromEntries([...form.entries()].filter(([k]) => k !== "audio").map(([k, v]) => [k, String(v)]));
      this.got.push({ name: audio.name, type: audio.type, bytes: audio.size, fields });
      if (this.mode === "slow") await Bun.sleep(3_000);
      if (this.mode === "down") return Response.json({ detail: "ASR model unloaded (training in progress); retry shortly" }, { status: 503 });
      return Response.json({ id: "01J", text: this.text, raw_text: this.text, cleanup_applied: false, duration_ms: 42_000 });
    },
  });
  get url() {
    return `http://127.0.0.1:${this.server.port}`;
  }
}

const OWNER = 42;
const STRANGER = 99;
const runs: BrainRun[] = [];
let script: (run: BrainRun, tools: Client) => Promise<string> = async () => "ok";
const brain: Brain = async (run) => {
  runs.push(run);
  const tools = new Client({ name: "fake", version: "0" });
  await tools.connect(new StreamableHTTPClientTransport(new URL(run.mcp.url), { requestInit: { headers: { authorization: `Bearer ${run.mcp.token}` } } }));
  try {
    return { text: await script(run, tools), sessionId: `s${runs.length}` };
  } finally {
    await tools.close();
  }
};

let home: string;
let daemon: RunningDaemon;
let tg: FakeTelegram;
let bridge: TelegramBridge;
let pairCode: string;
let una: FakeUna;

async function until<T>(what: string, fn: () => T | undefined | false, ms = 5_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
    const v = fn();
    if (v !== undefined && v !== false) return v as T;
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  tg = new FakeTelegram();
  una = new FakeUna();
  process.env.TELEGRAM_API = tg.url;
  home = mkdtempSync(join(tmpdir(), "midna-tg-"));
  script = async (run, tools) => {
    if (run.prompt.includes("First run")) await tools.callTool({ name: "message_user", arguments: { text: "Hi, I'm midna.", priority: "urgent" } });
    return "";
  };
  daemon = await startDaemon({ home, port: 17000 + Math.floor(Math.random() * 20000), brain, tickMs: 50, introDelayMs: 0 });
  daemon.store.updateSettings({ quietHours: null });
  const host = new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim());
  const { code } = await host.pairingCode();
  const file = join(home, "telegram.json");
  ({ pairCode } = await setupTelegram({ botToken: "123:abc", midnaUrl: daemon.url, pairingCode: code, deviceName: "Telegram bridge", file }));
  bridge = new TelegramBridge(file, { una: { url: una.url, timeoutMs: 1_000 } });
  void bridge.run();
});

afterAll(async () => {
  bridge.stop();
  await daemon.stop();
  tg.server.stop(true);
  una.server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

describe("telegram bridge", () => {
  test("ignores everyone until the owner sends the one-time code", async () => {
    tg.text(STRANGER, "/start WRONGCODE");
    tg.text(STRANGER, "hello?");
    await Bun.sleep(300);
    expect(tg.sent).toEqual([]);
    tg.text(OWNER, `/start ${pairCode.toLowerCase()}`);
    await until("paired reply", () => tg.sent.find((m) => m.chat_id === OWNER && m.text.startsWith("Paired")));
    // The introduction midna sent before pairing is delivered right after it.
    await until("intro", () => tg.sent.find((m) => m.text === "❗ Hi, I&#x27;m midna." || m.text.includes("Hi, I'm midna.")));
    expect(loadState(join(home, "telegram.json")).ownerChatId).toBe(OWNER);
  });

  test("owner messages reach midna; Markdown replies arrive as HTML", async () => {
    script = async (run) => {
      expect(run.prompt).toContain("via telegram");
      return "**Hello** back — see `notes`";
    };
    tg.text(OWNER, "hello");
    const reply = await until("reply", () => tg.sent.find((m) => m.text.includes("Hello")));
    expect(reply.parse_mode).toBe("HTML");
    expect(reply.text).toBe("<b>Hello</b> back — see <code>notes</code>");
    expect(tg.calls).toContain("sendChatAction");
  });

  test("strangers stay ignored after pairing", async () => {
    const before = runs.length;
    tg.text(STRANGER, "give me your files");
    await Bun.sleep(300);
    expect(runs.length).toBe(before);
  });

  test("questions become buttons, and a tap answers the right question", async () => {
    script = async (run, tools) => {
      if (run.prompt.includes("plan my week")) {
        await tools.callTool({ name: "ask_user", arguments: { question: "Gym mornings or evenings?", options: ["Mornings", "Evenings"] } });
        return "";
      }
      expect(run.prompt).toContain('answering your question: "Gym mornings or evenings?"');
      expect(run.prompt).toContain("Evenings");
      return "Evenings, noted.";
    };
    tg.text(OWNER, "plan my week");
    const q = await until("question", () => tg.sent.find((m) => m.text === "Gym mornings or evenings?"));
    expect(q.reply_markup!.inline_keyboard.flat().map((b) => b.text)).toEqual(["Mornings", "Evenings"]);
    tg.tap(OWNER, q.message_id, "q:1");
    await until("answer", () => tg.sent.find((m) => m.text === "Evenings, noted."));
    expect(tg.calls).toContain("answerCallbackQuery");
  });

  test("/pause and /resume switch the mode", async () => {
    tg.text(OWNER, "/pause");
    await until("paused", () => tg.sent.find((m) => m.text.startsWith("Paused")));
    expect(daemon.store.settings().mode).toBe("ask");
    tg.text(OWNER, "/resume");
    await until("resumed", () => tg.sent.find((m) => m.text.startsWith("Resumed")));
    expect(daemon.store.settings().mode).toBe("autonomous");
  });
  test("an image midna attaches arrives as a photo, captioned with the reply", async () => {
    const chart = join(home, "workspace", "chart.png");
    writeFileSync(chart, PNG);
    script = async (run, tools) => {
      if (run.prompt.includes("the chart")) await tools.callTool({ name: "attach", arguments: { files: [chart] } });
      return "**The** chart";
    };
    tg.text(OWNER, "send me the chart");
    const photo = await until("photo", () => tg.media.find((m) => m.caption?.includes("chart")));
    expect(photo).toMatchObject({ method: "sendPhoto", chat_id: OWNER, caption: "<b>The</b> chart", parse_mode: "HTML", name: "chart.png" });
    expect(photo.bytes).toEqual(PNG);
    expect(tg.sent.some((m) => m.text.includes("chart"))).toBe(false);
  });

  test("the text comes first, then the attachments in order, then web images by URL", async () => {
    const chart = join(home, "workspace", "chart.png");
    script = async (run, tools) => {
      if (run.prompt.includes("both")) await tools.callTool({ name: "attach", arguments: { files: [chart, chart] } });
      return "Both, and the map:\n![map](https://example.com/map.png)";
    };
    const before = tg.media.length;
    const callsBefore = tg.calls.length;
    tg.text(OWNER, "both please");
    const text = await until("text", () => tg.sent.find((m) => m.text === "Both, and the map:"));
    const sent = tg.media.slice(before);
    expect(sent.map((m) => m.url ?? m.name)).toEqual(["chart.png", "chart.png", "https://example.com/map.png"]);
    const order = tg.calls.slice(callsBefore).filter((c) => c === "sendPhoto" || c === "sendMessage");
    expect(order).toEqual(["sendMessage", "sendPhoto", "sendPhoto", "sendPhoto"]);
    expect(text.message_id).toBeLessThan(sent[0]!.message_id);
  });

  test("photos the owner sends reach midna, the largest size, with the caption", async () => {
    let prompt = "";
    script = async (run) => {
      prompt = run.prompt;
      return "Nice receipt.";
    };
    tg.push({
      message: {
        message_id: 777,
        chat: { id: OWNER, type: "private" },
        from: { id: OWNER },
        caption: "my receipt",
        photo: [
          { file_id: "small", width: 90, height: 90 },
          { file_id: "big", width: 1280, height: 960 },
        ],
      },
    });
    await until("reply", () => tg.sent.find((m) => m.text === "Nice receipt."));
    expect(prompt).toContain("my receipt");
    expect(prompt).toMatch(/Attached image "photo-777\.png" \(image\/png, 1 KB\), saved at `[^`]+\/photo-777\.png`/);
    const history = await new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim()).history({ limit: 5 });
    const line = history.find((h) => h.role === "user" && h.text === "my receipt")!;
    expect(line.client).toBe("telegram");
    expect(line.attachments).toMatchObject([{ kind: "image", name: "photo-777.png", size: PNG.byteLength }]);
  });
  test("files of any type go as documents, in midna's order, each with its own caption", async () => {
    const dir = join(home, "workspace");
    writeFileSync(join(dir, "report.pdf"), "%PDF-1.7 the plan");
    writeFileSync(join(dir, "results.zip"), "PK\u0003\u0004 results");
    script = async (run, tools) => {
      if (run.prompt.includes("the pack"))
        await tools.callTool({
          name: "message_user",
          arguments: { text: "The pack", attachments: [{ file: join(dir, "report.pdf"), caption: "the plan" }, { file: join(dir, "chart.png"), as: "file" }, join(dir, "results.zip")] },
        });
      return "";
    };
    const before = tg.media.length;
    const callsBefore = tg.calls.length;
    tg.text(OWNER, "send me the pack");
    await until("three files", () => tg.media.length >= before + 3 || undefined);
    const sent = tg.media.slice(before);
    expect(sent.map((m) => [m.method, m.name, m.caption ?? null])).toEqual([
      ["sendDocument", "report.pdf", "the plan"],
      ["sendDocument", "chart.png", null],
      ["sendDocument", "results.zip", null],
    ]);
    expect(new TextDecoder().decode(sent[2]!.bytes)).toBe("PK\u0003\u0004 results");
    const order = tg.calls.slice(callsBefore).filter((c) => c.startsWith("send") && c !== "sendChatAction");
    expect(order).toEqual(["sendMessage", "sendDocument", "sendDocument", "sendDocument"]);
    expect(tg.sent.findLast((m) => m.text === "The pack")!.message_id).toBeLessThan(sent[0]!.message_id);
  });

  test("a question's files come first, so its buttons stay last", async () => {
    const dir = join(home, "workspace");
    script = async (run, tools) => {
      if (run.prompt.includes("which version"))
        await tools.callTool({ name: "ask_user", arguments: { question: "Which version ships?", options: ["Chart", "Report"], attachments: [join(dir, "chart.png"), join(dir, "report.pdf")] } });
      return "";
    };
    const before = tg.media.length;
    tg.text(OWNER, "which version?");
    const q = await until("question", () => tg.sent.find((m) => m.text === "Which version ships?"));
    expect(tg.media.slice(before).map((m) => [m.method, m.name])).toEqual([
      ["sendPhoto", "chart.png"],
      ["sendDocument", "report.pdf"],
    ]);
    expect(q.message_id).toBeGreaterThan(tg.media[before + 1]!.message_id);
    expect(q.reply_markup!.inline_keyboard.flat().map((b) => b.text)).toEqual(["Chart", "Report"]);
  });

  test("documents, voice notes and other files the owner sends arrive as attachments", async () => {
    let prompt = "";
    script = async (run) => {
      prompt = run.prompt;
      return "Got them.";
    };
    tg.files.set("doc1", new TextEncoder().encode("PK\u0003\u0004 notes"));
    tg.files.set("voice1", new TextEncoder().encode("OggS voice"));
    const msg = (id: number, extra: Record<string, unknown>) => ({ message: { message_id: id, chat: { id: OWNER, type: "private" }, from: { id: OWNER }, ...extra } });
    tg.push(msg(901, { caption: "my notes", document: { file_id: "doc1", file_name: "notes.zip", mime_type: "application/zip", file_size: 14 } }));
    await until("reply", () => tg.sent.find((m) => m.text === "Got them."));
    expect(prompt).toContain('Attached file "notes.zip" (application/zip, 1 KB)');
    const sentBefore = tg.sent.length;
    tg.push(msg(902, { voice: { file_id: "voice1", mime_type: "audio/ogg", file_size: 10 } }));
    await until("second reply", () => tg.sent.slice(sentBefore).find((m) => m.text === "Got them."));
    expect(prompt).toContain('Attached file "voice-902.ogg" (audio/ogg, 1 KB)');
    const history = await new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim()).history({ limit: 6 });
    expect(history.filter((h) => h.role === "user" && h.attachments.length).slice(-2).map((h) => [h.text, h.attachments[0]!.name, h.attachments[0]!.mime])).toEqual([
      ["my notes", "notes.zip", "application/zip"],
      ["[voice note, transcribed by una] remind me to call mom at six", "voice-902.ogg", "audio/ogg"],
    ]);

    // Past what a bot may fetch: the owner is told, and nothing reaches midna.
    const runsBefore = runs.length;
    tg.push(msg(903, { document: { file_id: "big1", file_name: "video.mov", file_size: 30 * 1024 * 1024 } }));
    await until("too big", () => tg.sent.find((m) => m.text.includes("30 MB")));
    await Bun.sleep(200);
    expect(runs.length).toBe(runsBefore);
  });
  test("a voice note reaches midna as una's words, marked as such, with the recording", async () => {
    let prompt = "";
    script = async (run) => {
      prompt = run.prompt;
      return "Will do.";
    };
    una.mode = "ok";
    una.got = [];
    tg.files.set("voice2", new TextEncoder().encode("OggS a voice note"));
    const sentBefore = tg.sent.length;
    tg.push({ message: { message_id: 911, chat: { id: OWNER, type: "private" }, from: { id: OWNER }, voice: { file_id: "voice2", file_unique_id: "AgADvoice2", duration: 42, mime_type: "audio/ogg", file_size: 17 } } });
    await until("reply", () => tg.sent.slice(sentBefore).find((m) => m.text === "Will do."));
    expect(prompt).toContain("User: [voice note 0:42, transcribed by una] remind me to call mom at six");
    expect(prompt).toContain('Attached file "voice-911.ogg" (audio/ogg, 1 KB)');
    // una got the recording as it is, known by Telegram's stable id so a retry isn't transcribed twice.
    expect(una.got).toEqual([{ name: "voice.ogg", type: "audio/ogg", bytes: 17, fields: { client: "midna", app_name: "midna (Telegram)", utterance_id: "midna-telegram-AgADvoice2" } }]);
    // While una listens, the owner sees midna typing.
    expect(tg.calls).toContain("sendChatAction");
  });

  test("when una is slow or down, the note still reaches midna, saying why it has no words", async () => {
    const prompts: string[] = [];
    script = async (run) => {
      prompts.push(run.prompt);
      return "Heard it.";
    };
    tg.files.set("voice3", new TextEncoder().encode("OggS another"));
    const note = (id: number) => ({ message: { message_id: id, chat: { id: OWNER, type: "private" }, from: { id: OWNER }, voice: { file_id: "voice3", file_unique_id: `AgAD${id}`, duration: 5, mime_type: "audio/ogg", file_size: 12 } } });
    una.mode = "slow";
    let sentBefore = tg.sent.length;
    tg.push(note(912));
    await until("reply to the slow one", () => tg.sent.slice(sentBefore).find((m) => m.text === "Heard it."), 8_000);
    expect(prompts.at(-1)).toContain("User: [voice note 0:05, not transcribed: una didn't answer within 1 s]");
    expect(prompts.at(-1)).toContain('Attached file "voice-912.ogg"');
    una.mode = "down";
    sentBefore = tg.sent.length;
    tg.push(note(913));
    await until("reply to the refused one", () => tg.sent.slice(sentBefore).find((m) => m.text === "Heard it."));
    expect(prompts.at(-1)).toContain("User: [voice note 0:05, not transcribed: una said 503: ASR model unloaded (training in progress); retry shortly]");
    una.mode = "ok";
  });

  test("a caption stays the owner's words, with what una heard after it", async () => {
    let prompt = "";
    script = async (run) => {
      prompt = run.prompt;
      return "Okay.";
    };
    tg.files.set("audio1", new TextEncoder().encode("ID3 an mp3"));
    const sentBefore = tg.sent.length;
    tg.push({ message: { message_id: 914, chat: { id: OWNER, type: "private" }, from: { id: OWNER }, caption: "from the meeting", audio: { file_id: "audio1", file_unique_id: "AgADaudio1", file_name: "meeting.mp3", duration: 190, mime_type: "audio/mpeg", file_size: 10 } } });
    await until("reply", () => tg.sent.slice(sentBefore).find((m) => m.text === "Okay."));
    expect(prompt).toContain("User: from the meeting\n[audio 3:10, transcribed by una] remind me to call mom at six");
  });
});
