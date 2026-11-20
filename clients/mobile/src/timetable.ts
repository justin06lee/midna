import type { CalendarBlock } from "@midna/protocol";

/**
 * The day as a timetable: midna's blocks (and any other calendar's events)
 * in order, which one is on now and which comes next. A day midna has
 * planned is shown once it is confirmed: today always (a tentative block is
 * marked as such), tomorrow only once the user has approved it, before
 * which it is only counted.
 */

export type BlockState = "past" | "now" | "later";

export interface Row {
  id: number;
  title: string;
  start: number;
  /** null: a moment, not a span. */
  end: number | null;
  place: string | null;
  /** Not midna's own: the calendar it came from. */
  from: string | null;
  /** Planned but not yet approved. */
  tentative: boolean;
  state: BlockState;
  next: boolean;
}

/** Time nobody planned, between two blocks, long enough to show. */
export interface Gap {
  gap: true;
  start: number;
  end: number;
}

export interface Day {
  /** Local midnight. */
  date: number;
  allDay: Row[];
  rows: Array<Row | Gap>;
}

export interface Timetable {
  today: Day;
  /** Tomorrow's approved blocks; null until any are. */
  tomorrow: Day | null;
  /** Tomorrow's blocks still waiting for the user's OK. */
  waiting: number;
  now: Row | null;
  next: Row | null;
}

/** A gap shorter than this sits unremarked between two blocks. */
const SHOWN_GAP = 30 * 60_000;

/** Local midnight of the day `at` falls in, and `days` after it. */
export function midnight(at: number, days = 0): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

const endOf = (b: { starts_at: number; ends_at: number | null }) => b.ends_at ?? b.starts_at;

function day(blocks: CalendarBlock[], date: number, now: number): Day {
  const end = midnight(date, 1);
  // Overlapping the day: a span that ends after its midnight, or a moment within it.
  const mine = blocks.filter((b) => b.starts_at < end && (b.ends_at === null ? b.starts_at >= date : b.ends_at > date));
  const row = (b: CalendarBlock): Row => ({
    id: b.id,
    title: b.title,
    start: b.starts_at,
    end: b.ends_at,
    place: b.location,
    from: b.source === "midna" ? null : b.source,
    tentative: b.status === "tentative",
    // A moment is never "on": it has passed or it hasn't.
    state: b.starts_at > now ? "later" : b.ends_at !== null && b.ends_at > now ? "now" : "past",
    next: false,
  });
  const timed = mine.filter((b) => !b.all_day).sort((a, b) => a.starts_at - b.starts_at || endOf(a) - endOf(b)).map(row);
  const rows: Array<Row | Gap> = [];
  let reached: number | null = null;
  for (const r of timed) {
    if (reached !== null && r.start - reached >= SHOWN_GAP) rows.push({ gap: true, start: reached, end: r.start });
    rows.push(r);
    reached = Math.max(reached ?? 0, r.end ?? r.start);
  }
  return { date, allDay: mine.filter((b) => b.all_day).map(row), rows };
}

const isRow = (r: Row | Gap): r is Row => !("gap" in r);

/** Today's and tomorrow's blocks, from what the host returns for [today's midnight, the day after tomorrow's). */
export function timetable(blocks: CalendarBlock[], now = Date.now()): Timetable {
  const today = day(blocks, midnight(now), now);
  const tomorrowAll = day(blocks, midnight(now, 1), now);
  const approved = tomorrowAll.rows.filter(isRow).some((r) => !r.tentative) || tomorrowAll.allDay.some((r) => !r.tentative);
  const waiting = tomorrowAll.rows.filter(isRow).filter((r) => r.tentative).length;
  const tomorrow = approved
    ? { ...tomorrowAll, rows: tomorrowAll.rows.filter((r) => !isRow(r) || !r.tentative), allDay: tomorrowAll.allDay.filter((r) => !r.tentative) }
    : null;
  // Of blocks that overlap, the one begun last is the one on now.
  const current = today.rows.filter(isRow).filter((r) => r.state === "now" && r.end !== null);
  const now_ = current.length ? current[current.length - 1]! : null;
  const ahead = [...today.rows, ...(tomorrow?.rows ?? [])].filter(isRow).filter((r) => r.state === "later");
  const next = ahead[0] ?? null;
  if (next) next.next = true;
  return { today, tomorrow, waiting: approved ? 0 : waiting, now: now_, next };
}

/** "10:30" in the phone's own clock style. */
export const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "45 min", "1 h", "2 h 30 min". */
export function span(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}
