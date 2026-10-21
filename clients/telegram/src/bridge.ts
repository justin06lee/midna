import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { APPROVAL_OPTIONS, MidnaClient, MidnaError, type Approval, type OutboxItem, type StreamEvent } from "@midna/protocol";
import { Bot, DOWNLOAD_MAX, UPLOAD_MAX, type InlineKeyboard, type Media, type TgCallbackQuery, type TgMessage } from "./bot.ts";
import { marker, transcribe } from "./voice.ts";

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
  /**
   * Telegram message id → the midna line it is (midna's by outbox id, the
   * user's by message id), so a reply to it names that line. The newest
   * LINES_KEPT; an older one is described from what Telegram sends.
   */
  lines?: Record<string, Line>;
}

/** A line of the conversation, as a Telegram message stands for it. */
export type Line = { outbox: number } | { message: number };

const LINES_KEPT = 2_000;

/** A file the owner sent, on midna's host now: its attachment id, and its bytes. */
interface Received {
  id: string;
  data: Uint8Array<ArrayBuffer>;
  mime: string;
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
  { command: "queue", description: "Send without interrupting what midna is doing" },
  { command: "status", description: "What midna is doing, its mode and model" },
  { command: "pause", description: "Ask before acting (ask mode)" },
  { command: "resume", description: "Act autonomously again" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** /queue with nothing after it — what tapping it in the command menu sends. */
const BARE_QUEUE = /^\/queue(?:@\w+)?$/i;

export class TelegramBridge {
  private state: TelegramState;
  private readonly bot: Bot;
  private readonly midna: MidnaClient;
  private readonly abort = new AbortController();
  private paired: Promise<void>;
  private markPaired!: () => void;
  private typingTimer: ReturnType<typeof setInterval> | null = null;

  /** Where una is and how long it gets (tests point it at a fake). */
  private readonly una: { una?: string; timeoutMs?: number };

  constructor(private readonly file: string, opts: { midnaUrl?: string; una?: { url?: string; timeoutMs?: number } } = {}) {
    this.una = { ...(opts.una?.url ? { una: opts.una.url } : {}), ...(opts.una?.timeoutMs ? { timeoutMs: opts.una.timeoutMs } : {}) };
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
    if (!file && BARE_QUEUE.test(text)) {
      if (file === null) await this.bot.send(m.chat.id, "Write the message after it: /queue, then what to say. It waits until midna is done instead of interrupting.");
      return;
    }
    if (!text && !file) {
      // false: there was a file, and the user has been told why it didn't come through.
      if (file === null) await this.bot.send(m.chat.id, "I can only read text, photos and files here for now.");
      return;
    }
    const said = file ? await this.hear(m, file, text) : text;
    const q = m.reply_to_message ? this.state.questions?.[String(m.reply_to_message.message_id)] : undefined;
    await this.midna.send({ text: said, client: "telegram", ...(q ? { replyTo: q.id } : {}), ...(file ? { attachments: [file.id] } : {}) });
  }

  /**
   * A voice note, audio or video note, as words: its text (a caption, when
   * it had one) then what una heard, marked as such — or why it heard
   * nothing; the recording goes with the message either way.
   */
  private async hear(m: TgMessage, file: Received, text: string): Promise<string> {
    const rec = m.voice ?? m.video_note ?? m.audio;
    if (!rec) return text;
    const kind = m.voice ? "voice note" : m.video_note ? "video note" : "audio";
    const chat = m.chat.id;
    const typing = setInterval(() => void this.bot.typing(chat).catch(() => {}), 4_500);
    void this.bot.typing(chat).catch(() => {});
    try {
      const heard = await transcribe(file.data, { mime: file.mime, id: rec.file_unique_id ?? `${chat}-${m.message_id}` }, this.una);
      if (!heard.ok) console.error(`transcribing a ${kind} failed: ${heard.why}`);
      const words = heard.ok ? `${marker(kind, rec.duration, heard)} ${heard.text}` : marker(kind, rec.duration, heard);
      return text ? `${text}\n${words}` : words;
    } finally {
      clearInterval(typing);
    }
  }

  /**
   * A photo or file the user sent — a document of any type, a video, audio,
   * a voice note — put on midna's host: its attachment id and bytes, null
   * when there was none, false when there was one that couldn't come
   * through (and the user has been told why).
   */
  private async receiveFile(m: TgMessage): Promise<Received | null | false> {
    const photo = m.photo?.length ? m.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a)) : null;
    const file = m.document ?? m.video ?? m.audio ?? m.voice ?? m.animation ?? m.video_note;
    if (!photo && !file) return null;
    const fail = async (why: string) => {
      console.error("receiving a file failed:", why);
      await this.bot.send(m.chat.id, `I couldn't take that file: ${why}`).catch(() => {});
      return false as const;
    };
    const size = (photo ?? file)!.file_size ?? 0;
    if (size > DOWNLOAD_MAX) return fail(`it's ${Math.ceil(size / 1048576)} MB, and Telegram lets a bot fetch files up to ${DOWNLOAD_MAX / 1048576} MB. Send it from the midna app instead.`);
    try {
      const { data, path } = await this.bot.download((photo ?? file)!.file_id);
      const unnamed = m.voice ? `voice-${m.message_id}.ogg` : m.video_note || m.video ? `video-${m.message_id}.mp4` : path.split("/").pop()!;
      const name = file?.file_name ?? (photo ? `photo-${m.message_id}.jpg` : unnamed);
      const mime = file?.mime_type ?? (photo ? "image/jpeg" : m.voice ? "audio/ogg" : m.video_note ? "video/mp4" : "application/octet-stream");
      return { id: (await this.midna.upload(data, { name, mime })).id, data, mime };
    } catch (err) {
      return fail((err as Error).message);
    }
  }

