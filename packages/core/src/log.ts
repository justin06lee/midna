import type { Database } from "bun:sqlite";
import type { HistoryItem, ReplyFallback, ReplyRef, SpendDay, SpendKind } from "@midna/protocol";
import type { Attachments } from "./attachments.ts";
import { ftsQuery } from "./planning.ts";
import { DAY, HOUR, fmtDate, startOfLocalDay } from "./time.ts";

/** The episodic record: conversations, every message, every episode, every action. */

export interface Conversation {
  id: string;
  title: string | null;
  brain_model: string | null;
  brain_session: string | null;
  brain_started_at: number | null;
  brain_turns: number;
  created_at: number;
  last_active_at: number;
}

export interface Message {
  id: number;
  conversation_id: string;
  role: "user" | "midna";
  text: string;
  client: string | null;
  seen_by_brain: number;
  outbox_id: number | null;
  reply_to: number | null;
  /** The earlier line this user message is a native reply to. */
  in_reply_to: number | null;
  /** The part of that line the user highlighted. */
  reply_quote: string | null;
  /** What the client knew of a line it couldn't name: ReplyFallback as JSON. */
  reply_fallback: string | null;
  created_at: number;
}

export const MAIN = "main";

interface HistoryRow {
  id: number;
  role: Message["role"];
  text: string;
  client: string | null;
  created_at: number;
  reply_to: number | null;
  in_reply_to: number | null;
  reply_quote: string | null;
  reply_fallback: string | null;
  o_id: number | null;
  o_seq: number | null;
  o_kind: "message" | "notification" | "question";
  o_priority: "urgent" | "normal" | "fyi";
  o_options: string | null;
  o_text: string | null;
  o_answered: number | null;
}

export class Log {
  constructor(private db: Database, private files: Attachments) {}

  conversation(id: string, now = Date.now()): Conversation {
    this.db
      .query("INSERT OR IGNORE INTO conversations (id, created_at, last_active_at) VALUES ($id, $now, $now)")
      .run({ id, now });
    return this.db.query("SELECT * FROM conversations WHERE id = $id").get({ id }) as Conversation;
  }

  setBrain(id: string, brain: { model: string; session: string | null; startedAt: number | null; turns: number }): void {
    this.db
      .query("UPDATE conversations SET brain_model = $m, brain_session = $s, brain_started_at = $at, brain_turns = $t WHERE id = $id")
      .run({ m: brain.model, s: brain.session, at: brain.startedAt, t: brain.turns, id });
  }

  /**
   * Record a message. `seen` says whether the conversation's brain already
   * knows about it: a user message waits to be read; something midna said
   * from a wakeup is news to the chat brain too.
   */
  addMessage(
    m: {
      conversationId: string;
      role: Message["role"];
      text: string;
      client?: string;
      seen: boolean;
      outboxId?: number;
      replyTo?: number;
      inReplyTo?: { messageId: number | null; quote: string | null; fallback: ReplyFallback | null } | null;
    },
    now = Date.now(),
  ): Message {
    this.conversation(m.conversationId, now);
    this.db.query("UPDATE conversations SET last_active_at = $now WHERE id = $id").run({ now, id: m.conversationId });
    const r = m.inReplyTo;
    return this.db
      .query(
        `INSERT INTO messages (conversation_id, role, text, client, seen_by_brain, outbox_id, reply_to, in_reply_to, reply_quote, reply_fallback, created_at)
         VALUES ($c, $role, $text, $client, $seen, $o, $r, $ir, $q, $fb, $now) RETURNING *`,
      )
      .get({
        c: m.conversationId,
        role: m.role,
        text: m.text,
        client: m.client ?? null,
        seen: m.seen ? 1 : 0,
        o: m.outboxId ?? null,
        r: m.replyTo ?? null,
        ir: r?.messageId ?? null,
        q: r?.quote ?? null,
        fb: r?.fallback ? JSON.stringify(r.fallback) : null,
        now,
      }) as Message;
  }

  get(id: number): Message | null {
    return this.db.query("SELECT * FROM messages WHERE id = $id").get({ id }) as Message | null;
  }

  /** The line a native reply points at, by its message id or (one of midna's) its outbox id, in this conversation only. */
  resolveReply(conversationId: string, ref: { messageId?: number; outboxId?: number }): number | null {
    const row =
      ref.messageId !== undefined
        ? this.db.query("SELECT id FROM messages WHERE id = $id AND conversation_id = $c").get({ id: ref.messageId, c: conversationId })
        : ref.outboxId !== undefined
          ? this.db.query("SELECT id FROM messages WHERE outbox_id = $o AND conversation_id = $c ORDER BY id LIMIT 1").get({ o: ref.outboxId, c: conversationId })
          : null;
    return (row as { id: number } | null)?.id ?? null;
  }

