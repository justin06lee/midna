import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { MidnaClient, type OutboxItem, type StreamEvent } from "@midna/protocol";
import { Bot, type Media, type TgCallbackQuery, type TgMessage } from "./bot.ts";

/**
 * The Telegram bridge: the user's phone, until midna has its own app.
 *
 * It is an ordinary client of the midna API — it holds a device token like
 * the desktop app does, and nothing in midna knows Telegram exists. Exactly
 * one Telegram chat (the owner's, bound by a one-time /start code) can talk
 * to it; every other chat is ignored.
 */

export interface TelegramState {
  botToken: string;
  midna: { url: string; token: string };
  /** The one chat that is the user. Unset until /start <pairCode>. */
  ownerChatId?: number;
  pairCode?: string;
  /** Telegram update offset, so restarts don't replay messages. */
  updateOffset?: number;
  /** Last midna outbox position delivered, so restarts don't miss or repeat any. */
  lastSeq?: number;
  /** Telegram message id → midna question id, for replies and button taps. */
  questions?: Record<string, { id: number; options: string[] }>;
}

export function loadState(file: string): TelegramState {
  if (!existsSync(file)) throw new Error(`no Telegram bridge state at ${file} — run \`midna telegram setup\``);
  return JSON.parse(readFileSync(file, "utf8")) as TelegramState;
}

