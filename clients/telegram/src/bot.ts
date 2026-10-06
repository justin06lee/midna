/** The slice of the Telegram Bot API the bridge uses. Plain fetch, no library. */

export interface TgUser { id: number; username?: string; first_name?: string }
export interface TgChat { id: number; type: string }
export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
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

export class Bot {
  private readonly base: string;

  constructor(token: string, apiBase = process.env.TELEGRAM_API ?? "https://api.telegram.org") {
    this.base = `${apiBase.replace(/\/+$/, "")}/bot${token}`;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
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
  async send(chatId: number, text: string, opts: { silent?: boolean; keyboard?: InlineKeyboard } = {}): Promise<TgMessage[]> {
    const sent: TgMessage[] = [];
    const chunks = chunk(text, 3900);
    for (const [i, part] of chunks.entries()) {
      const extra = {
        chat_id: chatId,
        disable_notification: !!opts.silent,
        link_preview_options: { is_disabled: true },
        ...(opts.keyboard && i === chunks.length - 1 ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
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
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
        .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
    })
    .join("");
}