  private async onCallback(cb: TgCallbackQuery): Promise<void> {
    const msg = cb.message;
    if (!msg || msg.chat.id !== this.state.ownerChatId) return void (await this.bot.answerCallback(cb.id));
    const [, idx] = /^q:(\d+)$/.exec(cb.data ?? "") ?? [];
    const q = this.state.questions?.[String(msg.message_id)];
    const option = q && idx !== undefined ? q.options[Number(idx)] : undefined;
    if (!q || option === undefined) return void (await this.bot.answerCallback(cb.id, "That question has expired."));
    try {
      // A device approval's button answers the approval itself; any other question's, as a reply.
      const answer = APPROVAL_OPTIONS.find((o) => o.label === option)?.answer;
      const approval = answer ? (await this.midna.approvals()).find((a) => a.outboxId === q.id) : undefined;
      if (answer && approval) await this.midna.answerApproval(approval.id, { answer, client: "telegram" });
      else await this.midna.send({ text: option, client: "telegram", replyTo: q.id });
    } catch (err) {
      // An approval's question, tapped after it was answered elsewhere or ran out of time.
      if (!(err instanceof MidnaError && err.status === 409)) throw err;
      await this.bot.answerCallback(cb.id, "That's already over: answered, timed out or dropped.");
      await this.bot.clearKeyboard(msg.chat.id, msg.message_id).catch(() => {});
      delete this.state.questions![String(msg.message_id)];
      this.save();
      return;
    }
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
    } else if (e.type === "approval" && e.approval.state !== "pending") {
      await this.approvalOver(chat, e.approval);
    }
  }

  /**
   * A device hands approval was answered, ran out of time or was dropped:
   * its question's buttons go, and unless it was answered here, a quiet
   * reply says how it ended.
   */
  private async approvalOver(chat: number, a: Approval): Promise<void> {
    const asked = Object.entries(this.state.questions ?? {}).filter(([, q]) => q.id === a.outboxId);
    if (!asked.length) return;
    for (const [messageId] of asked) {
      await this.bot.clearKeyboard(chat, Number(messageId)).catch(() => {});
      delete this.state.questions![messageId];
    }
    this.save();
    if (a.answeredVia === "telegram") return;
    const by = a.answeredBy ? ` by ${a.answeredBy}${a.answeredVia ? ` (${a.answeredVia})` : ""}` : "";
    const how =
      a.state === "allowed" ? `${a.answer === "allow_10_min" ? "Allowed for 10 min" : "Allowed"}${by}.`
      : a.state === "denied" ? `Denied${by}.`
      : a.state === "expired" ? "No answer in time, so no."
      : "No longer needed.";
    await this.bot.send(chat, how, { silent: true, replyTo: Number(asked[asked.length - 1]![0]) }).catch(() => {});
  }

  /**
   * One outbox item, in the order midna gave it: the text, then each
   * attachment in turn — a photo when Telegram can show it, a file when it
   * can't or midna sent it as one, each with its own caption — then web
   * images from the Markdown (`![…](https://…)`). A lone attachment with a
   * short text and no caption of its own is one captioned message. A
   * question puts its files first, so its buttons stay at the bottom.
   */
  private async deliver(chat: number, item: OutboxItem): Promise<void> {
    const prefix = item.priority === "urgent" && item.kind !== "message" ? "❗ " : "";
    const options = item.kind === "question" ? item.options ?? [] : [];
    const silent = item.priority === "fyi";
    const keyboard: InlineKeyboard | undefined = options.length ? options.map((o, i) => [{ text: o, callback_data: `q:${i}` }]) : undefined;
    const { text, urls } = webImages(item.text);
    const body = text ? prefix + text : "";
    type Part = { name: string; caption?: string; load: () => Promise<Media> };
    const parts: Part[] = [
      ...(item.attachments ?? []).map((a) => ({
        name: a.name,
        caption: a.caption ?? undefined,
        load: async (): Promise<Media> => {
          if (a.size > UPLOAD_MAX) throw new Error(`it's ${Math.ceil(a.size / 1048576)} MB, more than a Telegram bot can send (${UPLOAD_MAX / 1048576} MB) — it's in the midna app`);
          return { data: await this.midna.attachment(a.id), name: a.name, mime: a.mime, asFile: a.kind === "file" };
        },
      })),
      ...urls.map((url) => ({ name: url, load: async (): Promise<Media> => ({ url }) })),
    ];
    const line = { outbox: item.id };
    const send = (p: Part, opts: { caption?: string; keyboard?: InlineKeyboard } = {}) =>
      p.load().then(async (m) => {
        const sent = await this.bot.sendMedia(chat, m, { silent, caption: p.caption, ...opts });
        this.remember([sent], line);
        return sent;
      });

    // The message that carries the text, and a question's buttons.
    let carrier: TgMessage | undefined;
    let rest = parts;
    if (parts.length === 1 && !parts[0]!.caption && body.length <= 1000) {
      carrier = await send(parts[0]!, { caption: body, ...(keyboard ? { keyboard } : {}) }).catch((err) => void console.error(`sending ${parts[0]!.name} with its caption failed: ${(err as Error).message}`));
      if (carrier) rest = [];
    }
    const sendText = async () => {
      if (!body || carrier) return;
      const sent = await this.bot.send(chat, body, { silent, ...(keyboard ? { keyboard } : {}) });
      this.remember(sent, line);
      carrier = sent[sent.length - 1];
    };
    if (item.kind !== "question") await sendText();
    for (const p of rest) {
      await send(p).catch(async (err) => {
        // One that can't be sent shouldn't hold up the rest, nor the next item.
        console.error(`sending ${p.name} failed: ${(err as Error).message}`);
        await this.bot.send(chat, `(I couldn't send ${p.name} here: ${(err as Error).message})`, { silent: true }).catch(() => {});
      });
    }
    if (item.kind === "question") await sendText();
    if (item.kind === "question" && carrier) {
      const questions = (this.state.questions ??= {});
      questions[String(carrier.message_id)] = { id: item.id, options };
      // Keep the map small: only recent questions can still be answered by tap.
      const keys = Object.keys(questions);
      for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete questions[k];
    }
  }

  /** These Telegram messages are that line, for a reply to one of them later. */
  private remember(sent: TgMessage[], line: Line): void {
    const lines = (this.state.lines ??= {});
    for (const m of sent) lines[String(m.message_id)] = line;
    // Integer keys iterate in ascending order: the oldest go first.
    const keys = Object.keys(lines);
    for (const k of keys.slice(0, Math.max(0, keys.length - LINES_KEPT))) delete lines[k];
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
