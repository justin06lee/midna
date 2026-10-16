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
  private updates: unknown[] = [];
  private nextUpdate = 1;
  private nextMessage = 100;
  private waiter: (() => void) | null = null;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/file/")) return new Response(PNG);
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
          return ok({ file_id: body.file_id, file_path: `photos/${body.file_id}.jpg` });
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

async function until<T>(what: string, fn: () => T | undefined | false, ms = 5_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
    const v = fn();
    if (v !== undefined && v !== false) return v as T;
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  tg = new FakeTelegram();
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
  bridge = new TelegramBridge(file);
  void bridge.run();
});

afterAll(async () => {
  bridge.stop();
  await daemon.stop();
  tg.server.stop(true);
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

  test("several images go first and the text after; web images go by URL", async () => {
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
    expect(order).toEqual(["sendPhoto", "sendPhoto", "sendPhoto", "sendMessage"]);
    expect(text.message_id).toBeGreaterThan(sent[2]!.message_id);
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
    expect(prompt).toMatch(/Attached image "photo-777\.jpg" \(image\/png\), saved at \S+photo-777\.jpg/);
    const history = await new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim()).history({ limit: 5 });
    const line = history.find((h) => h.role === "user" && h.text === "my receipt")!;
    expect(line.client).toBe("telegram");
    expect(line.attachments).toMatchObject([{ kind: "image", name: "photo-777.jpg", size: PNG.byteLength }]);
  });
});
