import type { Database } from "bun:sqlite";
import type { HistoryItem } from "@midna/protocol";
import { ftsQuery } from "./planning.ts";

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
  o_id: number | null;
  o_seq: number | null;
  o_kind: "message" | "notification" | "question";
  o_priority: "urgent" | "normal" | "fyi";
  o_options: string | null;
  o_text: string | null;
  o_answered: number | null;
}

export class Log {
  constructor(private db: Database) {}

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
    m: { conversationId: string; role: Message["role"]; text: string; client?: string; seen: boolean; outboxId?: number; replyTo?: number },
    now = Date.now(),
  ): Message {
    this.conversation(m.conversationId, now);
    this.db.query("UPDATE conversations SET last_active_at = $now WHERE id = $id").run({ now, id: m.conversationId });
    return this.db
      .query(
        `INSERT INTO messages (conversation_id, role, text, client, seen_by_brain, outbox_id, reply_to, created_at)
         VALUES ($c, $role, $text, $client, $seen, $o, $r, $now) RETURNING *`,
      )
      .get({ c: m.conversationId, role: m.role, text: m.text, client: m.client ?? null, seen: m.seen ? 1 : 0, o: m.outboxId ?? null, r: m.replyTo ?? null, now }) as Message;
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
        `SELECT m.id, m.role, m.text, m.client, m.created_at, m.reply_to,
                o.id AS o_id, o.seq AS o_seq, o.kind AS o_kind, o.priority AS o_priority, o.options AS o_options,
                o.text AS o_text, o.answered_at AS o_answered
         FROM messages m LEFT JOIN outbox o ON o.id = m.outbox_id
         WHERE m.conversation_id = $c ${opts.before ? "AND m.id < $b" : ""}
         ORDER BY m.id DESC LIMIT $n`,
      )
      .all({ c: conversationId, n: opts.limit ?? 50, ...(opts.before ? { b: opts.before } : {}) } as never) as HistoryRow[];
    return rows.reverse().map((r) => ({
      id: r.id,
      role: r.role,
      text: r.o_text ?? r.text,
      client: r.client,
      createdAt: r.created_at,
      replyTo: r.reply_to,
      outbox: r.o_id
        ? { id: r.o_id, seq: r.o_seq, kind: r.o_kind, priority: r.o_priority, options: r.o_options ? JSON.parse(r.o_options) : null, answered: r.o_answered != null }
        : null,
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

  endEpisode(id: number, r: { session?: string; costUsd?: number; error?: string }, now = Date.now()): void {
    this.db
      .query("UPDATE episodes SET ended_at = $now, brain_session = $s, cost_usd = $c, error = $e WHERE id = $id")
      .run({ now, s: r.session ?? null, c: r.costUsd ?? null, e: r.error ?? null, id });
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

  actions(since: number, limit = 200): Array<{ episode_id: number | null; tool: string; input: string | null; at: number }> {
    return this.db.query("SELECT episode_id, tool, input, at FROM actions WHERE at >= $s ORDER BY id LIMIT $n").all({ s: since, n: limit }) as never;
  }

  spend(since: number): number {
    return (this.db.query("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM episodes WHERE started_at >= $s").get({ s: since }) as { c: number }).c;
  }
}