  unseen(conversationId: string): Message[] {
    return this.db
      .query("SELECT * FROM messages WHERE conversation_id = $c AND seen_by_brain = 0 ORDER BY id")
      .all({ c: conversationId }) as Message[];
  }

  markSeen(ids: number[]): void {
    const stmt = this.db.query("UPDATE messages SET seen_by_brain = 1 WHERE id = $id");
    for (const id of ids) stmt.run({ id });
  }

  recent(conversationId: string, limit: number, beforeId?: number): Message[] {
    return (
      this.db
        .query(
          `SELECT * FROM messages WHERE conversation_id = $c ${beforeId ? "AND id < $b" : ""}
           ORDER BY id DESC LIMIT $n`,
        )
        .all({ c: conversationId, n: limit, ...(beforeId ? { b: beforeId } : {}) } as never) as Message[]
    ).reverse();
  }

  /** The conversation as a client shows it: newest `limit` before `before`, oldest first, with delivery details. */
  history(conversationId: string, opts: { before?: number; limit?: number } = {}): HistoryItem[] {
    const rows = this.db
      .query(
        `SELECT m.id, m.role, m.text, m.client, m.created_at, m.reply_to, m.in_reply_to, m.reply_quote, m.reply_fallback,
                o.id AS o_id, o.seq AS o_seq, o.kind AS o_kind, o.priority AS o_priority, o.options AS o_options,
                o.text AS o_text, o.answered_at AS o_answered
         FROM messages m LEFT JOIN outbox o ON o.id = m.outbox_id
         WHERE m.conversation_id = $c ${opts.before ? "AND m.id < $b" : ""}
         ORDER BY m.id DESC LIMIT $n`,
      )
      .all({ c: conversationId, n: opts.limit ?? 50, ...(opts.before ? { b: opts.before } : {}) } as never) as HistoryRow[];
    const sent = this.files.forOutbox(rows.flatMap((r) => (r.o_id ? [r.o_id] : [])));
    const received = this.files.forMessages(rows.map((r) => r.id));
    return rows.reverse().map((r) => ({
      id: r.id,
      role: r.role,
      text: r.o_text ?? r.text,
      client: r.client,
      createdAt: r.created_at,
      replyTo: r.reply_to,
      inReplyTo: replyRef(r),
      outbox: r.o_id
        ? { id: r.o_id, seq: r.o_seq, kind: r.o_kind, priority: r.o_priority, options: r.o_options ? JSON.parse(r.o_options) : null, answered: r.o_answered != null }
        : null,
      attachments: (r.o_id ? sent.get(r.o_id) : received.get(r.id)) ?? [],
    }));
  }

  search(query: string, limit = 20): Message[] {
    const q = ftsQuery(query);
    if (!q) return [];
    return this.db
      .query(
        `SELECT messages.* FROM messages_fts JOIN messages ON messages.id = messages_fts.rowid
         WHERE messages_fts MATCH $q ORDER BY bm25(messages_fts) LIMIT $n`,
      )
      .all({ q, n: limit }) as Message[];
  }

  startEpisode(e: { kind: "chat" | "wakeup"; conversationId?: string; wakeupId?: number; model: string }, now = Date.now()): number {
    const row = this.db
      .query(
        `INSERT INTO episodes (kind, conversation_id, wakeup_id, model, started_at)
         VALUES ($k, $c, $w, $m, $now) RETURNING id`,
      )
      .get({ k: e.kind, c: e.conversationId ?? null, w: e.wakeupId ?? null, m: e.model, now }) as { id: number };
    return row.id;
  }

  /**
   * The turn is over. `sessionCostUsd` is what the brain says its session has
   * cost so far — a running total across resumed turns — so the turn's own
   * cost is how far that total climbed since the session's last turn; a
   * total that went down started counting afresh.
   */
  endEpisode(id: number, r: { session?: string; sessionCostUsd?: number; tokens?: TurnTokens; error?: string }, now = Date.now()): void {
    let cost: number | null = null;
    if (r.sessionCostUsd !== undefined) {
      const prev = r.session
        ? (this.db
            .query("SELECT session_cost_usd AS c FROM episodes WHERE brain_session = $s AND id < $id AND session_cost_usd IS NOT NULL ORDER BY id DESC LIMIT 1")
            .get({ s: r.session, id }) as { c: number } | null)
        : null;
      cost = prev && r.sessionCostUsd >= prev.c ? r.sessionCostUsd - prev.c : r.sessionCostUsd;
    }
    const t = r.tokens;
    this.db
      .query(
        `UPDATE episodes SET ended_at = $now, brain_session = $s, cost_usd = $c, session_cost_usd = $total, error = $e,
           input_tokens = $in, cache_read_tokens = $cr, cache_write_tokens = $cw, output_tokens = $out WHERE id = $id`,
      )
      .run({ now, s: r.session ?? null, c: cost, total: r.sessionCostUsd ?? null, e: r.error ?? null, in: t?.input ?? null, cr: t?.cacheRead ?? null, cw: t?.cacheWrite ?? null, out: t?.output ?? null, id });
  }

