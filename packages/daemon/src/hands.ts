import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fmt, type HandsRecord, type HandsSnapshot, type Store } from "@midna/core";
import type { HandsHandle, HandsOutcome, HandsRequest } from "@midna/agent";
import {
  CAPABILITIES,
  HANDS_POLICY,
  NEEDS,
  OPS,
  OP_ARGS,
  OP_TIMEOUTS,
  canonicalJson,
  type Attachment,
  type Capability,
  type HandsCommand,
  type HandsDevice,
  type HandsHello,
  type HandsResult,
  type HandsStateUpdate,
  type HandsStreamEvent,
  type HandsWelcome,
  type Mode,
  type Op,
  type Permission,
  type Policy,
} from "@midna/protocol";
import { Approvals } from "./approvals.ts";
import { writePrivate } from "./config.ts";

/**
 * Device hands, the daemon's side (docs/device-hands.md). The desktop app
 * on each of the user's computers says hello, keeps a stream open, and
 * answers commands; midna's device_* tools ask the hub, which runs each
 * request through the order in §3 — the device, the global pause, online
 * and its state, the capability and its permissions, the policy and mode
 * gate — then signs the command, sends it once, waits, and records how it
 * went. Nothing is queued for a device that isn't there.
 *
 * Commands come only from midna's tools (behind /mcp's per-run token): no
 * /v1 route issues one, so a client's token can't drive a computer.
 */

/** Which way the policy goes for one operation: run it, ask a person first, or not at all. */
export type Gate = "run" | "approve" | "refuse";

/**
 * The policy and mode gate (docs/device-hands.md §4): a capability Off is
 * refused; Ask needs a person's yes each time; On runs, except that ask
 * mode needs a yes for acting — only operations the policy counts as
 * observing run without one.
 */
export function decide(offer: Policy | undefined, mode: Mode, op: Op, policy: { observe: readonly Op[] } = HANDS_POLICY): Gate {
  if (!offer) return "refuse";
  if (offer === "ask") return "approve";
  if (mode === "autonomous") return "run";
  return policy.observe.includes(op) ? "run" : "approve";
}

export interface ApprovalRequest {
  deviceId: string;
  deviceName: string;
  op: Op;
  capability: Capability;
  /** The command it would let through. */
  commandId: string;
  /** As it will be sent, secrets redacted. */
  args: Record<string, unknown>;
  /** What a person is asked to allow, in plain words: "open https://… on MacBook Air". */
  summary: string;
  episodeId: number | null;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Who answered, from which client. */
  by?: string;
  /** Why not, in words midna can pass on. */
  reason?: string;
  /** The approval that decided it. */
  approvalId?: string;
}

/** Asks a person whether a command may run, and waits for the answer: Approvals (approvals.ts). */
export interface Approver {
  request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
}

/** The daemon's Ed25519 key, made on first use and kept private in MIDNA_HOME. Devices pin its public half. */
export function loadHandsKey(file: string): KeyObject {
  if (existsSync(file)) return createPrivateKey(readFileSync(file, "utf8"));
  const { privateKey } = generateKeyPairSync("ed25519");
  writePrivate(file, privateKey.export({ format: "pem", type: "pkcs8" }) as string);
  return privateKey;
}

/** One connection's way to the device: its event stream. */
export interface HandsConnection {
  send(e: HandsStreamEvent): void;
  /** End the stream, after what was sent. */
  close(): void;
}

interface Session {
  id: string;
  deviceId: string;
  /** The device's, fresh for this connection: every command is signed over it. */
  nonce: string;
  seq: number;
  /** The open stream; null while the device is away. */
  conn: HandsConnection | null;
}

type End = { kind: "result"; result: HandsResult } | { kind: "timeout" } | { kind: "cancelled" | "disconnected"; why: string };

interface Pending {
  deviceId: string;
  session: Session;
  settle(end: End): void;
}

const PERMISSION_NAMES: Record<Permission, string> = {
  screen_recording: "Screen Recording",
  accessibility: "Accessibility",
  automation: "Automation",
  full_disk_access: "Full Disk Access",
  notifications: "Notifications",
  local_network: "Local Network",
};

