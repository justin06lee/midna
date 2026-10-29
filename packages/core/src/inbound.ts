import type { Database } from "bun:sqlite";
import type { EventKept } from "@midna/protocol";
import type { Schedule } from "./schedule.ts";

/**
 * Events from other programs — ruri saying a project went idle, a CI job
 * finishing — that midna hears in the background, on its own time: each is
 * delivered by a wakeup, never as something the user said. The same id
 * from the same source is one event. A source gets at most one wakeup per
 * subject (ruri: per project) in each window; what arrives meanwhile joins
 * the wakeup still waiting, so midna hears it all at once.
 */

export interface InboundEvent {
  id: number;
  source: string;
  ext_id: string | null;
  subject: string;
  kind: string | null;
  title: string;
  /** The sender's JSON, as sent. */
  data: string | null;
  wakeup_id: number;
  received_at: number;
}

export class Inbound {
  constructor(private db: Database, private schedule: Schedule) {}

  add(
    e: { source: string; title: string; extId?: string; subject?: string; kind?: string; data?: string; windowMs: number; tz: string },
    now = Date.now(),
  ): EventKept {
    return this.db.transaction((): EventKept => {
      if (e.extId) {
        const dup = this.db.query("SELECT id, wakeup_id FROM inbound_events WHERE source = $s AND ext_id = $x").get({ s: e.source, x: e.extId }) as { id: number; wakeup_id: number } | null;
        if (dup) return { status: "duplicate", eventId: dup.id, wakeupId: dup.wakeup_id };
      }
      const key = { s: e.source, sub: e.subject ?? "" };
      // The subject's wakeup that hasn't run yet takes this one too.
      const waiting = this.db
        .query(
          `SELECT w.id, w.due_at FROM wakeups w WHERE w.status = 'pending'
           AND w.id IN (SELECT wakeup_id FROM inbound_events WHERE source = $s AND subject = $sub) ORDER BY w.id DESC LIMIT 1`,
        )
        .get(key) as { id: number; due_at: number } | null;
      let wakeup: { id: number; due_at: number };
      if (waiting) wakeup = waiting;
      else {
        // Otherwise a new one, a window after the last one ran.
        const last = this.db
          .query(`SELECT MAX(COALESCE(fired_at, due_at)) AS at FROM wakeups WHERE id IN (SELECT wakeup_id FROM inbound_events WHERE source = $s AND subject = $sub)`)
          .get(key) as { at: number | null };
        const dueAt = last.at === null ? now : Math.max(now, last.at + e.windowMs);
        wakeup = this.schedule.add({ dueAt, reason: `${e.source}: ${e.title}`, kind: "followup", createdBy: `event:${e.source}`, tz: e.tz }, now);
      }
      const { id } = this.db
        .query(
          `INSERT INTO inbound_events (source, ext_id, subject, kind, title, data, wakeup_id, received_at)
           VALUES ($s, $x, $sub, $k, $t, $d, $w, $now) RETURNING id`,
        )
        .get({ ...key, x: e.extId ?? null, k: e.kind ?? null, t: e.title, d: e.data ?? null, w: wakeup.id, now }) as { id: number };
      if (waiting) {
        const n = (this.db.query("SELECT COUNT(*) AS n FROM inbound_events WHERE wakeup_id = $w").get({ w: wakeup.id }) as { n: number }).n;
        this.db.query("UPDATE wakeups SET reason = $r WHERE id = $w").run({ r: `${e.source}: ${n} events, the latest "${e.title}"`, w: wakeup.id });
      }
      return { status: waiting ? "merged" : "queued", eventId: id, wakeupId: wakeup.id, dueAt: wakeup.due_at };
    })();
  }

  /** What a wakeup delivers, in the order it arrived. */
  forWakeup(wakeupId: number): InboundEvent[] {
    return this.db.query("SELECT * FROM inbound_events WHERE wakeup_id = $w ORDER BY id").all({ w: wakeupId }) as InboundEvent[];
  }

  /** Forget events received before `before`; their ids may come again after that. */
  prune(before: number): number {
    return this.db.query("DELETE FROM inbound_events WHERE received_at < $b AND wakeup_id IN (SELECT id FROM wakeups WHERE status NOT IN ('pending','running'))").run({ b: before }).changes;
  }
}
