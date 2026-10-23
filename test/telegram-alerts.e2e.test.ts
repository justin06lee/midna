import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MidnaClient } from "@midna/protocol";
import type { Brain } from "@midna/agent";
import { startDaemon, type RunningDaemon } from "@midna/daemon";
import { ALERTS_NOTICE, TelegramBridge, bridgeMode, isAlert, loadState, setupTelegram } from "@midna/telegram";

/** A small fake Telegram Bot API: what the bot sends, and the updates to poll. */
class FakeTelegram {
  sent: Array<{ chat_id: number; text: string; message_id: number; reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }> = [];
  calls: string[] = [];
  private updates: unknown[] = [];
  private nextUpdate = 1;
  private nextMessage = 100;
  private waiter: (() => void) | null = null;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/file/")) return new Response(new Uint8Array([1, 2, 3]));
      const method = path.split("/").pop()!;
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      this.calls.push(method);
      const ok = (result: unknown) => Response.json({ ok: true, result });
      if (method === "getMe") return ok({ id: 1, username: "midna_test_bot", first_name: "midna" });
      if (method === "getFile") return ok({ file_id: body.file_id, file_path: `files/${body.file_id}` });
      if (method === "getUpdates") {
        const offset = (body.offset as number | undefined) ?? 0;
        const pending = () => this.updates.filter((u) => (u as { update_id: number }).update_id >= offset);
        if (!pending().length) await Promise.race([new Promise<void>((r) => (this.waiter = r)), Bun.sleep(300)]);
        return ok(pending());
      }
      if (method === "sendMessage") {
        const msg = { ...(body as never as FakeTelegram["sent"][number]), message_id: this.nextMessage++ };
        this.sent.push(msg);
        return ok({ message_id: msg.message_id, chat: { id: msg.chat_id, type: "private" }, text: msg.text });
      }
      return ok(true);
    },
  });
  get url() {
    return `http://127.0.0.1:${this.server.port}`;
  }
  push(update: Record<string, unknown>): void {
    this.updates.push({ update_id: this.nextUpdate++, ...update });
    this.waiter?.();
  }
  say(chat: number, extra: Record<string, unknown>): void {
    this.push({ message: { message_id: this.nextMessage++, chat: { id: chat, type: "private" }, from: { id: chat }, ...extra } });
  }
  tap(chat: number, messageId: number, data: string): void {
    this.push({ callback_query: { id: `cb${this.nextUpdate}`, from: { id: chat }, data, message: { message_id: messageId, chat: { id: chat, type: "private" } } } });
  }
  texts(): string[] {
    return this.sent.map((m) => m.text);
  }
}

const OWNER = 42;
const brain: Brain = async () => ({ text: "", sessionId: "s" });
const quiet = async () => void (await Bun.sleep(400));

let home: string;
let file: string;
let daemon: RunningDaemon;
let host: MidnaClient;
let tg: FakeTelegram;
let bridge: TelegramBridge;

async function until<T>(what: string, fn: () => T | undefined | false, ms = 5_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
    const v = fn();
    if (v !== undefined && v !== false) return v as T;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Start a bridge in a mode on the paired state file, as the daemon would after a restart. */
function startBridge(mode?: string): void {
  bridge = new TelegramBridge(file, { ...(mode ? { mode } : {}), una: { url: "http://127.0.0.1:9", timeoutMs: 500 } });
  void bridge.run();
}

beforeAll(async () => {
  tg = new FakeTelegram();
  process.env.TELEGRAM_API = tg.url;
  home = mkdtempSync(join(tmpdir(), "midna-tga-"));
  daemon = await startDaemon({ home, port: 17000 + Math.floor(Math.random() * 20000), brain, tickMs: 50, introDelayMs: 0 });
  daemon.store.updateSettings({ quietHours: null });
  host = new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim());
  file = join(home, "telegram.json");
  const { pairCode } = await setupTelegram({ botToken: "123:abc", midnaUrl: daemon.url, pairingCode: (await host.pairingCode()).code, deviceName: "Telegram bridge", file });
  startBridge();
  tg.say(OWNER, { text: `/start ${pairCode}` });
  await until("paired", () => tg.sent.find((m) => m.text.startsWith("Paired")));
});