/** What a locked screen stops: anything that would see or drive the lock screen instead of the user's session. */
const LOCK_STOPS = new Set<Capability>(["screen", "input", "script"]);
const NO_DEVICES = "no device offers its hands yet: they come from the midna app on the user's computers, once hands are turned on there";
/** How long past a command's own timeout the daemon waits for its result: the device may still be uploading a screenshot. */
const RESULT_GRACE = 10_000;
/** How many of each device's recent nonces are remembered, to turn away a hello that reuses one. */
const NONCES_KEPT = 64;

/** The permissions a capability still needs on this device. Linux has no such permissions, so it reports n/a, or nothing. */
function missing(h: HandsSnapshot, c: Capability): Permission[] {
  return (NEEDS[c] ?? []).filter((p) => {
    const s = h.permissions[p];
    return !(s === "granted" || s === "n/a" || (s === undefined && h.os.family === "linux"));
  });
}

/** Arguments as the audit log keeps them: typed text the brain marked secret is left out. */
function redact(op: Op, args: Record<string, unknown>): Record<string, unknown> {
  return op === "type" && args.secret ? { ...args, text: `[${String(args.text ?? "").length} characters, secret]` } : args;
}

/** At most this much of a command, a script or typed text goes in a summary. */
const clip = (v: unknown, n = 120) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** What a command does, in the words an approval asks with: "run `brew upgrade` on MacBook Air". */
export function summarize(op: Op, args: Record<string, unknown>, device: string): string {
  const at = (a: Record<string, unknown>) => `${Math.round(Number(a.x))}, ${Math.round(Number(a.y))}`;
  const path = Array.isArray(args.path) ? (args.path as Array<Record<string, unknown>>) : [];
  const what = (() => {
    switch (op) {
      case "screenshot": return "take a screenshot";
      case "click": return `${args.button === "right" ? "right-" : ""}click at ${at(args)}`;
      case "move": return `move the pointer to ${at(args)}`;
      case "drag": return `drag from ${at(path[0] ?? {})} to ${at(path.at(-1) ?? {})}`;
      case "scroll": return "scroll";
      case "type": return args.secret ? `type ${String(args.text ?? "").length} secret characters` : `type "${clip(args.text, 80)}"`;
      case "key": return `press ${clip(args.keys, 40)}`;
      case "script": return `run ${args.language === "jxa" ? "JXA" : "AppleScript"} "${clip(args.source)}"`;
      case "shell": return `run \`${clip(args.command)}\``;
      case "file_read": return `read ${clip(args.path)}`;
      case "file_list": return `list ${clip(args.path)}`;
      case "file_write": return `${args.mode === "append" ? "append to" : args.mode === "overwrite" ? "overwrite" : "write"} ${clip(args.path)}`;
      case "clipboard_read": return "read the clipboard";
      case "clipboard_write": return "set the clipboard";
      case "open": return `open ${clip(args.url ?? args.app ?? args.path)}`;
      case "notify": return `show the notification "${clip(args.title, 80)}"`;
    }
  })();
  return `${what} on ${device}`;
}

export class HandsHub implements HandsHandle {
  readonly publicKey: string;
  readonly fingerprint: string;
  private readonly key: KeyObject;
  private readonly store: Store;
  /** What waits for the user's yes, and the answers. */
  readonly approvals: Approvals;
  private readonly policy: { observe: readonly Op[] };
  private readonly graceMs: number;
  /** The live session of each device that said hello. */
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Pending>();
  private readonly nonces = new Map<string, string[]>();

  constructor(opts: { store: Store; keyFile: string; policy?: { observe: readonly Op[] }; graceMs?: number; approvalMs?: number }) {
    this.store = opts.store;
    this.key = loadHandsKey(opts.keyFile);
    this.approvals = new Approvals({
      store: opts.store,
      toDevice: (deviceId, e) => this.sessions.get(deviceId)?.conn?.send(e),
      ...(opts.approvalMs !== undefined ? { timeoutMs: opts.approvalMs } : {}),
    });
    this.policy = opts.policy ?? HANDS_POLICY;
    this.graceMs = opts.graceMs ?? RESULT_GRACE;
    this.publicKey = createPublicKey(this.key).export({ format: "jwk" }).x!;
    const raw = Buffer.from(this.publicKey, "base64url");
    this.fingerprint = createHash("sha256").update(raw).digest("hex").slice(0, 32).match(/.{4}/g)!.join(" ");
  }

