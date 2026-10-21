/**
 * The midna wire protocol — the one contract every client speaks.
 *
 * The desktop app, the CLI, the Telegram bridge and any future mobile app are
 * all clients of this API and nothing else. No client gets a side door into
 * the daemon, which is what keeps any one of them deletable.
 */
import { z } from "zod";

export * from "./hands.ts";
import type { AnswerApproval, Approval, DeviceCommandRecord, HandsDevice, HandsHello, HandsResult, HandsStateUpdate, HandsWelcome } from "./hands.ts";

export const DEFAULT_PORT = 7717;
export const SERVICE = "midna";

export const Priority = z.enum(["urgent", "normal", "fyi"]);
export type Priority = z.infer<typeof Priority>;

export const Mode = z.enum(["autonomous", "ask"]);
export type Mode = z.infer<typeof Mode>;

/**
 * A file that goes with a message, of any type: a screenshot midna took, a
 * PDF it wrote, a zip, a photo the user sent. The bytes live on the host;
 * GET /v1/attachments/:id serves them to a paired device
 * (MidnaClient.attachment). A message's attachments are listed in the order
 * the sender chose, and every client shows them in that order.
 */
export const Attachment = z.object({
  id: z.string(),
  /**
   * "image" when a client should draw it inline; anything else — and an
   * image the sender chose to send as a file, at full quality — is a file.
   */
  kind: z.enum(["image", "file"]),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  /** A line the sender put with this one file. A host older than 0.5 leaves it out. */
  caption: z.string().nullable().default(null),
});
export type Attachment = z.infer<typeof Attachment>;

/** The largest file midna keeps as an attachment: 100 MB. POST /v1/attachments answers 413 above it. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** The most attachments one message carries, from the user or from midna. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

/** An upload never sent with a message is deleted after this long. */
export const UNSENT_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** How a client uploads a file: its name, what it is, and optionally a caption and whether an image goes as a file. */
export interface UploadInfo {
  name: string;
  mime: string;
  caption?: string;
  as?: "image" | "file";
}

/** Something midna is telling or asking the user. Replayable by id. */
export const OutboxItem = z.object({
  id: z.number(),
  /** Stream position, assigned when the item is released for delivery. */
  seq: z.number(),
  kind: z.enum(["message", "notification", "question"]),
  conversationId: z.string().nullable(),
  text: z.string(),
  priority: Priority,
  /** Answer choices for a question; the user may still reply in free text. */
  options: z.array(z.string()).nullable(),
  createdAt: z.number(),
  /** Held back until this time (quiet hours); clients may show it early. */
  deliverAfter: z.number(),
  /** Images and files sent with it. A host older than 0.4 leaves this out. */
  attachments: z.array(Attachment).default([]),
});
export type OutboxItem = z.infer<typeof OutboxItem>;

/** Live events on GET /v1/events. Only `outbox` events carry a replay id. */
export type StreamEvent =
  | { type: "outbox"; item: OutboxItem }
  | { type: "user_message"; id: number; conversationId: string; text: string; client: string; createdAt: number; replyTo: number | null; attachments: Attachment[] }
  | { type: "status"; conversationId: string | null; state: "thinking" | "idle" }
  | { type: "activity"; conversationId: string | null; tool: string }
  /** Device hands: something waits for the user's yes (state "pending"), or was answered, expired or dropped. 0.9+. */
  | { type: "approval"; approval: Approval };

export const SendMessage = z
  .object({
    /** May be empty when the message is only attachments. */
    text: z.string(),
    conversationId: z.string().optional(),
    /** Which client this came from ("telegram", "desktop", "cli", …). */
    client: z.string().default("unknown"),
    /** The outbox question this answers, when it answers one. */
    replyTo: z.number().optional(),
    /** Ids of attachments uploaded first with MidnaClient.upload, in the order to show them. */
    attachments: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  })
  .refine((m) => m.text.trim() || m.attachments?.length, { message: "a message needs text or an attachment" });
export type SendMessage = z.input<typeof SendMessage>;

/** How much JSON an inbound event may carry. */
export const MAX_EVENT_DATA_BYTES = 64 * 1024;
/** A source gets at most one wakeup per subject (ruri: per project) in this window; the rest are merged into it. */
export const EVENT_WINDOW_MS = 2 * 60_000;

/**
 * POST /v1/inbound: something that happened elsewhere, for midna to hear
 * in the background — never as the user's words, and never interrupting a
 * turn. `midna event --source <name> --title <t> --json <file|->` sends one.
 */
