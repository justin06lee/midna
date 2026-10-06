import type { Database } from "bun:sqlite";

/**
 * The structured side of midna's mind: goals, tasks, commitments, the
 * calendar, people, decisions and notes. None of this decays — things here
 * close, finish or get dropped, and the record of that stays.
 */

export type Horizon = "life" | "years" | "year" | "quarter" | "month" | "week";
export const HORIZONS: Horizon[] = ["life", "years", "year", "quarter", "month", "week"];

export interface Goal {
  id: number;
  parent_id: number | null;
  title: string;
  why: string | null;
  horizon: Horizon;
  success: string | null;
  status: "active" | "paused" | "done" | "abandoned";
  target_at: number | null;
  review_every_days: number | null;
  last_reviewed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Task {
  id: number;
  goal_id: number | null;
  title: string;
  notes: string | null;
  status: "todo" | "doing" | "waiting" | "done" | "dropped";
  owner: "user" | "midna";
  priority: number;
  due_at: number | null;
  estimate_min: number | null;
  created_at: number;
  updated_at: number;
  done_at: number | null;
}

export interface Commitment {
  id: number;
  direction: "mine" | "theirs";
  person_id: number | null;
  counterparty: string | null;
  what: string;
  due_at: number | null;
  goal_id: number | null;
  source: string | null;
  status: "open" | "done" | "dropped";
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export interface CalendarEvent {
  id: number;
  title: string;
  starts_at: number;
  ends_at: number | null;
  all_day: number;
  location: string | null;
  notes: string | null;
  source: string;
  external_id: string | null;
  goal_id: number | null;
  status: "tentative" | "confirmed" | "cancelled";
  created_at: number;
  updated_at: number;
}

export interface Person {
  id: number;
  name: string;
  relation: string | null;
  notes: string | null;
  birthday: string | null;
  contact_every_days: number | null;
  last_contact_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Decision {
  id: number;
  title: string;
  context: string | null;
  options: string | null;
  choice: string | null;
  reasoning: string | null;
  expected: string | null;
  confidence: number | null;
  goal_id: number | null;
  review_at: number | null;
  outcome: string | null;
  lesson: string | null;
  decided_at: number | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Note {
  id: number;
  title: string;
  body: string;
  tags: string | null;
  created_at: number;
  updated_at: number;
}

type Fields<T> = Partial<Omit<T, "id" | "created_at" | "updated_at">>;

/** Insert or patch a row; only keys present in `fields` are written. */
function upsert<T>(db: Database, table: string, id: number | undefined, fields: Record<string, unknown>, now: number): T {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (id === undefined) {
    const cols = [...entries.map(([k]) => k), "created_at", "updated_at"];
    const row = db
      .query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => "$" + c).join(", ")}) RETURNING *`)
      .get({ ...Object.fromEntries(entries), created_at: now, updated_at: now } as never);
    return row as T;
  }
  const sets = [...entries.map(([k]) => `${k} = $${k}`), "updated_at = $updated_at"];
  const row = db
    .query(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = $id RETURNING *`)
    .get({ ...Object.fromEntries(entries), updated_at: now, id } as never);
  if (!row) throw new Error(`no ${table.replace(/s$/, "")} with id ${id}`);
  return row as T;
}

export class Planning {
  constructor(private db: Database) {}

  // ── goals ────────────────────────────────────────────────────────────
  saveGoal(fields: Fields<Goal>, id?: number, now = Date.now()): Goal {
    if (fields.parent_id != null && fields.parent_id === id) throw new Error("a goal can't be its own parent");
    return upsert<Goal>(this.db, "goals", id, fields, now);
  }

  /** Change a goal through renegotiation: the change and its reason are kept. */
  renegotiateGoal(id: number, fields: Fields<Goal>, reason: string, now = Date.now()): Goal {
    const before = this.goal(id);
    if (!before) throw new Error(`no goal with id ${id}`);
    const after = this.saveGoal(fields, id, now);
    const diff = Object.keys(fields)
      .filter((k) => (before as never)[k] !== (after as never)[k])
      .map((k) => `${k}: ${JSON.stringify((before as never)[k])} → ${JSON.stringify((after as never)[k])}`)
      .join("; ");
    this.db
      .query("INSERT INTO goal_changes (goal_id, change, reason, at) VALUES ($g, $c, $r, $at)")
      .run({ g: id, c: diff || "(no change)", r: reason, at: now });
    return after;
  }

  goal(id: number): Goal | null {
    return this.db.query("SELECT * FROM goals WHERE id = $id").get({ id }) as Goal | null;
  }

  goals(status: Goal["status"][] = ["active", "paused"]): Goal[] {
    return this.db
      .query(`SELECT * FROM goals WHERE status IN (${status.map((_, i) => "$s" + i).join(",")}) ORDER BY id`)
      .all(Object.fromEntries(status.map((s, i) => ["s" + i, s])) as never) as Goal[];
  }

  goalChanges(goalId: number): Array<{ change: string; reason: string; at: number }> {
    return this.db.query("SELECT change, reason, at FROM goal_changes WHERE goal_id = $g ORDER BY at").all({ g: goalId }) as never;
  }