  // ── the device's side ────────────────────────────────────────────────

  /** A device starts a session: any earlier one of its ends, with whatever it had in flight. */
  hello(deviceId: string, hello: HandsHello): HandsWelcome | { error: string } {
    const used = this.nonces.get(deviceId) ?? [];
    if (used.includes(hello.nonce)) return { error: "that nonce was used before: every connection needs a fresh one" };
    used.push(hello.nonce);
    if (used.length > NONCES_KEPT) used.shift();
    this.nonces.set(deviceId, used);
    this.end(deviceId, "replaced");
    const session: Session = { id: "hs_" + randomBytes(12).toString("base64url"), deviceId, nonce: hello.nonce, seq: 0, conn: null };
    this.sessions.set(deviceId, session);
    this.store.hands.saveHello(deviceId, hello);
    return { session: session.id, daemonKey: this.publicKey, fingerprint: this.fingerprint };
  }

  /**
   * The session's stream opened: the device is online until `detach`. A
   * second stream on the same session takes over from the first.
   */
  attach(deviceId: string, sessionId: string, conn: HandsConnection): (() => void) | null {
    const s = this.sessions.get(deviceId);
    if (!s || s.id !== sessionId) return null;
    s.conn?.close();
    s.conn = conn;
    this.store.hands.seen(deviceId);
    return () => {
      if (s.conn !== conn) return;
      s.conn = null;
      this.store.hands.seen(deviceId);
      this.failPending(s, "disconnected", "the connection dropped");
    };
  }

  /** Something changed on the device. False when the session is no longer its current one. */
  state(deviceId: string, update: HandsStateUpdate): boolean {
    const s = this.sessions.get(deviceId);
    if (!s || s.id !== update.session) return false;
    const { session: _, ...change } = update;
    this.store.hands.update(deviceId, change);
    return true;
  }

  /** A command's result, taken once, from the device it was sent to. */
  result(deviceId: string, result: HandsResult): "ok" | "unknown" | "other" | "done" {
    const p = this.pending.get(result.id);
    if (p) {
      if (p.deviceId !== deviceId) return "other";
      this.store.hands.seen(deviceId);
      p.settle({ kind: "result", result });
      return "ok";
    }
    const row = this.store.hands.command(result.id);
    if (!row) return "unknown";
    return row.deviceId === deviceId ? "done" : "other";
  }

  /** The device was unpaired: its stream ends at once, and nothing waits on its approvals. */
  disconnect(deviceId: string): void {
    this.end(deviceId, "revoked");
    this.approvals.cancelAll(deviceId);
  }

  /** The user paused every device: what's in flight, or waiting for a yes, is cancelled. */
  pauseAll(): void {
    this.approvals.cancelAll();
    for (const [id, p] of this.pending) {
      p.session.conn?.send({ type: "cancel", id });
      p.settle({ kind: "cancelled", why: "the user paused every device's hands" });
    }
  }

  shutdown(): void {
    this.approvals.cancelAll();
    for (const deviceId of [...this.sessions.keys()]) this.end(deviceId, "shutdown");
  }

  // ── midna's side ─────────────────────────────────────────────────────

  online(deviceId: string): boolean {
    return !!this.sessions.get(deviceId)?.conn;
  }

  devices(): HandsDevice[] {
    return this.store.hands.list().map((r) => ({
      id: r.deviceId,
      name: r.name,
      online: this.online(r.deviceId),
      lastSeenAt: r.lastSeenAt,
      state: r.hello.state,
      os: r.hello.os,
      app: r.hello.app,
      displays: r.hello.displays,
      capabilities: CAPABILITIES.map((c) => ({ capability: c, policy: r.hello.offers[c] ?? "off", missing: missing(r.hello, c) })),
    }));
  }