export const SendEvent = z.object({
  /** Who it's from ("ruri", "ci", …); the rate limit is per source. */
  source: z.string().trim().min(1).max(100),
  /** One line on what happened. */
  title: z.string().trim().min(1).max(1000),
  /** The sender's id for it (default: data.id): the same id from the same source counts once. */
  id: z.string().trim().min(1).max(200).optional(),
  /**
   * The event as JSON, up to MAX_EVENT_DATA_BYTES. Its kind (data.kind) is
   * shown to midna; data.project.id, when there is one, is the subject the
   * rate limit counts by.
   */
  data: z.unknown().optional(),
});
export type SendEvent = z.input<typeof SendEvent>;

/**
 * What became of an event: queued (a wakeup at dueAt delivers it), merged
 * (into the subject's wakeup still waiting), or a duplicate of one already
 * received.
 */
export type EventReceipt =
  | { status: "queued" | "merged"; eventId: number; wakeupId: number; dueAt: number }
  | { status: "duplicate"; eventId: number; wakeupId: number };

export const PairRequest = z.object({
  code: z.string().min(1),
  deviceName: z.string().min(1),
  kind: z.enum(["desktop", "cli", "bridge", "mobile"]),
  /**
   * The token this client held before, when it pairs again (a re-install, a
   * rollout re-pairing the CLI): its device is retired once the new one is
   * paired. A wrong or revoked token is ignored. From 0.10; older daemons
   * ignore it.
   */
  replaces: z.string().min(1).optional(),
});
export type PairRequest = z.infer<typeof PairRequest>;
export interface PairResponse {
  deviceId: string;
  token: string;
  name: string;
  /** The daemon's Ed25519 public key (base64url, 32 bytes), for a desktop to pin for device hands. From 0.8. */
  daemonKey?: string;
  /** The device retired because the request's `replaces` token was its. From 0.10. */
  replaced?: string;
}

export interface DeviceInfo { id: string; name: string; kind: string; created_at: number; last_seen_at: number | null }

export interface Health { ok: true; service: typeof SERVICE; version: string; name: string }

/** One line of the conversation as a client draws it. */
export interface HistoryItem {
  id: number;
  role: "user" | "midna";
  text: string;
  client: string | null;
  createdAt: number;
  /** The question this user message answered. */
  replyTo: number | null;
  /** How a midna line was delivered — kind, priority, and a question's options. */
  outbox: { id: number; seq: number | null; kind: OutboxItem["kind"]; priority: Priority; options: string[] | null; answered: boolean } | null;
  /** Images and files that went with the line. */
  attachments: Attachment[];
}

/** What the dashboards draw: objectives, what's open, what's coming. Times are epoch ms. */
export interface Overview {
  now: string;
  goals: Array<{ id: number; parent_id: number | null; title: string; why: string | null; horizon: "life" | "years" | "year" | "quarter" | "month" | "week"; success: string | null; status: "active" | "paused" | "done" | "abandoned"; target_at: number | null }>;
  tasks: Array<{ id: number; goal_id: number | null; title: string; notes: string | null; status: "todo" | "doing" | "waiting" | "done" | "dropped"; owner: "user" | "midna"; priority: number; due_at: number | null; estimate_min: number | null }>;
  commitments: Array<{ id: number; direction: "mine" | "theirs"; counterparty: string | null; person_id: number | null; what: string; due_at: number | null; status: string }>;
  events: Array<{ id: number; title: string; starts_at: number; ends_at: number | null; all_day: number; location: string | null; source: string; status: string }>;
  wakeups: Array<{ id: number; due_at: number; reason: string; kind: string; cron: string | null }>;
  memory: { live: number | null; archived: number | null };
  spendLast7DaysUsd: number;
}

/** An agent CLI on the host that could be midna's brain. */
export interface BrainInfo { id: string; label: string; installed: boolean; loginCommand: string; installHint: string }

/** A bridge to somewhere else (Telegram today). */
export interface BridgeInfo { name: string; enabled: boolean }
export interface BridgeSetupResult {
  /** What the user does next, in a sentence or two. */
  instructions: string;
  /** Where to do it, e.g. the bot's t.me link. */
  link?: string;
  /** What to send there, e.g. "/start K7QF2M". */
  code?: string;
}

export interface Status {
  version: string;
  name: string;
  mode: Mode;
  model: string;
  timezone: string;
  quietHours: { start: string; end: string } | null;
  busy: boolean;
  pendingWakeups: number;
  modes: Mode[];
  /** Current outbox stream position — where a new client starts reading. */
  outboxSeq: number;
  /** The machine midna lives on. */
  host: { name: string; platform: string };
  /** Whether midna can think: null until it has tried. */
  brain: BrainHealth;
  /** Device hands, all paused or not. From 0.8. */
  hands?: "on" | "paused";
}

