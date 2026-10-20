import { randomBytes } from "node:crypto";
import { MAIN, type Store } from "@midna/core";
import { APPROVAL_GRANT_MS, APPROVAL_OPTIONS, APPROVAL_TIMEOUT_MS, type Approval, type ApprovalAnswer, type HandsStreamEvent } from "@midna/protocol";
import type { ApprovalDecision, ApprovalRequest, Approver } from "./hands.ts";

/**
 * Approvals (fork 1 in docs/device-hands.md): a device command that needs
 * the user's yes waits for it. The question goes everywhere at once — the
 * panel on the machine itself (its hands stream), every client (the event
 * stream), and the chat, as a question whose options are the answers, so
 * today's Telegram bridge and desktop chat can answer it as they are. The
 * first answer wins; none within APPROVAL_TIMEOUT_MS is no. "Allow for 10
 * min" lets that device and capability through without asking for a while.
 */

/** Typed replies to an approval's question that answer it, beyond its own labels. */
const TEN_MINUTES = /^allow for 10 ?min(ute)?s?[.!]*$/i;
const YES = /^(allow|yes|y|ok|okay|sure|approve|go ahead)[.!]*$/i;
const NO = /^(deny|no|n|nope|don't|do not)[.!]*$/i;

/** The answer a reply to an approval's question gives; null when it says something else, which is a message to midna. */
export function answerIn(text: string): ApprovalAnswer | null {
  const t = text.trim();
  const option = APPROVAL_OPTIONS.find((o) => o.label.toLowerCase() === t.toLowerCase());
  if (option) return option.answer;
  if (TEN_MINUTES.test(t)) return "allow_10_min";
  if (YES.test(t)) return "allow";
  if (NO.test(t)) return "deny";
  return null;
}

const who = (a: Approval) => (a.answeredBy ? `${a.answeredBy}${a.answeredVia ? ` (${a.answeredVia})` : ""}` : "the user");
const minutes = (ms: number) => (ms % 60_000 ? `${Math.round(ms / 1000)} seconds` : `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`);

export class Approvals implements Approver {
  private readonly store: Store;
  private readonly timeoutMs: number;
  private readonly grantMs: number;
  /** The tool calls waiting, by approval. */
  private readonly waiting = new Map<string, (a: Approval) => void>();

  constructor(private readonly opts: { store: Store; toDevice: (deviceId: string, e: HandsStreamEvent) => void; timeoutMs?: number; grantMs?: number }) {
    this.store = opts.store;
    this.timeoutMs = opts.timeoutMs ?? APPROVAL_TIMEOUT_MS;
    this.grantMs = opts.grantMs ?? APPROVAL_GRANT_MS;
    // Left pending by an earlier run: nobody waits on them now.
    for (const a of this.store.hands.pendingApprovals()) this.close(a.id, "cancelled");
  }

  async request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    const { store } = this;
    const grant = store.hands.grant(req.deviceId, req.capability, this.grantMs);
    if (grant) return { approved: true, by: `${who(grant)}, allowed for 10 min`, approvalId: grant.id };
    if (signal?.aborted) return { approved: false, reason: "the tool call was cancelled" };
    const id = "apr_" + randomBytes(9).toString("base64url");
    const question = store.say(
      {
        kind: "question",
        text: `${store.settings().name} wants to ${req.summary}. Allow? No answer in ${minutes(this.timeoutMs)} means no.`,
        options: APPROVAL_OPTIONS.map((o) => o.label),
        priority: "urgent",
        conversationId: MAIN,
      },
      { client: "approval", seenByBrain: true },
    );
    const approval = store.hands.requestApproval({
      id,
      deviceId: req.deviceId,
      capability: req.capability,
      op: req.op,
      summary: req.summary,
      commandId: req.commandId,
      episodeId: req.episodeId,
      outboxId: question.id,
      expiresAt: Date.now() + this.timeoutMs,
    });
    console.log(`[midna] hands: asking to ${req.summary} (${id})`);
    const settled = await new Promise<Approval>((resolve) => {
      const timer = setTimeout(() => this.close(id, "expired"), this.timeoutMs);
      const onAbort = () => this.close(id, "cancelled");
      this.waiting.set(id, (a) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiting.delete(id);
        resolve(a);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.announce(approval);
    });
    if (settled.state === "allowed") return { approved: true, by: `${who(settled)}${settled.answer === "allow_10_min" ? ", for 10 min" : ""}`, approvalId: id };
    const reason =
      settled.state === "denied" ? `${who(settled)} said no`
      : settled.state === "expired" ? `no answer within ${minutes(this.timeoutMs)}, so no`
      : "the request for approval was dropped";
    return { approved: false, reason, approvalId: id, ...(settled.state === "denied" ? { by: who(settled) } : {}) };
  }

  /** What waits for an answer now. */
  pending(): Approval[] {
    return this.store.hands.pendingApprovals();
  }

  /** A person's answer. The first one wins: "over" after that. */
  answer(id: string, answer: ApprovalAnswer, by: { name: string; via: string }): Approval | "unknown" | "over" {
    const { store } = this;
    const done = store.hands.answerApproval(id, { answer, by: by.name, via: by.via });
    if (!done) return store.hands.approval(id) ? "over" : "unknown";
    console.log(`[midna] hands: ${by.name} (${by.via}) answered ${answer} to ${done.summary}`);
    this.closed(done);
    // Allowed for 10 minutes: whatever else waits on that device and capability goes too.
    if (answer === "allow_10_min") {
      for (const other of store.hands.pendingApprovals()) {
        if (other.deviceId !== done.deviceId || other.capability !== done.capability) continue;
        const also = store.hands.answerApproval(other.id, { answer, by: by.name, via: by.via });
        if (also) this.closed(also);
      }
    }
    return done;
  }

  /**
   * A reply in chat to an approval's question: the answer, when it gives
   * one (it is kept in the conversation, never sent to midna); "over" when
   * it gives one too late; null when it's no answer, or no approval's
   * question — a message for midna.
   */
  reply(m: { replyTo: number; text: string; client: string }, by: { name: string }): Approval | "over" | null {
    const asked = this.store.hands.approvalAsked(m.replyTo);
    const answer = asked && answerIn(m.text);
    if (!asked || !answer) return null;
    const r = this.answer(asked.id, answer, { name: by.name, via: m.client });
    if (r === "unknown" || r === "over") return "over";
    const msg = this.store.log.addMessage({ conversationId: MAIN, role: "user", text: m.text, client: m.client, seen: true, replyTo: m.replyTo });
    this.store.bus.emit({ type: "user_message", id: msg.id, conversationId: MAIN, text: m.text, client: m.client, createdAt: msg.created_at, replyTo: m.replyTo, attachments: [] });
    return r;
  }

  /** Nobody will wait for these any more: everything pending, or one device's. */
  cancelAll(deviceId?: string): void {
    for (const a of this.store.hands.pendingApprovals()) if (!deviceId || a.deviceId === deviceId) this.close(a.id, "cancelled");
  }

  private close(id: string, state: "expired" | "cancelled"): void {
    const a = this.store.hands.closeApproval(id, state);
    if (a) this.closed(a);
  }

  /** It's over: close its question, tell everyone, and let the tool call go on. */
  private closed(a: Approval): void {
    if (a.outboxId) this.store.outbox.answered(a.outboxId);
    this.announce(a);
    this.waiting.get(a.id)?.(a);
  }

  private announce(a: Approval): void {
    this.store.bus.emit({ type: "approval", approval: a });
    this.opts.toDevice(a.deviceId, { type: "approval", approval: a });
  }
}