  async run(req: HandsRequest): Promise<HandsOutcome> {
    const { op, episodeId } = req;
    const capability = OPS[op];
    const parsed = OP_ARGS[op].safeParse(req.args);
    if (!parsed.success) return { ok: false, code: "bad_args", message: `${op}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")}` };
    const args = parsed.data as Record<string, unknown>;
    const settings = this.store.settings();

    // 1. The device exists and isn't revoked.
    const found = this.resolve(req.device, capability);
    if ("error" in found) return { ok: false, code: "no_device", message: found.error };
    const { deviceId, name, hello } = found.record;
    const id = "cmd_" + randomBytes(9).toString("base64url");
    const logged = redact(op, args);
    const refuse = (code: string, reason: string): HandsOutcome => {
      this.store.hands.record({ id, deviceId, episodeId, op, args: logged, decision: "refused", reason });
      return { ok: false, code, message: reason };
    };

    // 2. The global pause.
    if (settings.hands === "paused") return refuse("paused", "the user has paused every device's hands (midna's hands setting)");
    // 3. Online, in a state that allows it.
    if (!this.online(deviceId)) return refuse("offline", `${name} is offline (last seen ${fmt(found.record.lastSeenAt, settings.timezone)}); nothing is queued for later`);
    if (hello.state === "paused") return refuse("paused", `${name} is paused by the user`);
    if (hello.state === "locked" && LOCK_STOPS.has(capability)) return refuse("locked", `${name} is locked`);
    if (hello.state === "display_asleep" && op === "screenshot" && !args.wake) return refuse("asleep", `${name}'s display is asleep: take the screenshot with wake: true to wake it`);
    // 4. Offered, with its permissions granted.
    const offer = hello.offers[capability];
    if (!offer) return refuse("off", `${name} has ${capability} turned off; only the user can turn it on, in the midna app on that computer`);
    const lacking = missing(hello, capability);
    if (lacking.length) {
      const names = lacking.map((p) => PERMISSION_NAMES[p]).join(" and ");
      return refuse("permission", `${name} can't use ${capability} until the user grants the midna app ${names} there (System Settings → Privacy & Security)`);
    }
    // 5. The policy and mode gate, which may wait for a person.
    const gate = decide(offer, settings.mode, op, this.policy);
    if (gate === "refuse") return refuse("off", `${name} doesn't allow ${capability}`);
    let approval: HandsCommand["approval"];
    let approvalId: string | null = null;
    if (gate === "approve") {
      const summary = summarize(op, args, name);
      const answer = await this.approvals.request({ deviceId, deviceName: name, op, capability, commandId: id, args: logged, summary, episodeId }, req.signal);
      approvalId = answer.approvalId ?? null;
      if (!answer.approved) {
        const reason = answer.reason ?? "the user said no";
        this.store.hands.record({ id, deviceId, episodeId, op, args: logged, decision: "denied", decidedBy: answer.by ?? null, reason, approvalId });
        return { ok: false, code: "denied", message: `${summary}: ${reason}` };
      }
      approval = { by: answer.by ?? "the user", at: Date.now() };
    }
    this.store.hands.record({ id, deviceId, episodeId, op, args: logged, decision: approval ? "approved" : "allowed", decidedBy: approval?.by ?? "policy", approvalId });
    // Waiting for a yes, the device may have gone.
    const session = this.sessions.get(deviceId);
    if (!session?.conn) return this.close(id, op, name, { kind: "disconnected", why: `${name} went offline before it could be sent` });

    // 6. Sign and send. 7. Await the result, or time out.
    const limits = OP_TIMEOUTS[op];
    const timeoutMs = Math.max(1, Math.min(req.timeoutMs ?? limits.default, limits.cap));
    const command: HandsCommand = { id, nonce: session.nonce, seq: ++session.seq, op, args, timeoutMs, episodeId, ...(approval ? { approval } : {}), issuedAt: Date.now() };
    const signed = canonicalJson(command);
    const sig = sign(null, Buffer.from(signed), this.key).toString("base64url");
    const end = await new Promise<End>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        session.conn?.send({ type: "cancel", id });
        settle({ kind: "cancelled", why: "the tool call was cancelled" });
      };
      const settle = (e: End) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        resolve(e);
      };
      this.pending.set(id, { deviceId, session, settle });
      timer = setTimeout(() => {
        session.conn?.send({ type: "cancel", id });
        settle({ kind: "timeout" });
      }, timeoutMs + this.graceMs);
      req.signal?.addEventListener("abort", onAbort, { once: true });
      session.conn!.send({ type: "command", signed, sig });
      if (req.signal?.aborted) onAbort();
    });
    // 8. Record the outcome.
    return this.close(id, op, name, end, deviceId);
  }

  /** Record how a command that went out ended, and say so in words midna can act on. */
  private close(id: string, op: Op, name: string, end: End, deviceId?: string): HandsOutcome {
    const acting = !this.policy.observe.includes(op);
    const maybe = acting ? " — it may or may not have happened" : "";
    if (end.kind === "result") {
      const r = end.result;
      if (r.ok) {
        const attachments = (r.attachments ?? []).map((a) => this.store.attachments.get(a)).filter((a): a is Attachment => !!a);
        this.store.hands.finish(id, { outcome: "ok", summary: r.data === undefined ? null : canonicalJson(r.data), attachments: attachments.map((a) => a.id) });
        return { ok: true, device: { id: deviceId!, name }, commandId: id, data: r.data, attachments, ms: r.ms };
      }
      const needs = r.error.permission ? ` (needs ${PERMISSION_NAMES[r.error.permission]})` : "";
      this.store.hands.finish(id, { outcome: "error", errorCode: r.error.code, summary: r.error.message });
      return { ok: false, code: r.error.code, message: `${name}: ${r.error.message}${needs}` };
    }
    if (end.kind === "timeout") {
      this.store.hands.finish(id, { outcome: "timeout", reason: "no result in time; cancelled" });
      return { ok: false, code: "timeout", message: `${name} didn't finish ${op} in time, so it was cancelled${maybe}` };
    }
    this.store.hands.finish(id, { outcome: end.kind, reason: end.why });
    return { ok: false, code: end.kind, message: `${op} on ${name}: ${end.why}${maybe}` };
  }

  /** A device by id or name (any case); left out, the one online device that offers the capability. */
  private resolve(device: string | undefined, capability: Capability): { record: HandsRecord } | { error: string } {
    const all = this.store.hands.list();
    if (!all.length) return { error: NO_DEVICES };
    const names = () => all.map((d) => d.name).join(", ");
    if (device?.trim()) {
      const want = device.trim();
      const byId = all.find((d) => d.deviceId === want);
      if (byId) return { record: byId };
      const named = all.filter((d) => d.name.toLowerCase() === want.toLowerCase());
      if (named.length === 1) return { record: named[0]! };
      if (named.length > 1) return { error: `more than one device is called "${want}": give its id (${named.map((d) => d.deviceId).join(", ")})` };
      return { error: `no device called "${want}" offers its hands; these do: ${names()}` };
    }
    const able = all.filter((d) => this.online(d.deviceId) && d.hello.offers[capability]);
    if (able.length === 1) return { record: able[0]! };
    if (able.length > 1) return { error: `more than one device can do that (${able.map((d) => d.name).join(", ")}): say which` };
    // None can. With only one in the running, take it, so the refusal says exactly why.
    const online = all.filter((d) => this.online(d.deviceId));
    const only = online.length === 1 ? online[0] : !online.length && all.length === 1 ? all[0] : undefined;
    if (only) return { record: only };
    return { error: `no device can do that now: ${all.map((d) => `${d.name} (${this.online(d.deviceId) ? `${capability} off` : "offline"})`).join(", ")}` };
  }

  private end(deviceId: string, reason: "replaced" | "revoked" | "shutdown"): void {
    const s = this.sessions.get(deviceId);
    if (!s) return;
    this.sessions.delete(deviceId);
    if (s.conn) {
      s.conn.send({ type: "bye", reason });
      s.conn.close();
      s.conn = null;
    }
    this.failPending(s, "disconnected", reason === "replaced" ? "the device started a new session" : reason === "revoked" ? "the device was unpaired" : "midna is shutting down");
  }

  private failPending(s: Session, kind: "disconnected", why: string): void {
    for (const p of [...this.pending.values()]) if (p.session === s) p.settle({ kind, why });
  }
}
