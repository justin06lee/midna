import { connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "@midna/core";
import { isAlert, plainText, type Delivery, type OutboxItem, type PushRegistration, type PushState } from "@midna/protocol";

/**
 * Push notifications to the iPhone app, through Apple's push service (APNs)
 * with a token-signing (.p8) key. Alerts only, as Telegram's alerts mode
 * carries them; the alerts setting says whether Telegram sends them too, or
 * only what no push carried.
 */

/** `push.apns` in config.json. The key stays a private file beside the database. */
export interface ApnsConfig {
  /** The key's id, from the developer site's Keys page. */
  keyId: string;
  /** The Apple developer team the key and the app belong to. */
  teamId: string;
  /** The .p8 file; MIDNA_HOME/AuthKey_<keyId>.p8 when left out. */
  keyFile?: string;
  /** The app's bundle id, which APNs calls the topic. */
  bundleId?: string;
}

export const DEFAULT_BUNDLE_ID = "sh.midna.mobile";
type Environment = PushRegistration["environment"];
const HOSTS: Record<Environment, string> = { production: "https://api.push.apple.com", development: "https://api.sandbox.push.apple.com" };
const other = (env: Environment): Environment => (env === "production" ? "development" : "production");

/** Apple's answer to one push. */
export interface ApnsResponse {
  status: number;
  reason?: string;
}

/** One push to Apple: an HTTP/2 POST to /3/device/<token>. Injected in tests. */
export type ApnsTransport = (env: Environment, token: string, headers: Record<string, string>, body: string) => Promise<ApnsResponse>;

/** A signed provider token lives an hour; Apple refuses a new one more than every 20 min, so keep each for 40. */
const JWT_TTL_MS = 40 * 60_000;
const SEND_TIMEOUT_MS = 10_000;
/** The longest a bridge waits on a push's answer. */
export const MAX_DELIVERY_WAIT_MS = 15_000;
/** APNs takes 4 KB of payload; the text is cut well inside that. */
const BODY_MAX = 1_200;

/** The APNs settings in config.json, or null when push is off; a problem is logged, never fatal. */
export function loadApns(config: ApnsConfig | undefined, home: string): { keyId: string; teamId: string; key: KeyObject; bundleId: string } | null {
  if (!config) return null;
  if (!config.keyId || !config.teamId) {
    console.error("[midna] push: push.apns needs keyId and teamId — push notifications are off");
    return null;
  }
  const file = config.keyFile ?? join(home, `AuthKey_${config.keyId}.p8`);
  if (!existsSync(file)) {
    console.error(`[midna] push: no APNs key at ${file} — push notifications are off`);
    return null;
  }
  try {
    return { keyId: config.keyId, teamId: config.teamId, key: createPrivateKey(readFileSync(file, "utf8")), bundleId: config.bundleId ?? DEFAULT_BUNDLE_ID };
  } catch (err) {
    console.error(`[midna] push: ${file} is not a usable .p8 key (${(err as Error).message}) — push notifications are off`);
    return null;
  }
}

/** The notification an alert becomes: midna's name over its text as plain text (iOS draws no markdown), a question's choices, a word on its files. */
export function payload(item: OutboxItem, name: string): Record<string, unknown> {
  let body = plainText(item.text);
  if (item.options?.length) body += `\n${item.options.map(plainText).join(" · ")}`;
  const files = item.attachments.length;
  if (files) body += `${body ? "\n" : ""}📎 ${files === 1 ? item.attachments[0]!.name : `${files} files`}`;
  if (body.length > BODY_MAX) body = body.slice(0, BODY_MAX - 1).trimEnd() + "…";
  if (item.priority === "urgent") body = `❗ ${body}`;
  return {
    aps: {
      alert: { title: name, body },
      sound: "default",
      "thread-id": item.conversationId ?? "midna",
      "interruption-level": item.priority === "urgent" ? "time-sensitive" : "active",
    },
    outboxId: item.id,
    kind: item.kind,
  };
}

/** The real transport: one HTTP/2 session per APNs host, opened again when it closes. */
export function http2Transport(): ApnsTransport & { close(): void } {
  const sessions = new Map<Environment, ClientHttp2Session>();
  const session = (env: Environment) => {
    const open = sessions.get(env);
    if (open && !open.closed && !open.destroyed) return open;
    const s = connect(HOSTS[env]);
    s.on("error", () => sessions.delete(env));
    s.on("close", () => sessions.delete(env));
    s.on("goaway", () => sessions.delete(env));
    // A quiet midna doesn't hold Apple's connection open for nothing.
    s.setTimeout(10 * 60_000, () => s.close());
    sessions.set(env, s);
    return s;
  };
  const send: ApnsTransport = (env, token, headers, body) =>
    new Promise((resolve, reject) => {
      const req = session(env).request({ ":method": "POST", ":path": `/3/device/${token}`, "content-type": "application/json", ...headers });
      let status = 0;
      let text = "";
      let settled = false;
      const settle = (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err || !status) return reject(err ?? new Error("no answer from APNs"));
        let reason: string | undefined;
        try {
          reason = text ? (JSON.parse(text) as { reason?: string }).reason : undefined;
        } catch {}
        resolve({ status, ...(reason ? { reason } : {}) });
      };
      const timer = setTimeout(() => {
        settle(new Error(`APNs took over ${SEND_TIMEOUT_MS / 1000} s`));
        req.close();
      }, SEND_TIMEOUT_MS);
      req.setEncoding("utf8");
      req.on("response", (h) => (status = Number(h[":status"])));
      req.on("data", (d: string) => (text += d));
      req.on("end", () => settle(null));
      req.on("close", () => settle(null));
      req.on("error", (err) => settle(err));
      req.end(body);
    });
  return Object.assign(send, {
    close() {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  });
}

export interface PushOptions {
  store: Store;
  apns: ReturnType<typeof loadApns>;
  transport?: ApnsTransport;
}

/** Sends each alert to every registered phone, and answers bridges asking whether a push carried it. */
export class PushSender {
  private readonly store: Store;
  private readonly apns: ReturnType<typeof loadApns>;
  private readonly transport: ApnsTransport;
  private jwt: { token: string; at: number } | null = null;
  /** Pushes Apple hasn't answered yet, by outbox id. */
  private readonly inflight = new Map<number, Promise<PushState>>();

  constructor(opts: PushOptions) {
    this.store = opts.store;
    this.apns = opts.apns;
    this.transport = opts.transport ?? http2Transport();
  }

  close(): void {
    (this.transport as Partial<ReturnType<typeof http2Transport>>).close?.();
  }

  get configured(): boolean {
    return this.apns !== null;
  }

  /** Phones that get pushes. */
  phones(): number {
    return new Set(this.store.push.tokens().map((t) => t.device_id)).size;
  }

  /** A released outbox item: push it if it is an alert and the alerts setting wants pushes. */
  onOutbox(item: OutboxItem): void {
    if (!isAlert(item) || this.store.settings().alerts === "telegram") return;
    const tokens = this.store.push.tokens();
    if (!this.apns || !tokens.length) {
      this.store.push.record(item.id, "none", this.apns ? "no phone registered" : "no APNs key");
      return;
    }
    this.store.push.record(item.id, "pending");
    const sending = this.send(item, tokens).catch((err) => {
      console.error(`[midna] push: outbox #${item.id}: ${(err as Error).message}`);
      return "failed" as const;
    });
    this.inflight.set(item.id, sending);
    void sending.then((state) => {
      this.inflight.delete(item.id);
      return state;
    });
  }

  private async send(item: OutboxItem, tokens: ReturnType<Store["push"]["tokens"]>): Promise<PushState> {
    const body = JSON.stringify(payload(item, this.store.settings().name));
    const results = await Promise.all(tokens.map((t) => this.toPhone(t.token, t.environment, item, body)));
    const sent = results.filter((r) => r === null).length;
    const errors = [...new Set(results.filter((r): r is string => r !== null))];
    const state: PushState = sent ? "sent" : "failed";
    this.store.push.record(item.id, state, errors.length ? errors.join("; ") : null);
    if (!sent) console.error(`[midna] push: outbox #${item.id} reached no phone (${errors.join("; ")})`);
    return state;
  }

  /** One phone; null when Apple took it, else why not. Learns a token's environment, and drops a dead token. */
  private async toPhone(token: string, env: Environment, item: OutboxItem, body: string): Promise<string | null> {
    const headers = (fresh = false) => ({
      authorization: `bearer ${this.providerToken(fresh)}`,
      "apns-topic": this.apns!.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 24 * 3600),
      "apns-collapse-id": `outbox-${item.id}`,
    });
    let r = await this.transport(env, token, headers(), body);
    if (r.status === 403 && r.reason === "ExpiredProviderToken") r = await this.transport(env, token, headers(true), body);
    // A token from a build signed for the other environment: try there once, and keep what works.
    if (r.status === 400 && r.reason === "BadDeviceToken") {
      const r2 = await this.transport(other(env), token, headers(), body);
      if (r2.status === 200) {
        this.store.push.ok(token, other(env));
        return null;
      }
    }
    if (r.status === 200) {
      this.store.push.ok(token, env);
      return null;
    }
    const why = `${r.status}${r.reason ? ` ${r.reason}` : ""}`;
    if (r.status === 410 || (r.status === 400 && r.reason === "BadDeviceToken")) {
      this.store.push.unregister(token);
      console.log(`[midna] push: dropped token ${token.slice(0, 8)}… (${why})`);
    } else this.store.push.failed(token, why);
    return why;
  }

  private providerToken(fresh: boolean): string {
    const now = Date.now();
    if (!fresh && this.jwt && now - this.jwt.at < JWT_TTL_MS) return this.jwt.token;
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const unsigned = `${b64({ alg: "ES256", kid: this.apns!.keyId })}.${b64({ iss: this.apns!.teamId, iat: Math.floor(now / 1000) })}`;
    const sig = sign("sha256", Buffer.from(unsigned), { key: this.apns!.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    this.jwt = { token: `${unsigned}.${sig}`, at: now };
    return this.jwt.token;
  }

  /** How an outbox item is delivered; under "push", waits up to `waitMs` for Apple's answer. */
  async delivery(outboxId: number, waitMs = 0): Promise<Delivery> {
    const channel = this.store.settings().alerts;
    const pending = this.inflight.get(outboxId);
    if (pending && channel === "push" && waitMs > 0) {
      await Promise.race([pending, Bun.sleep(Math.min(waitMs, MAX_DELIVERY_WAIT_MS))]);
    }
    const push = this.store.push.outcome(outboxId)?.state ?? "none";
    return { channel, push, bridges: channel !== "push" || push !== "sent" };
  }
}
