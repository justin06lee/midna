import type { Database } from "bun:sqlite";
import { Cron } from "croner";
import type { OutboxItem, Priority } from "@midna/protocol";
import type { Bus } from "./bus.ts";
import { afterQuietHours } from "./time.ts";

/**
 * midna's own future, and what it has to say.
 *
 * Wakeups are the agent's calendar: follow-ups it scheduled for itself,
 * recurring rituals, plain reminders (delivered without waking a model) and
 * system jobs. The outbox holds everything said to the user; an item is
 * released — given a stream sequence number — once quiet hours allow it, so
 * clients replay in delivery order and never miss one that was held back.
 */

export type WakeupKind = "followup" | "ritual" | "reminder" | "system";

export interface Wakeup {
  id: number;
  due_at: number;
  reason: string;
  cron: string | null;
  kind: WakeupKind;
  status: "pending" | "running" | "done" | "cancelled" | "failed";
  created_by: string;
  created_at: number;
  fired_at: number | null;
}

export function nextCron(cron: string, tz: string, after: number): number {
  const next = new Cron(cron, { timezone: tz, paused: true }).nextRun(new Date(after));
  if (!next) throw new Error(`cron "${cron}" never fires again`);
  return next.getTime();
}

export class Schedule {
  constructor(private db: Database) {}

  add(w: { dueAt?: number; reason: string; cron?: string; kind?: WakeupKind; createdBy?: string; tz: string }, now = Date.now()): Wakeup {
    const dueAt = w.dueAt ?? (w.cron ? nextCron(w.cron, w.tz, now) : undefined);
    if (dueAt === undefined) throw new Error("a wakeup needs a time or a cron schedule");
    return this.db
      .query(
        `INSERT INTO wakeups (due_at, reason, cron, kind, created_by, created_at)
         VALUES ($due, $reason, $cron, $kind, $by, $now) RETURNING *`,
      )
      .get({ due: dueAt, reason: w.reason, cron: w.cron ?? null, kind: w.kind ?? "followup", by: w.createdBy ?? "midna", now }) as Wakeup;
  }

  get(id: number): Wakeup | null {
    return this.db.query("SELECT * FROM wakeups WHERE id = $id").get({ id }) as Wakeup | null;
  }

  pending(limit = 50): Wakeup[] {
    return this.db.query("SELECT * FROM wakeups WHERE status = 'pending' ORDER BY due_at LIMIT $n").all({ n: limit }) as Wakeup[];
  }

  /** Atomically take every due wakeup; each is returned to exactly one caller. */
  claimDue(now = Date.now()): Wakeup[] {
    return this.db
      .query("UPDATE wakeups SET status = 'running', fired_at = $now WHERE status = 'pending' AND due_at <= $now RETURNING *")
      .all({ now }) as Wakeup[];
  }

  /** A finished wakeup either ends, or — when recurring — waits for its next time. */
  finish(id: number, ok: boolean, tz: string, now = Date.now()): void {
    const w = this.get(id);
    if (!w) return;
    if (w.cron && w.status !== "cancelled") {
      this.db.query("UPDATE wakeups SET status = 'pending', due_at = $d WHERE id = $id").run({ d: nextCron(w.cron, tz, now), id });
    } else {
      this.db.query("UPDATE wakeups SET status = $s WHERE id = $id AND status = 'running'").run({ s: ok ? "done" : "failed", id });
    }
  }

  /** Give a pending or failed one-off wakeup another go at `at`. */
  reschedule(id: number, at: number): void {
    this.db.query("UPDATE wakeups SET status = 'pending', due_at = $d WHERE id = $id AND status IN ('pending','failed')").run({ d: at, id });
  }

  /** Recently failed one-off wakeups, with the error their last attempt ended in. */
  recentFailures(since: number): Array<{ id: number; error: string | null }> {
    return this.db
      .query(
        `SELECT w.id, (SELECT e.error FROM episodes e WHERE e.wakeup_id = w.id ORDER BY e.id DESC LIMIT 1) AS error
         FROM wakeups w WHERE w.status = 'failed' AND w.cron IS NULL AND w.fired_at >= $s`,
      )
      .all({ s: since }) as Array<{ id: number; error: string | null }>;
  }

  /** Try again later: back to pending, due at `until`. */
  postpone(id: number, until: number): void {
    this.db.query("UPDATE wakeups SET status = 'pending', due_at = $d WHERE id = $id AND status = 'running'").run({ d: until, id });
  }

