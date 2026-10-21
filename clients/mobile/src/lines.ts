import { APPROVAL_OPTIONS, type Approval, type Attachment, type HistoryItem, type OutboxItem, type Priority } from "@midna/protocol";

/**
 * The conversation as the phone draws it — the desktop's model (useMidna.ts
 * there), kept free of React Native so it can be tested under bun.
 */

/** One line of the conversation, however it arrived. */
export interface Line {
  /** "m:<message id>" for the user's lines, "o:<outbox id>" for midna's, "p:<n>" while sending. */
  key: string;
  role: "user" | "midna";
  text: string;
  client: string | null;
  at: number;
  kind?: OutboxItem["kind"];
  priority?: Priority;
  options?: string[] | null;
  answered?: boolean;
  outboxId?: number;
  /** Images and files that went with it, in the sender's order. */
  attachments: Attachment[];
  /** The message id, for lines that came from history — where older pages continue from. */
  messageId?: number;
  pending?: boolean;
}

// A host older than 0.4 sends no attachments at all.
export function fromHistory(h: HistoryItem): Line {
  const attachments = h.attachments ?? [];
  if (h.role === "user") return { key: `m:${h.id}`, role: "user", text: h.text, client: h.client, at: h.createdAt, messageId: h.id, attachments };
  const o = h.outbox;
  return {
    key: o ? `o:${o.id}` : `m:${h.id}`,
    messageId: h.id,
    role: "midna",
    text: h.text,
    client: h.client,
    at: h.createdAt,
    attachments,
    ...(o ? { kind: o.kind, priority: o.priority, options: o.options, answered: o.answered, outboxId: o.id } : { kind: "message" as const }),
  };
}

export function fromOutbox(item: OutboxItem): Line {
  return { key: `o:${item.id}`, role: "midna", text: item.text, client: null, at: item.createdAt, kind: item.kind, priority: item.priority, options: item.options, answered: false, outboxId: item.id, attachments: item.attachments ?? [] };
}

const files = (l: Line) => l.attachments.map((a) => a.id).join();

/**
 * Lines merged in by key: a line seen before is updated in place, and the
 * echo of something this phone sent replaces its placeholder.
 */
export function mergeLines(cur: Line[], incoming: Line[], where: "append" | "prepend" = "append"): Line[] {
  const seen = new Map(cur.map((l, i) => [l.key, i]));
  const next = [...cur];
  const fresh: Line[] = [];
  for (const l of incoming) {
    const at = seen.get(l.key);
    if (at !== undefined) next[at] = { ...next[at]!, ...l };
    else {
      const p = l.role === "user" ? next.findIndex((x) => x.pending && x.text === l.text && files(x) === files(l)) : -1;
      if (p >= 0) next[p] = l;
      else fresh.push(l);
    }
  }
  return where === "prepend" ? [...fresh, ...next] : [...next, ...fresh];
}

/**
 * A question whose options are an approval's. Its buttons must never send
 * the label as a reply — that answers the approval with no Face ID — so
 * they only ever answer through the approval itself.
 */
export function asksApproval(l: Line): boolean {
  const labels = APPROVAL_OPTIONS.map((o) => o.label);
  return l.kind === "question" && !!l.options && l.options.length === labels.length && l.options.every((o, i) => o === labels[i]);
}

/** How an approval ended, in words: "Allowed for 10 min by Justin's iPhone (mobile)". */
export function approvalOutcome(a: Approval): string {
  const by = a.answeredBy ? ` by ${a.answeredBy}${a.answeredVia ? ` (${a.answeredVia})` : ""}` : "";
  if (a.state === "allowed") return `${a.answer === "allow_10_min" ? "Allowed for 10 min" : "Allowed"}${by}`;
  if (a.state === "denied") return `Denied${by}`;
  if (a.state === "expired") return "No answer in time, so no";
  if (a.state === "cancelled") return "No longer needed";
  return "Waiting for your answer";
}

/** "3.4 MB" */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
