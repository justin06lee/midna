/** Time is stored as epoch milliseconds and shown in the user's timezone. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

function parts(ms: number, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(ms))) {
    out[p.type] = p.value;
  }
  return out;
}

/** How far `tz` is ahead of UTC at instant `ms`, in milliseconds. */
export function tzOffset(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time in `tz` → epoch ms. */
export function fromLocal(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ms = guess - tzOffset(guess, tz);
  // A second pass settles the instant when the guess straddled a DST change.
  ms = guess - tzOffset(ms, tz);
  return ms;
}

/** "2026-10-01 Thu 14:03" in the user's timezone. */
export function fmt(ms: number | null | undefined, tz: string): string {
  if (ms == null) return "";
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day} ${p.weekday} ${p.hour}:${p.minute}`;
}

export function fmtDate(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day} ${p.weekday}`;
}

/** Minutes since local midnight. */
export function localMinutes(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return +p.hour! * 60 + +p.minute!;
}

export function startOfLocalDay(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return fromLocal(+p.year!, +p.month!, +p.day!, 0, 0, tz);
}

/**
 * Parse a time the agent or user wrote. Accepts ISO 8601 with an offset or Z,
 * local "YYYY-MM-DD", "YYYY-MM-DD HH:mm" / "YYYY-MM-DDTHH:mm" (in `tz`), and
 * relative "+30m", "+2h", "+3d", "+1w".
 */
export function parseWhen(input: string, tz: string, now = Date.now()): number {
  const s = input.trim();
  const rel = /^\+(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const per = unit.startsWith("m") ? MINUTE : unit === "h" ? HOUR : unit === "d" ? DAY : 7 * DAY;
    return Math.round(now + n * per);
  }
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return ms;
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s);
  if (local) {
    const [, y, mo, d, h, mi] = local;
    return fromLocal(+y!, +mo!, +d!, h ? +h : 0, mi ? +mi : 0, tz);
  }
  throw new Error(`can't read "${input}" as a time — use ISO 8601 ("2026-10-02 09:30" local, or with an offset) or "+2h"`);
}

export function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`expected HH:MM, got "${s}"`);
  return +m[1]! * 60 + +m[2]!;
}

/** When a message sent now may buzz the user, given quiet hours. */
export function afterQuietHours(now: number, tz: string, quiet: { start: string; end: string } | null): number {
  if (!quiet) return now;
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start === end) return now;
  const cur = localMinutes(now, tz);
  const inside = start < end ? cur >= start && cur < end : cur >= start || cur < end;
  if (!inside) return now;
  const wait = (end - cur + 1440) % 1440;
  return now - (now % MINUTE) + wait * MINUTE;
}
