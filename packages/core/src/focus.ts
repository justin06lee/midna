import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { DEFAULT_FOCUS_RULES, type FocusLift, type FocusLiftAsk, type FocusReport, type FocusRules, type FocusRulesPatch, type FocusState } from "@midna/protocol";

/**
 * Screen Time's records: the rules midna holds for the phone, each day the
 * phone reported (minutes in the held apps, shields met), every lift with its
 * reason, and how Screen Time stood on the phone when it last said.
 * Sending the rules to the phone is the daemon's.
 */
export class Focus {
  constructor(private readonly db: Database) {}

  private get<T>(key: string): T | undefined {
    const row = this.db.query("SELECT value FROM settings WHERE key = $k").get({ k: `state:${key}` }) as { value: string } | null;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  private set(key: string, value: unknown): void {
    this.db.query("INSERT INTO settings (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = $v").run({ k: `state:${key}`, v: JSON.stringify(value) });
  }

  rules(): FocusRules {
    return { ...DEFAULT_FOCUS_RULES, ...this.get<FocusRules>("focus.rules") };
  }

  /** Change the rules; a hold let go drops its end. */
  setRules(patch: FocusRulesPatch, now = Date.now()): FocusRules {
    const next: FocusRules = { ...this.rules(), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), updatedAt: now };
    if (!next.held) next.heldUntil = null;
    this.set("focus.rules", next);
    return next;
  }

  /** Lift the shield, kept with its reason; the rules carry it to the phone. */
  lift(ask: FocusLiftAsk, by: FocusLift["by"], now = Date.now()): FocusRules {
    const lift: FocusLift = { id: `lift_${randomBytes(6).toString("hex")}`, minutes: ask.minutes, reason: ask.reason.trim(), by, at: now };
    this.db.query("INSERT INTO focus_lifts (id, minutes, reason, by, at) VALUES ($id, $minutes, $reason, $by, $at)").run({ ...lift });
    const next: FocusRules = { ...this.rules(), lift, updatedAt: now };
    if (ask.endHold) Object.assign(next, { held: false, heldUntil: null });
    this.set("focus.rules", next);
    return next;
  }

  /** The phone's report: each day as it now stands (a later report of a day replaces an earlier one), and the phone's state. */
  report(r: FocusReport, now = Date.now()): void {
    const day = this.db.query(
      `INSERT INTO focus_days (day, minutes, hits, reported_at) VALUES ($day, $minutes, $hits, $now)
       ON CONFLICT(day) DO UPDATE SET minutes = $minutes, hits = $hits, reported_at = $now`,
    );
    this.db.transaction(() => {
      for (const d of r.days) day.run({ day: d.day, minutes: d.minutes, hits: d.hits, now });
      const { days: _, ...phone } = r;
      this.set("focus.phone", { ...phone, reportedAt: now });
    })();
  }

  /** When the phone last reported, or 0. */
  reportedAt(): number {
    return this.get<{ reportedAt: number }>("focus.phone")?.reportedAt ?? 0;
  }

  /** The rules, the last `days` days reported, the lifts in them, and the phone. */
  state(days = 7, now = Date.now()): FocusState {
    const since = now - days * 86_400_000;
    return {
      rules: this.rules(),
      days: (this.db.query("SELECT day, minutes, hits, reported_at AS reportedAt FROM focus_days ORDER BY day DESC LIMIT $n").all({ n: days }) as FocusState["days"]).reverse(),
      lifts: this.db.query("SELECT id, minutes, reason, by, at FROM focus_lifts WHERE at >= $since ORDER BY at").all({ since }) as FocusLift[],
      phone: this.get<FocusState["phone"]>("focus.phone") ?? null,
    };
  }
}