export function saveState(file: string, state: TelegramState): void {
  writeFileSync(file + ".tmp", JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
  chmodSync(file, 0o600);
}

const COMMANDS = [
  { command: "status", description: "What midna is doing, its mode and model" },
  { command: "pause", description: "Ask before acting (ask mode)" },
  { command: "resume", description: "Act autonomously again" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TelegramBridge {
  private state: TelegramState;
  private readonly bot: Bot;
  private readonly midna: MidnaClient;
  private readonly abort = new AbortController();
  private paired: Promise<void>;
  private markPaired!: () => void;
  private typingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly file: string, opts: { midnaUrl?: string } = {}) {
    this.state = loadState(file);
    this.bot = new Bot(this.state.botToken);
    this.midna = new MidnaClient(opts.midnaUrl ?? this.state.midna.url, this.state.midna.token);
    this.paired = new Promise((r) => (this.markPaired = r));
    if (this.state.ownerChatId) this.markPaired();
  }

  private save(): void {
    saveState(this.file, this.state);
  }

  async run(): Promise<void> {
    const me = await this.bot.getMe();
    await this.bot.setCommands(COMMANDS).catch(() => {});
    console.log(`telegram bridge up as @${me.username}${this.state.ownerChatId ? "" : " — waiting for /start <code>"}`);
    await Promise.all([this.pollTelegram(), this.followMidna()]);
  }

  stop(): void {
    this.abort.abort();
    this.stopTyping();
  }

  // ── Telegram → midna ─────────────────────────────────────────────────
  private async pollTelegram(): Promise<void> {
    let backoff = 1_000;
    while (!this.abort.signal.aborted) {
      try {
        const updates = await this.bot.getUpdates(this.state.updateOffset, 50, this.abort.signal);
        for (const u of updates) {
          this.state.updateOffset = u.update_id + 1;
          try {
            if (u.message) await this.onMessage(u.message);
            else if (u.callback_query) await this.onCallback(u.callback_query);
          } catch (err) {
            console.error("handling update failed:", (err as Error).message);
          }
        }
        if (updates.length) this.save();
        backoff = 1_000;
      } catch (err) {
        if (this.abort.signal.aborted) return;
        console.error(`telegram poll failed: ${(err as Error).message}; retrying in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async onMessage(m: TgMessage): Promise<void> {
    const text = (m.text ?? m.caption ?? "").trim();
    if (!this.state.ownerChatId) {
      const code = /^\/start\s+(\S+)/.exec(text)?.[1];
      if (code && this.state.pairCode && code.toUpperCase() === this.state.pairCode.toUpperCase()) {
        this.state.ownerChatId = m.chat.id;
        delete this.state.pairCode;
        this.save();
        console.log(`paired with Telegram chat ${m.chat.id}`);
        await this.bot.send(m.chat.id, "Paired. This chat is now your line to midna.");
        this.markPaired();
      }
      return;
    }
    if (m.chat.id !== this.state.ownerChatId) return;

    if (text === "/status") return this.reportStatus();
    if (text === "/pause" || text === "/resume") {
      const s = await this.midna.updateSettings({ mode: text === "/pause" ? "ask" : "autonomous" });
      await this.bot.send(m.chat.id, s.mode === "ask" ? "Paused: I'll ask before acting." : "Resumed: acting autonomously.");
      return;
    }
    if (text.startsWith("/start")) return;
    const file = await this.receiveFile(m);
    if (!text && !file) {
      await this.bot.send(m.chat.id, "I can only read text, photos and files here for now.");
      return;
    }
    const q = m.reply_to_message ? this.state.questions?.[String(m.reply_to_message.message_id)] : undefined;
    await this.midna.send({ text, client: "telegram", ...(q ? { replyTo: q.id } : {}), ...(file ? { attachments: [file] } : {}) });
  }

  /** A photo or file the user sent, put on midna's host; its attachment id. */
  private async receiveFile(m: TgMessage): Promise<string | null> {
    const photo = m.photo?.length ? m.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a)) : null;
    const doc = m.document;
    if (!photo && !doc) return null;
    try {
      const { data, path } = await this.bot.download((photo ?? doc)!.file_id);
      const name = doc?.file_name ?? (photo ? `photo-${m.message_id}.jpg` : path.split("/").pop()!);
      const mime = doc?.mime_type ?? (photo ? "image/jpeg" : "application/octet-stream");
      return (await this.midna.upload(data, { name, mime })).id;
    } catch (err) {
      console.error("receiving a file failed:", (err as Error).message);
      await this.bot.send(m.chat.id, `I couldn't take that file: ${(err as Error).message}`).catch(() => {});
      return null;
    }
  }

  private async onCallback(cb: TgCallbackQuery): Promise<void> {
    const msg = cb.message;
    if (!msg || msg.chat.id !== this.state.ownerChatId) return void (await this.bot.answerCallback(cb.id));
    const [, idx] = /^q:(\d+)$/.exec(cb.data ?? "") ?? [];
    const q = this.state.questions?.[String(msg.message_id)];
    const option = q && idx !== undefined ? q.options[Number(idx)] : undefined;
    if (!q || option === undefined) return void (await this.bot.answerCallback(cb.id, "That question has expired."));
    await this.midna.send({ text: option, client: "telegram", replyTo: q.id });
    await this.bot.answerCallback(cb.id, option);
    await this.bot.clearKeyboard(msg.chat.id, msg.message_id).catch(() => {});
    delete this.state.questions![String(msg.message_id)];
    this.save();
  }

  private async reportStatus(): Promise<void> {
    const s = await this.midna.status();
    await this.bot.send(
      this.state.ownerChatId!,
      `${s.name} ${s.version}\nmode: ${s.mode}\nmodel: ${s.model}\n${s.busy ? "working on something" : "idle"} · ${s.pendingWakeups} scheduled wakeup(s)`,
    );
  }

  // ── midna → Telegram ─────────────────────────────────────────────────
  private async followMidna(): Promise<void> {
    await this.paired;
    let backoff = 1_000;
    while (!this.abort.signal.aborted) {
      try {
        for await (const e of this.midna.events(this.state.lastSeq ?? 0, this.abort.signal)) {
          await this.onEvent(e);
          backoff = 1_000;
        }
      } catch (err) {
        if (this.abort.signal.aborted) return;
        console.error(`midna stream dropped: ${(err as Error).message}; reconnecting in ${backoff / 1000}s`);
      }
      this.stopTyping();
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  private async onEvent(e: StreamEvent): Promise<void> {
    const chat = this.state.ownerChatId!;
    if (e.type === "status") {
      if (e.state === "thinking") this.startTyping();
      else this.stopTyping();
    } else if (e.type === "outbox") {
      await this.deliver(chat, e.item);
      this.state.lastSeq = e.item.seq;
      this.save();
    }
  }

  /**
   * One outbox item, as Telegram shows it best: a lone image with a short
   * text is a photo with a caption; otherwise the images and files go first
   * and the text after, so a question's buttons stay at the bottom. Web
   * images in the Markdown (`![…](https://…)`) are sent as photos too.
   */
  private async deliver(chat: number, item: OutboxItem): Promise<void> {
    const prefix = item.priority === "urgent" && item.kind !== "message" ? "❗ " : "";
    const options = item.kind === "question" ? item.options ?? [] : [];
    const silent = item.priority === "fyi";
    const keyboard = options.length ? options.map((o, i) => [{ text: o, callback_data: `q:${i}` }]) : undefined;
    const { text, urls } = webImages(item.text);
    const body = text ? prefix + text : "";
    const media: Array<() => Promise<Media>> = [
      ...(item.attachments ?? []).map((a) => async () => ({ data: await this.midna.attachment(a.id), name: a.name, mime: a.mime })),
      ...urls.map((url) => async () => ({ url })),
    ];

    // The message that carries the text, and a question's buttons.
    let asked: TgMessage | undefined;
    if (media.length === 1 && body.length <= 1000) {
      asked = await media[0]!()
        .then((m) => this.bot.sendMedia(chat, m, { caption: body, silent, keyboard }))
        .catch((err) => void console.error(`sending an image with its caption failed: ${(err as Error).message}`));
      if (asked) media.length = 0;
    }
    for (const next of media) {
      await next()
        .then((m) => this.bot.sendMedia(chat, m, { silent }))
        .catch(async (err) => {
          // One that can't be sent shouldn't hold up the rest, nor the next item.
          console.error(`sending an attachment failed: ${(err as Error).message}`);
          await this.bot.send(chat, `(I couldn't send an attachment here: ${(err as Error).message})`, { silent: true }).catch(() => {});
        });
    }
    if (!asked && body) {
      const sent = await this.bot.send(chat, body, { silent, ...(keyboard ? { keyboard } : {}) });
      asked = sent[sent.length - 1];
    }
    if (item.kind === "question" && asked) {
      const questions = (this.state.questions ??= {});
      questions[String(asked.message_id)] = { id: item.id, options };
      // Keep the map small: only recent questions can still be answered by tap.
      const keys = Object.keys(questions);
      for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete questions[k];
    }
  }

  private startTyping(): void {
    if (this.typingTimer || !this.state.ownerChatId) return;
    const chat = this.state.ownerChatId;
    const ping = () => void this.bot.typing(chat).catch(() => {});
    ping();
    this.typingTimer = setInterval(ping, 4_500);
  }

  private stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }
}

/** Markdown images of web URLs, taken out of the text to be sent as photos. */
export function webImages(md: string): { text: string; urls: string[] } {
  const urls: string[] = [];
  const text = md.replace(/!\[[^\]\n]*\]\((https?:\/\/[^)\s]+)\)/g, (_, url: string) => (urls.push(url), ""));
  return { text: urls.length ? text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : md, urls };
}

/**
 * Connect a bot to midna: check the bot token, pair the bridge as a device,
 * and leave a one-time code for the user to send the bot as /start <code>.
 */
export async function setupTelegram(opts: { botToken: string; midnaUrl: string; pairingCode: string; deviceName: string; file: string }) {
  const bot = new Bot(opts.botToken);
  const me = await bot.getMe();
  const midna = new MidnaClient(opts.midnaUrl);
  const { token } = await midna.pair({ code: opts.pairingCode, deviceName: opts.deviceName, kind: "bridge" });
  const pairCode = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => "23456789ABCDEFGHJKMNPQRSTUVWXYZ"[b % 31]).join("");
  const previous = existsSync(opts.file) ? loadState(opts.file) : undefined;
  saveState(opts.file, {
    botToken: opts.botToken,
    midna: { url: opts.midnaUrl, token },
    pairCode,
    ...(previous?.botToken === opts.botToken && previous.updateOffset ? { updateOffset: previous.updateOffset } : {}),
  });
  return { username: me.username ?? "", pairCode };
}