afterAll(async () => {
  bridge.stop();
  await daemon.stop();
  tg.server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

const say = (kind: "message" | "notification" | "question", text: string, priority: "urgent" | "normal" | "fyi", client = kind as string, options?: string[]) =>
  daemon.store.say({ kind, text, priority, conversationId: "main", ...(options ? { options } : {}) }, { client, seenByBrain: true });

describe("bridge mode", () => {
  test("a value that isn't a mode falls back to full, and says so", () => {
    expect(bridgeMode(undefined)).toBe("full");
    expect(bridgeMode("full")).toBe("full");
    expect(bridgeMode("alerts")).toBe("alerts");
    expect(bridgeMode("alert")).toBe("full");
    expect(isAlert({ kind: "message", priority: "normal" })).toBe(false);
  });

  test("full delivers every kind and priority, as before", async () => {
    expect(bridge.mode).toBe("full");
    say("message", "chat reply", "normal", "chat");
    say("message", "quiet reply", "fyi", "chat");
    say("notification", "quiet note", "fyi");
    say("notification", "⏰ stand up", "urgent", "reminder");
    await until("all four", () => ["chat reply", "quiet reply", "quiet note", "stand up"].every((t) => tg.texts().some((x) => x.includes(t))));
    expect(tg.texts()).not.toContain(ALERTS_NOTICE);
  });

  test("a restart in alerts mode delivers only alerts, with their buttons", async () => {
    bridge.stop();
    await Bun.sleep(400);
    startBridge("alerts");
    expect(bridge.mode).toBe("alerts");
    tg.sent.length = 0;
    say("message", "blocked chat reply", "normal", "chat");
    say("message", "blocked urgent reply", "urgent", "chat");
    say("notification", "blocked fyi note", "fyi");
    say("question", "blocked fyi question", "fyi", "question", ["a", "b"]);
    say("notification", "⏰ allowed reminder", "urgent", "reminder");
    say("notification", "allowed normal note", "normal");
    say("notification", "allowed urgent note", "urgent");
    const q = say("question", "allowed question", "normal", "question", ["Mornings", "Evenings"]);
    await until("the allowed ones", () => ["allowed reminder", "allowed normal note", "allowed urgent note", "allowed question"].every((t) => tg.texts().some((x) => x.includes(t))));
    await quiet();
    expect(tg.texts().filter((t) => t.includes("blocked"))).toEqual([]);
    const card = tg.sent.find((m) => m.text === "allowed question")!;
    expect(card.reply_markup!.inline_keyboard.flat().map((b) => b.text)).toEqual(["Mornings", "Evenings"]);

    // Tapping a button still answers midna, and Telegram says nothing back.
    tg.sent.length = 0;
    tg.tap(OWNER, card.message_id, "q:1");
    for (const end = Date.now() + 5_000; Date.now() < end; await Bun.sleep(50)) {
      if ((await host.history({ limit: 5 })).some((h) => h.role === "user" && h.text === "Evenings" && h.client === "telegram" && h.replyTo === q.id)) break;
    }
    const answer = (await host.history({ limit: 5 })).find((h) => h.role === "user" && h.text === "Evenings");
    expect(answer).toMatchObject({ client: "telegram", replyTo: q.id });
    await quiet();
    expect(tg.texts()).toEqual([]);
    expect(tg.calls).toContain("answerCallbackQuery");
  });

  test("what the owner writes still reaches midna, and is answered once a day, a photo or a voice note too", async () => {
    tg.sent.length = 0;
    tg.say(OWNER, { text: "are you there?" });
    await until("the notice", () => tg.texts().includes(ALERTS_NOTICE));
    tg.say(OWNER, { photo: [{ file_id: "p1", width: 2, height: 2, file_size: 3 }], caption: "a photo" });
    tg.say(OWNER, { voice: { file_id: "v1", file_unique_id: "v1", duration: 3, file_size: 3 } });
    tg.say(OWNER, { text: "one more" });
    for (const end = Date.now() + 5_000; Date.now() < end; await Bun.sleep(50)) {
      const mine = (await host.history({ limit: 20 })).filter((h) => h.role === "user" && h.client === "telegram").map((h) => h.text);
      if (["are you there?", "a photo", "one more"].every((t) => mine.some((m) => m.startsWith(t))) && mine.some((m) => m.includes("voice note"))) break;
    }
    const mine = (await host.history({ limit: 20 })).filter((h) => h.role === "user" && h.client === "telegram").map((h) => h.text);
    expect(mine.some((m) => m.startsWith("are you there?"))).toBe(true);
    expect(mine.some((m) => m.startsWith("a photo"))).toBe(true);
    expect(mine.some((m) => m.includes("voice note"))).toBe(true);
    expect(mine.some((m) => m.startsWith("one more"))).toBe(true);
    await quiet();
    expect(tg.texts().filter((t) => t === ALERTS_NOTICE)).toHaveLength(1);
  });

  test("the once-a-day notice survives a restart, and comes again the next day", async () => {
    expect(loadState(file).alertsNoticeDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    bridge.stop();
    await Bun.sleep(400);
    startBridge("alerts");
    tg.sent.length = 0;
    tg.say(OWNER, { text: "after the restart" });
    await quiet();
    expect(tg.texts()).toEqual([]);

    // A new day: the stored day is yesterday's.
    const state = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...state, alertsNoticeDay: "2000-01-01" }));
    bridge.stop();
    await Bun.sleep(400);
    startBridge("alerts");
    tg.say(OWNER, { text: "the next day" });
    await until("the notice again", () => tg.texts().includes(ALERTS_NOTICE));
    expect(tg.texts().filter((t) => t === ALERTS_NOTICE)).toHaveLength(1);
  });

  test("back in full mode nothing is filtered and nobody is told anything", async () => {
    bridge.stop();
    await Bun.sleep(400);
    startBridge("full");
    tg.sent.length = 0;
    say("message", "chat reply again", "fyi", "chat");
    await until("the reply", () => tg.texts().some((t) => t.includes("chat reply again")));
    tg.say(OWNER, { text: "hello in full" });
    await quiet();
    expect(tg.texts()).not.toContain(ALERTS_NOTICE);
  });
});
