import type { Database } from "bun:sqlite";
import type { Mode } from "@midna/protocol";
import { Attachments } from "./attachments.ts";
import { Bus } from "./bus.ts";
import { openDatabase } from "./db.ts";
import { Devices } from "./devices.ts";
import { Hands } from "./hands.ts";
import { Inbound } from "./inbound.ts";
import { Jobs } from "./jobs.ts";
import { Log, MAIN } from "./log.ts";
import { Memory } from "./memory.ts";
import { Planning } from "./planning.ts";
import { Outbox, Schedule } from "./schedule.ts";

export interface Settings {
  /** What the user calls the assistant. */
  name: string;
  /** "autonomous" acts without asking; "ask" routes outward actions for approval. */
  mode: Mode;
  /** yagami model ref: "claude:opus", "codex:gpt-5.6-sol", "gemini", … */
  model: string;
  timezone: string;
  /** Non-urgent notifications wait until this window ends. */
  quietHours: { start: string; end: string } | null;
  /** Local times of the daily rituals, as cron expressions. */
  rituals: { morning: string | null; evening: string | null; weekly: string | null };
  /** "paused" stops every device's hands at once, whatever each app says. */
  hands: "on" | "paused";
  /** Past this many wakeup turns, or this much spent on them, in a local day, midna is told it's over; null for no budget. */
  wakeupBudget: { turns: number; usd: number } | null;
}

export const DEFAULT_SETTINGS: Settings = {
  name: "midna",
  mode: "autonomous",
  model: "claude:opus",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  quietHours: { start: "23:00", end: "08:00" },
  rituals: { morning: "0 8 * * *", evening: "0 21 * * *", weekly: "0 18 * * 0" },
  hands: "on",
  wakeupBudget: { turns: 60, usd: 20 },
};

/** Everything midna knows, in one SQLite file. */
export class Store {
  readonly bus = new Bus();
  readonly planning: Planning;
  readonly memory: Memory;
  readonly log: Log;
  readonly schedule: Schedule;
  readonly outbox: Outbox;
  readonly devices: Devices;
  readonly attachments: Attachments;
  readonly inbound: Inbound;
  readonly hands: Hands;
  readonly jobs: Jobs;

  constructor(readonly db: Database) {
    this.planning = new Planning(db);
    this.memory = new Memory(db);
    this.attachments = new Attachments(db);
    this.log = new Log(db, this.attachments);
    this.schedule = new Schedule(db);
    this.outbox = new Outbox(db, this.bus, this.attachments);
    this.devices = new Devices(db);
    this.inbound = new Inbound(db, this.schedule);
    this.hands = new Hands(db);
    this.jobs = new Jobs(db, this.schedule);
  }

  static open(path: string): Store {
    return new Store(openDatabase(path));
  }

  settings(): Settings {
    const rows = this.db.query("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const stored = Object.fromEntries(rows.filter((r) => !r.key.includes(":")).map((r) => [r.key, JSON.parse(r.value)]));
    return { ...DEFAULT_SETTINGS, ...stored } as Settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const stmt = this.db.query("INSERT INTO settings (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = $v");
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) stmt.run({ k, v: JSON.stringify(v) });
    return this.settings();
  }

  /** midna's own bookkeeping, kept beside the settings but never shown as one. */
  state<T>(key: string): T | undefined {
    const row = this.db.query("SELECT value FROM settings WHERE key = $k").get({ k: `state:${key}` }) as { value: string } | null;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setState(key: string, value: unknown): void {
    this.db.query("INSERT INTO settings (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = $v").run({ k: `state:${key}`, v: JSON.stringify(value) });
  }

  /** True exactly once per key, for one-time setup steps. */
  firstTime(key: string): boolean {
    return this.db.query("INSERT OR IGNORE INTO settings (key, value) VALUES ($k, 'true')").run({ k: `once:${key}` }).changes === 1;
  }

  /** Say something to the user, honouring quiet hours for non-urgent news. */
  tell(item: Parameters<Outbox["add"]>[0], now = Date.now()) {
    const s = this.settings();
    return this.outbox.add(item, { tz: s.timezone, quietHours: s.quietHours }, now);
  }

  /**
   * Say something to the user and record it in the conversation, linked to
   * its delivery. `seenByBrain` is false when the chat brain hasn't heard it
   * (a wakeup said it), so the next chat turn is told. `logText` is what the
   * brain reads back, when that should differ from what the user sees; the
   * names of any attachments are added to it, so the brain knows what it sent.
   */
  say(
    item: Parameters<Outbox["add"]>[0],
    record: { client: string; seenByBrain: boolean; logText?: string },
    now = Date.now(),
  ) {
    const sent = this.tell(item, now);
    const files = sent.attachments.length ? `[sent with it: ${sent.attachments.map((a) => a.name).join(", ")}]` : "";
    const text = [record.logText ?? item.text, files].filter(Boolean).join("\n");
    this.log.addMessage({ conversationId: item.conversationId ?? MAIN, role: "midna", text, client: record.client, seen: record.seenByBrain, outboxId: sent.id }, now);
    return sent;
  }

  close(): void {
    this.db.close();
  }
}