  episodeExists(id: number): boolean {
    return !!this.db.query("SELECT 1 FROM episodes WHERE id = $id").get({ id });
  }

  /** Audit: every tool call, in every mode. */
  action(episodeId: number | null, tool: string, input: unknown, now = Date.now()): void {
    this.db
      .query("INSERT INTO actions (episode_id, tool, input, at) VALUES ($e, $t, $i, $now)")
      .run({ e: episodeId, t: tool, i: input === undefined ? null : JSON.stringify(input).slice(0, 4000), now });
  }

  /** The tools an episode called, in order. */
  toolsUsed(episodeId: number): string[] {
    return (this.db.query("SELECT tool FROM actions WHERE episode_id = $e ORDER BY id").all({ e: episodeId }) as Array<{ tool: string }>).map((r) => r.tool);
  }

  actions(since: number, limit = 200): Array<{ episode_id: number | null; tool: string; input: string | null; at: number }> {
    return this.db.query("SELECT episode_id, tool, input, at FROM actions WHERE at >= $s ORDER BY id LIMIT $n").all({ s: since, n: limit }) as never;
  }

  spend(since: number): number {
    return (this.db.query("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM episodes WHERE started_at >= $s").get({ s: since }) as { c: number }).c;
  }

  /** Wakeup turns since local midnight, and what they cost. */
  wakeupsToday(tz: string, now = Date.now()): { turns: number; usd: number } {
    const r = this.db
      .query("SELECT COUNT(*) AS turns, COALESCE(SUM(cost_usd), 0) AS usd FROM episodes WHERE kind = 'wakeup' AND started_at >= $s")
      .get({ s: startOfLocalDay(now, tz) }) as { turns: number; usd: number };
    return { turns: r.turns, usd: Math.round(r.usd * 10_000) / 10_000 };
  }

  /** What thinking cost on each of the last `days` local days, today first, by what started each turn. */
  spendByDay(days: number, tz: string, now = Date.now()): SpendDay[] {
    const today = startOfLocalDay(now, tz);
    // Noon of each day names it, whatever a DST change does to its length.
    const out: SpendDay[] = Array.from({ length: days }, (_, i) => ({ date: fmtDate(today + 12 * HOUR - i * DAY, tz).slice(0, 10), usd: 0, turns: 0, byKind: {} }));
    const byDate = new Map(out.map((d) => [d.date, d]));
    const rows = this.db
      .query(
        `SELECT e.started_at AS at, e.kind AS kind, e.cost_usd AS usd, w.kind AS wkind, w.created_by AS by
         FROM episodes e LEFT JOIN wakeups w ON w.id = e.wakeup_id WHERE e.started_at >= $s`,
      )
      .all({ s: startOfLocalDay(today + 12 * HOUR - (days - 1) * DAY, tz) }) as Array<{ at: number; kind: string; usd: number | null; wkind: string | null; by: string | null }>;
    for (const r of rows) {
      const d = byDate.get(fmtDate(r.at, tz).slice(0, 10));
      if (!d) continue;
      const k = spendKind(r.kind, r.wkind, r.by);
      const b = (d.byKind[k] ??= { usd: 0, turns: 0 });
      b.usd += r.usd ?? 0;
      b.turns++;
      d.usd += r.usd ?? 0;
      d.turns++;
    }
    const cents = (n: number) => Math.round(n * 10_000) / 10_000;
    for (const d of out) {
      d.usd = cents(d.usd);
      for (const b of Object.values(d.byKind)) b.usd = cents(b.usd);
    }
    return out;
  }
}

/** The tokens one turn used: fresh input, read from the prompt cache, written to it, and output. */
export interface TurnTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** What started a turn, for spend: a chat, or a wakeup by where it came from. */
export function spendKind(kind: string, wakeupKind: string | null, createdBy: string | null): SpendKind {
  if (kind === "chat") return "chat";
  if (wakeupKind === "ritual") return "ritual";
  if (createdBy?.startsWith("event:")) return "event";
  if (createdBy?.startsWith("job:")) return "job";
  return "followup";
}

/** A message's native reply, as clients get it; null when it isn't one. */
export function replyRef(m: { in_reply_to: number | null; reply_quote: string | null; reply_fallback: string | null }): ReplyRef | null {
  if (m.in_reply_to === null && m.reply_fallback === null) return null;
  return { messageId: m.in_reply_to, quote: m.reply_quote, fallback: m.reply_fallback ? (JSON.parse(m.reply_fallback) as ReplyFallback) : null };
}