export interface BrainHealth {
  ok: boolean | null;
  checkedAt: number | null;
  reason?: "signed_out" | "not_installed" | "unusable";
  message?: string;
  loginCommand?: string;
  installHint?: string;
}

export const SettingsPatch = z.object({
  mode: Mode.optional(),
  model: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  quietHours: z.object({ start: z.string(), end: z.string() }).nullable().optional(),
  /** "paused" stops every device's hands at once, whatever each app says. */
  hands: z.enum(["on", "paused"]).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** What a client can upload: a file's bytes. */
export type Upload = Blob | ArrayBuffer | Uint8Array<ArrayBuffer>;

export class MidnaError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** What MidnaClient fetches with: the global fetch, or one that streams where that one can't. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A typed client for the midna API. Works anywhere `fetch` does. */
export class MidnaClient {
  /**
   * `opts.fetch` replaces the global fetch for every call: React Native's
   * can't stream a body, so the event stream needs expo/fetch's there.
   */
  constructor(readonly baseUrl: string, private token?: string, private readonly opts: { fetch?: Fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // Called unbound: a browser's fetch throws when called on another object.
  private fetch(url: string, init: RequestInit): Promise<Response> {
    return (this.opts.fetch ?? globalThis.fetch)(url, init);
  }

  setToken(token: string): void {
    this.token = token;
  }

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, raw?: { body: Upload; type: string }): Promise<T> {
    const res = await this.fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : raw ? { "content-type": raw.type } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : raw ? { body: raw.body } : {}),
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new MidnaError(res.status, data?.error ?? res.statusText);
    return data as T;
  }

  /** Is midna there? Pass a signal (e.g. `AbortSignal.timeout(2_000)`) to stop waiting on a machine that never answers. */
  health(signal?: AbortSignal): Promise<Health> {
    return this.call("GET", "/healthz", undefined, signal);
  }
  pair(req: PairRequest): Promise<PairResponse> {
    return this.call("POST", "/v1/pair", req);
  }
  /** Mint a one-time code another device can pair with. */
  pairingCode(): Promise<{ code: string; expiresAt: number }> {
    return this.call("POST", "/v1/pairing-codes");
  }
  status(): Promise<Status> {
    return this.call("GET", "/v1/status");
  }
  updateSettings(patch: SettingsPatch): Promise<Status> {
    return this.call("PATCH", "/v1/settings", patch);
  }
  send(msg: SendMessage): Promise<{ conversationId: string }> {
    return this.call("POST", "/v1/messages", msg);
  }
  /** Every paired device that has said hello to hands, online or not. */
  handsDevices(): Promise<HandsDevice[]> {
    return this.call("GET", "/v1/hands/devices");
  }
  /** What midna had a device do, newest first. */
  deviceCommands(deviceId: string, limit = 200): Promise<DeviceCommandRecord[]> {
    return this.call("GET", `/v1/devices/${encodeURIComponent(deviceId)}/commands?limit=${limit}`);
  }
  /** The device side of hands (the desktop app does this in Rust): start a session. */
  handsHello(hello: HandsHello): Promise<HandsWelcome> {
    return this.call("POST", "/v1/hands/hello", hello);
  }
  handsState(update: HandsStateUpdate): Promise<{ ok: true }> {
    return this.call("POST", "/v1/hands/state", update);
  }
  handsResult(result: HandsResult): Promise<{ ok: true }> {
    return this.call("POST", `/v1/hands/results/${encodeURIComponent(result.id)}`, result);
  }
  /** What waits for the user's yes right now. */
  approvals(): Promise<Approval[]> {
    return this.call("GET", "/v1/approvals");
  }
  /** Answer an approval; the first answer wins (409 once it's over). */
  answerApproval(id: string, answer: AnswerApproval): Promise<Approval> {
    return this.call("POST", `/v1/approvals/${encodeURIComponent(id)}`, answer);
  }
  /** Tell midna about something that happened elsewhere; it hears it in the background. */
  event(e: SendEvent): Promise<EventReceipt> {
    return this.call("POST", "/v1/inbound", e);
  }
  /** The conversation, newest `limit` lines before message `before`, oldest first. */
  history(opts: { before?: number; limit?: number; conversationId?: string } = {}): Promise<HistoryItem[]> {
    const q = new URLSearchParams();
    if (opts.before) q.set("before", String(opts.before));
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.conversationId) q.set("conversation", opts.conversationId);
    return this.call("GET", `/v1/history?${q}`);
  }
  brains(): Promise<BrainInfo[]> {
    return this.call("GET", "/v1/brains");
  }
  /** Try the brain now (a tiny real turn); work that was waiting on it runs if it answers. */
  checkBrain(): Promise<BrainHealth> {
    return this.call("POST", "/v1/brains/check");
  }
  bridges(): Promise<BridgeInfo[]> {
    return this.call("GET", "/v1/bridges");
  }
  setupBridge(name: string, input: Record<string, string>): Promise<BridgeSetupResult> {
    return this.call("POST", `/v1/bridges/${encodeURIComponent(name)}/setup`, input);
  }
  /** An attachment's bytes. The desktop draws an image from them with URL.createObjectURL. */
  async attachment(id: string, signal?: AbortSignal): Promise<Blob> {
    const res = await this.fetch(`${this.baseUrl}/v1/attachments/${encodeURIComponent(id)}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
      throw new MidnaError(res.status, data?.error ?? res.statusText);
    }
    // Bun types Response.blob() as node:buffer's Blob; it is the global one.
    return (await res.blob()) as unknown as Blob;
  }
  /** Put a file of any type (up to MAX_ATTACHMENT_BYTES) on the host, to send with a message: `send({ text, attachments: [id, …] })`. */
  upload(data: Upload, file: UploadInfo): Promise<Attachment> {
    const q = new URLSearchParams({ name: file.name });
    if (file.caption) q.set("caption", file.caption);
    if (file.as) q.set("as", file.as);
    return this.call("POST", `/v1/attachments?${q}`, undefined, undefined, { body: data, type: file.mime || "application/octet-stream" });
  }
  /**
   * Take back an upload that was never sent (the user removed it before
   * sending). One already sent with a message stays: 409. Unsent uploads
   * are also deleted on their own after UNSENT_ATTACHMENT_TTL_MS.
   */
  deleteAttachment(id: string): Promise<{ ok: true }> {
    return this.call("DELETE", `/v1/attachments/${encodeURIComponent(id)}`);
  }
  /** Released outbox items after stream position `since`. */
  outbox(since = 0): Promise<OutboxItem[]> {
    return this.call("GET", `/v1/outbox?since=${since}`);
  }
  overview(signal?: AbortSignal): Promise<Overview> {
    return this.call("GET", "/v1/overview", undefined, signal);
  }
  devices(): Promise<DeviceInfo[]> {
    return this.call("GET", "/v1/devices");
  }
  revokeDevice(id: string): Promise<{ ok: true }> {
    return this.call("DELETE", `/v1/devices/${encodeURIComponent(id)}`);
  }
  /** Ask the daemon to re-read its config and restart its bridges. */
  reloadBridges(): Promise<{ ok: true }> {
    return this.call("POST", "/v1/bridges/reload");
  }

  /**
   * The live event stream. Outbox items after stream position `since` are
   * replayed first, so a client that remembers the last `seq` it showed never
   * misses one.
   *
   * However it ends — the caller's signal, an error, the caller breaking off,
   * or `idleMs` without a byte (the daemon writes a keepalive every 25s, so
   * silence means a dead connection) — the connection is closed. A browser
   * keeps an abandoned response open, and WebKit allows six per host: leak
   * six and every other request to midna waits forever.
   */
  async *events(since = 0, signal?: AbortSignal, idleMs = 60_000): AsyncGenerator<StreamEvent> {
    const ctl = new AbortController();
    let silent = false;
    const stop = () => ctl.abort();
    signal?.addEventListener("abort", stop, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    // Only time spent waiting on the network counts, not the caller handling an event.
    const watch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        silent = true;
        ctl.abort();
      }, idleMs);
    };
    try {
      if (signal?.aborted) return;
      watch();
      const res = await this.fetch(`${this.baseUrl}/v1/events?since=${since}`, {
        headers: { authorization: `Bearer ${this.token ?? ""}`, accept: "text/event-stream" },
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) throw new MidnaError(res.status, `event stream: ${res.statusText}`);
      // A reader, not `for await` over the body: WebKit's streams aren't async-iterable.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        clearTimeout(idle);
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (data) yield JSON.parse(data) as StreamEvent;
        }
        watch();
      }
    } catch (err) {
      if (silent) throw new Error(`event stream: nothing from midna for ${Math.round(idleMs / 1000)}s`);
      throw err;
    } finally {
      clearTimeout(idle);
      signal?.removeEventListener("abort", stop);
      ctl.abort();
    }
  }
}
export * from "./hosting.ts";
