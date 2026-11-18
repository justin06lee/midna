import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { ALARM_GRACE_MS, MAX_ALARMS, type Alarm, type AlarmPhone, type AlarmReport } from "@midna/protocol";
import { DAY, nextLocalTime, parseHHMM } from "./time.ts";

type Row = { id: string; label: string; at: number | null; time: string | null; days: string; created_at: number; updated_at: number };
const alarm = (r: Row): Alarm => ({ id: r.id, label: r.label, at: r.at, time: r.time, days: JSON.parse(r.days) as number[], updatedAt: r.updated_at });

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

/** When an alarm rings next, ms; null for a one-off that has rung. A recurring one is read on the clock of `tz`. */
export function nextRing(a: Alarm, tz: string, now = Date.now()): number | null {
  if (a.at !== null) return a.at > now ? a.at : null;
  return nextLocalTime(parseHHMM(a.time!), a.days, tz, now);
}

/**
 * The alarms midna sets on the user's phone, and what each phone last said
 * iOS holds. Ringing is the phone's; this is the list it is given.
 */
export class Alarms {
  constructor(private readonly db: Database) {}

  /**
   * The alarms the phone should hold: recurring ones, and one-offs still to
   * ring or rung within the hour (a sync while one rings must not take it
   * away). One-offs a day past are forgotten.
   */
  list(now = Date.now()): Alarm[] {
    this.db.query("DELETE FROM alarms WHERE at IS NOT NULL AND at < $old").run({ old: now - DAY });
    const rows = this.db.query("SELECT * FROM alarms WHERE at IS NULL OR at > $since ORDER BY created_at, id").all({ since: now - ALARM_GRACE_MS }) as Row[];
    return rows.map(alarm);
  }

  get(id: string): Alarm | null {
    const r = this.db.query("SELECT * FROM alarms WHERE id = $id").get({ id: id.toLowerCase() }) as Row | null;
    return r ? alarm(r) : null;
  }

  /**
   * Set an alarm, or with `id` change one. One that would ring exactly when
   * another does is that one, relabelled: two alarms at once are one alarm.
   * Throws with words for whoever asked.
   */
  set(a: { id?: string; label: string; at?: number; time?: string; days?: number[] }, now = Date.now()): Alarm {
    const label = a.label.trim();
    if (!label) throw new Error("an alarm needs a label");
    if ((a.at === undefined) === (a.time === undefined)) throw new Error("an alarm rings once (at) or repeats (time), not both");
    if (a.at !== undefined && a.at <= now) throw new Error("that time has passed");
    const days = a.time === undefined ? [] : [...new Set(a.days?.length ? a.days : EVERY_DAY)].sort((x, y) => x - y);
    const fields = { label, at: a.at ?? null, time: a.time ?? null, days: JSON.stringify(days), now };
    const current = this.list(now);
    const same = current.find((x) => x.at === fields.at && x.time === fields.time && JSON.stringify(x.days) === fields.days);
    const id = a.id?.toLowerCase() ?? same?.id;
    if (a.id !== undefined && !this.get(a.id)) throw new Error(`no alarm ${a.id}`);
    if (id === undefined) {
      if (current.filter((x) => nextRingable(x, now)).length >= MAX_ALARMS) throw new Error(`there are ${MAX_ALARMS} alarms already: cancel one first`);
      const made = randomUUID();
      this.db.query("INSERT INTO alarms (id, label, at, time, days, created_at, updated_at) VALUES ($id, $label, $at, $time, $days, $now, $now)").run({ id: made, ...fields });
      return this.get(made)!;
    }
    // A change that changes nothing keeps its version: the phone has it already.
    const was = this.get(id)!;
    if (was.label !== label || was.at !== fields.at || was.time !== fields.time || JSON.stringify(was.days) !== fields.days) {
      // Never the same version twice, even within one millisecond.
      this.db.query("UPDATE alarms SET label = $label, at = $at, time = $time, days = $days, updated_at = $now WHERE id = $id").run({ id, ...fields, now: Math.max(now, was.updatedAt + 1) });
    }
    return this.get(id)!;
  }

  cancel(id: string): Alarm | null {
    const was = this.get(id);
    if (was) this.db.query("DELETE FROM alarms WHERE id = $id").run({ id: was.id });
    return was;
  }

  /** What a phone says iOS holds now; its last word replaces the one before. */
  report(deviceId: string, r: AlarmReport, now = Date.now()): void {
    this.db
      .query(
        `INSERT INTO alarm_phones (device_id, authorization, scheduled, problems, reported_at) VALUES ($d, $a, $s, $p, $now)
         ON CONFLICT(device_id) DO UPDATE SET authorization = $a, scheduled = $s, problems = $p, reported_at = $now`,
      )
      .run({ d: deviceId, a: r.authorization, s: JSON.stringify(r.scheduled), p: JSON.stringify(r.problems ?? []), now });
  }

  /** Each paired phone's last report. */
  phones(): AlarmPhone[] {
    const rows = this.db
      .query(
        `SELECT p.device_id, d.name, p.authorization, p.scheduled, p.problems, p.reported_at
         FROM alarm_phones p JOIN devices d ON d.id = p.device_id WHERE d.revoked_at IS NULL ORDER BY p.reported_at DESC`,
      )
      .all() as Array<{ device_id: string; name: string; authorization: AlarmPhone["authorization"]; scheduled: string; problems: string; reported_at: number }>;
    return rows.map((r) => ({ device: r.device_id, name: r.name, authorization: r.authorization, scheduled: JSON.parse(r.scheduled), problems: JSON.parse(r.problems), reportedAt: r.reported_at }));
  }
}

/** Still to ring: a recurring alarm, or a one-off ahead. */
const nextRingable = (a: Alarm, now: number) => a.at === null || a.at > now;