  cancel(id: number): void {
    const r = this.db.query("UPDATE wakeups SET status = 'cancelled' WHERE id = $id AND status IN ('pending','running')").run({ id });
    if (r.changes === 0) throw new Error(`no pending wakeup with id ${id}`);
  }

  /** After a crash, whatever was mid-flight runs again. */
  recover(): number {
    return this.db.query("UPDATE wakeups SET status = 'pending' WHERE status = 'running'").run().changes;
  }

  /** Reschedule recurring wakeups after the timezone changes. */
  retime(tz: string, now = Date.now()): void {
    for (const w of this.db.query("SELECT * FROM wakeups WHERE status = 'pending' AND cron IS NOT NULL").all() as Wakeup[]) {
      this.db.query("UPDATE wakeups SET due_at = $d WHERE id = $id").run({ d: nextCron(w.cron!, tz, now), id: w.id });
    }
  }

  ritual(reason: string): Wakeup | null {
    return this.db
      .query("SELECT * FROM wakeups WHERE kind IN ('ritual','system') AND reason = $r AND status IN ('pending','running') LIMIT 1")
      .get({ r: reason }) as Wakeup | null;
  }
}

interface OutboxRow {
  id: number;
  seq: number | null;
  kind: OutboxItem["kind"];
  conversation_id: string | null;
  text: string;
  priority: Priority;
  options: string | null;
  deliver_after: number;
  created_at: number;
  answered_at: number | null;
}

function toItem(r: OutboxRow): OutboxItem {
  return {
    id: r.id,
    seq: r.seq ?? 0,
    kind: r.kind,
    conversationId: r.conversation_id,
    text: r.text,
    priority: r.priority,
    options: r.options ? (JSON.parse(r.options) as string[]) : null,
    createdAt: r.created_at,
    deliverAfter: r.deliver_after,
  };
}

export class Outbox {
  constructor(private db: Database, private bus: Bus) {}

  add(
    item: { kind: OutboxItem["kind"]; text: string; priority?: Priority; options?: string[]; conversationId?: string | null },
    when: { tz: string; quietHours: { start: string; end: string } | null },
    now = Date.now(),
  ): OutboxItem {
    const priority = item.priority ?? "normal";
    // Replies to something the user just said are never held; urgent never is.
    const held = item.kind !== "message" && priority !== "urgent";
    const deliverAfter = held ? afterQuietHours(now, when.tz, when.quietHours) : now;
    const row = this.db
      .query(
        `INSERT INTO outbox (kind, conversation_id, text, priority, options, deliver_after, created_at)
         VALUES ($k, $c, $t, $p, $o, $d, $now) RETURNING *`,
      )
      .get({
        k: item.kind,
        c: item.conversationId ?? null,
        t: item.text,
        p: priority,
        o: item.options?.length ? JSON.stringify(item.options) : null,
        d: deliverAfter,
        now,
      }) as OutboxRow;
    this.release(now);
    return this.get(row.id)!;
  }

  /** Give every item whose time has come a stream position, and announce it. */
  release(now = Date.now()): number {
    const due = this.db.query("SELECT * FROM outbox WHERE seq IS NULL AND deliver_after <= $now ORDER BY id").all({ now }) as OutboxRow[];
    for (const r of due) {
      const seq = (this.db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM outbox").get() as { s: number }).s;
      this.db.query("UPDATE outbox SET seq = $s WHERE id = $id").run({ s: seq, id: r.id });
      this.bus.emit({ type: "outbox", item: toItem({ ...r, seq }) });
    }
    return due.length;
  }

  /** Released items after stream position `since`. */
  since(since: number, limit = 200): OutboxItem[] {
    return (this.db.query("SELECT * FROM outbox WHERE seq > $s ORDER BY seq LIMIT $n").all({ s: since, n: limit }) as OutboxRow[]).map(toItem);
  }

  get(id: number): OutboxItem | null {
    const r = this.db.query("SELECT * FROM outbox WHERE id = $id").get({ id }) as OutboxRow | null;
    return r ? toItem(r) : null;
  }

  answered(id: number, now = Date.now()): void {
    this.db.query("UPDATE outbox SET answered_at = $now WHERE id = $id AND answered_at IS NULL").run({ now, id });
  }

  /** The latest stream position. */
  head(): number {
    return (this.db.query("SELECT COALESCE(MAX(seq), 0) AS s FROM outbox").get() as { s: number }).s;
  }

  held(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM outbox WHERE seq IS NULL").get() as { n: number }).n;
  }
}
