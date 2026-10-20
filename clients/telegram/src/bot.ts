/** The slice of the Telegram Bot API the bridge uses. Plain fetch, no library. */

export interface TgUser { id: number; username?: string; first_name?: string }
export interface TgChat { id: number; type: string }
export interface TgPhotoSize { file_id: string; width: number; height: number; file_size?: number }
/** A document, video, audio, voice note or animation: all a file with an id. */
export interface TgDocument { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  /** The same photo at several sizes, smallest first. */
  photo?: TgPhotoSize[];
  document?: TgDocument;
  video?: TgDocument;
  audio?: TgDocument;
  voice?: TgDocument;
  animation?: TgDocument;
  video_note?: TgDocument;
  reply_to_message?: { message_id: number };
}
export interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery }
export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

export class TelegramError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** The biggest photo the Bot API takes by upload; bigger images go as files. */
const PHOTO_MAX = 10 * 1024 * 1024;
/** The biggest file a bot can upload. */
export const UPLOAD_MAX = 50 * 1024 * 1024;
/** The biggest file a bot can download (getFile). */
export const DOWNLOAD_MAX = 20 * 1024 * 1024;
/** Image types Telegram shows as a photo. */
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Something to send: a file's bytes (as a photo when it can be, unless `asFile`), or an image on the web. */
export type Media = { data: Blob; name: string; mime: string; asFile?: boolean } | { url: string };

export class Bot {
  private readonly base: string;
  private readonly files: string;

  constructor(token: string, apiBase = process.env.TELEGRAM_API ?? "https://api.telegram.org") {
    this.base = `${apiBase.replace(/\/+$/, "")}/bot${token}`;
    this.files = `${apiBase.replace(/\/+$/, "")}/file/bot${token}`;
  }

  /** A Bot API call, as JSON — or as a form, when it carries a file. */
  async call<T>(method: string, params: Record<string, unknown> | FormData = {}, signal?: AbortSignal): Promise<T> {
    const form = params instanceof FormData;
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      ...(form ? {} : { headers: { "content-type": "application/json" } }),
      body: form ? params : JSON.stringify(params),
      ...(signal ? { signal } : {}),
    });
    const body = (await res.json().catch(() => ({ ok: false, description: res.statusText }))) as { ok: boolean; result?: T; description?: string; error_code?: number };
    if (!body.ok) throw new TelegramError(body.error_code ?? res.status, body.description ?? "telegram request failed");
    return body.result as T;
  }

  getMe() {
    return this.call<TgUser>("getMe");
  }

  getUpdates(offset: number | undefined, timeout: number, signal?: AbortSignal) {
    return this.call<TgUpdate[]>("getUpdates", { offset, timeout, allowed_updates: ["message", "callback_query"] }, signal);
  }

  /** Send text, as HTML when it converts cleanly, plain when Telegram refuses the markup. */
  async send(chatId: number, text: string, opts: { silent?: boolean; keyboard?: InlineKeyboard; replyTo?: number } = {}): Promise<TgMessage[]> {
    const sent: TgMessage[] = [];
    const chunks = chunk(text, 3900);
    for (const [i, part] of chunks.entries()) {
      const extra = {
        chat_id: chatId,
        disable_notification: !!opts.silent,
        link_preview_options: { is_disabled: true },
        ...(opts.keyboard && i === chunks.length - 1 ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
        ...(opts.replyTo && i === 0 ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
      };
      try {
        sent.push(await this.call<TgMessage>("sendMessage", { ...extra, text: toHtml(part), parse_mode: "HTML" }));
      } catch (err) {
        if (!(err instanceof TelegramError) || err.code !== 400) throw err;
        sent.push(await this.call<TgMessage>("sendMessage", { ...extra, text: part }));
      }
    }
    return sent;
  }

  /**
   * Send an image or a file, with an optional caption (Telegram allows 1024
   * characters). Images Telegram can show go as photos; anything else, or a
   * photo Telegram turns down (too big, odd proportions), goes as a file.
   */
  async sendMedia(chatId: number, media: Media, opts: { caption?: string; silent?: boolean; keyboard?: InlineKeyboard } = {}): Promise<TgMessage> {
    const photo = "url" in media || (!media.asFile && PHOTO_TYPES.has(media.mime) && media.data.size <= PHOTO_MAX);
    const send = async (method: "sendPhoto" | "sendDocument", html: boolean) => {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      if (opts.silent) form.set("disable_notification", "true");
      if (opts.keyboard) form.set("reply_markup", JSON.stringify({ inline_keyboard: opts.keyboard }));
      if (opts.caption) {
        form.set("caption", html ? toHtml(opts.caption) : opts.caption);
        if (html) form.set("parse_mode", "HTML");
      }
      const field = method === "sendPhoto" ? "photo" : "document";
      if ("url" in media) form.set(field, media.url);
      else form.set(field, media.data, media.name);
      return this.call<TgMessage>(method, form);
    };
    const attempt = async (method: "sendPhoto" | "sendDocument") => {
      try {
        return await send(method, true);
      } catch (err) {
        // Markup Telegram won't parse: the same caption, plain.
        if (!opts.caption || !(err instanceof TelegramError) || err.code !== 400 || !/pars|entit/i.test(err.message)) throw err;
        return send(method, false);
      }
    };
    if (!photo) return attempt("sendDocument");
    try {
      return await attempt("sendPhoto");
    } catch (err) {
      if (!(err instanceof TelegramError) || err.code !== 400) throw err;
      return attempt("sendDocument");
    }
  }

  getFile(fileId: string) {
    return this.call<{ file_id: string; file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
  }

  /** A file someone sent the bot (the Bot API hands over files up to DOWNLOAD_MAX). */
  async download(fileId: string): Promise<{ data: Uint8Array<ArrayBuffer>; path: string }> {
    const file = await this.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram didn't give a path for that file");
    const res = await fetch(`${this.files}/${file.file_path}`);
    if (!res.ok) throw new Error(`downloading from Telegram failed: ${res.status} ${res.statusText}`);
    return { data: new Uint8Array(await res.arrayBuffer()), path: file.file_path };
  }

  typing(chatId: number) {
    return this.call("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  answerCallback(id: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }

  clearKeyboard(chatId: number, messageId: number) {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  }

  setCommands(commands: Array<{ command: string; description: string }>) {
    return this.call("setMyCommands", { commands });
  }
}

/** Split on paragraph, then line, then hard boundaries. */
export function chunk(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** The little Markdown models write, as Telegram HTML. */
export function toHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const blocks = md.split(/```(?:[\w-]*)\n?([\s\S]*?)```/g);
  return blocks
    .map((b, i) => {
      if (i % 2 === 1) return `<pre>${esc(b.replace(/\n$/, ""))}</pre>`;
      return esc(b)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
        .replace(/!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, (_, alt: string, href: string) => `<a href="${href}">${alt || "image"}</a>`)
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
        .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
    })
    .join("");
}