  // ── tasks ────────────────────────────────────────────────────────────
  saveTask(fields: Fields<Task>, id?: number, now = Date.now()): Task {
    const f: Record<string, unknown> = { ...fields };
    if (fields.status === "done" || fields.status === "dropped") f.done_at = now;
    else if (fields.status) f.done_at = null;
    return upsert<Task>(this.db, "tasks", id, f, now);
  }

  tasks(filter: { status?: Task["status"][]; goalId?: number; owner?: Task["owner"] } = {}): Task[] {
    const status = filter.status ?? ["todo", "doing", "waiting"];
    const where = [`status IN (${status.map((_, i) => "$s" + i).join(",")})`];
    const params: Record<string, unknown> = Object.fromEntries(status.map((s, i) => ["s" + i, s]));
    if (filter.goalId !== undefined) {
      where.push("goal_id = $goal");
      params.goal = filter.goalId;
    }
    if (filter.owner) {
      where.push("owner = $owner");
      params.owner = filter.owner;
    }
    return this.db
      .query(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY due_at IS NULL, due_at, priority, id`)
      .all(params as never) as Task[];
  }

  // ── commitments ──────────────────────────────────────────────────────
  saveCommitment(fields: Fields<Commitment>, id?: number, now = Date.now()): Commitment {
    const f: Record<string, unknown> = { ...fields };
    if (fields.status === "done" || fields.status === "dropped") f.closed_at = now;
    return upsert<Commitment>(this.db, "commitments", id, f, now);
  }

  commitments(status: Commitment["status"][] = ["open"]): Commitment[] {
    return this.db
      .query(
        `SELECT * FROM commitments WHERE status IN (${status.map((_, i) => "$s" + i).join(",")})
         ORDER BY due_at IS NULL, due_at, id`,
      )
      .all(Object.fromEntries(status.map((s, i) => ["s" + i, s])) as never) as Commitment[];
  }

  // ── calendar ─────────────────────────────────────────────────────────
  saveEvent(fields: Fields<CalendarEvent>, id?: number, now = Date.now()): CalendarEvent {
    return upsert<CalendarEvent>(this.db, "events", id, fields, now);
  }

  /** Events overlapping [from, to), cancelled ones left out. */
  events(from: number, to: number): CalendarEvent[] {
    return this.db
      .query(
        `SELECT * FROM events WHERE status != 'cancelled'
           AND starts_at < $to AND COALESCE(ends_at, starts_at) >= $from
         ORDER BY starts_at`,
      )
      .all({ from, to }) as CalendarEvent[];
  }

  // ── people ───────────────────────────────────────────────────────────
  savePerson(fields: Fields<Person>, id?: number, now = Date.now()): Person {
    return upsert<Person>(this.db, "people", id, fields, now);
  }

  person(id: number): Person | null {
    return this.db.query("SELECT * FROM people WHERE id = $id").get({ id }) as Person | null;
  }

  findPeople(query: string): Person[] {
    return this.db
      .query("SELECT * FROM people WHERE name LIKE $q OR relation LIKE $q OR notes LIKE $q ORDER BY name LIMIT 20")
      .all({ q: `%${query}%` }) as Person[];
  }

  /** People whose contact cadence has lapsed. */
  overdueContacts(now = Date.now()): Person[] {
    return this.db
      .query(
        `SELECT * FROM people WHERE contact_every_days IS NOT NULL
           AND (last_contact_at IS NULL OR last_contact_at + contact_every_days * 86400000 < $now)
         ORDER BY last_contact_at`,
      )
      .all({ now }) as Person[];
  }

  // ── decisions ────────────────────────────────────────────────────────
  saveDecision(fields: Fields<Decision>, id?: number, now = Date.now()): Decision {
    return upsert<Decision>(this.db, "decisions", id, fields, now);
  }

  decisions(filter: { dueForReview?: number; limit?: number } = {}): Decision[] {
    if (filter.dueForReview !== undefined) {
      return this.db
        .query("SELECT * FROM decisions WHERE reviewed_at IS NULL AND review_at IS NOT NULL AND review_at <= $now ORDER BY review_at")
        .all({ now: filter.dueForReview }) as Decision[];
    }
    return this.db.query("SELECT * FROM decisions ORDER BY id DESC LIMIT $n").all({ n: filter.limit ?? 20 }) as Decision[];
  }

  // ── notes ────────────────────────────────────────────────────────────
  saveNote(fields: Fields<Note>, id?: number, now = Date.now()): Note {
    return upsert<Note>(this.db, "notes", id, fields, now);
  }

  note(id: number): Note | null {
    return this.db.query("SELECT * FROM notes WHERE id = $id").get({ id }) as Note | null;
  }

  searchNotes(query: string, limit = 10): Note[] {
    const q = ftsQuery(query);
    if (!q) return this.db.query("SELECT * FROM notes ORDER BY updated_at DESC LIMIT $n").all({ n: limit }) as Note[];
    return this.db
      .query(
        `SELECT notes.* FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid
         WHERE notes_fts MATCH $q ORDER BY bm25(notes_fts) LIMIT $n`,
      )
      .all({ q, n: limit }) as Note[];
  }
}

/** Free text → an FTS5 query that matches any of its words. */
export function ftsQuery(text: string): string {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);
  return [...new Set(words)].map((w) => `"${w}"*`).join(" OR ");
}
