/** Screen Time's words and times, kept free of Expo so they can be tested under bun. */

/** A daily window that holds the apps, in minutes after midnight; one that ends before it starts runs past midnight. */
export interface Window {
  start: number;
  end: number;
}

/** Quarter-hour minutes as Justin reads them: "45 min", "1 h 30". */
export function minutes(m: number): string {
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}` : ""}`;
}

/** "21:30" for minutes after midnight. */
export const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** "21:00-23:30" (or "21:00–23:30", "9:00 - 11:00") as a window; null when it isn't one. */
export function parseWindow(text: string): Window | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const [h1, m1, h2, m2] = m.slice(1).map(Number) as [number, number, number, number];
  if (h1 > 23 || h2 > 24 || m1 > 59 || m2 > 59) return null;
  const start = h1 * 60 + m1;
  const end = Math.min(h2 * 60 + m2, 23 * 60 + 59);
  return start === end ? null : { start, end };
}
