/**
 * The phone's side of location, kept free of Expo so it can be tested under
 * bun: what iOS hands the background tasks, turned into fixes for midna; the
 * fixes waiting for a connection; which arrivals and departures are news;
 * and the geofences that match the saved places.
 */
import type { LocationFix, Place } from "@midna/protocol";

/** What iOS hands the location task, one entry per fix (modules/midna-location); expo-location's fixes have no source. */
export interface TaskLocation {
  coords: { latitude: number; longitude: number; accuracy?: number | null; altitude?: number | null; speed?: number | null };
  timestamp: number;
  source?: "precise" | "significant" | "requested";
}

const TASK_SOURCES = new Set(["precise", "significant", "requested"]);

/** Fixes that wait past this many are dropped oldest first: a phone off the network for weeks still keeps the latest. */
export const QUEUE_MAX = 5_000;
/** A report carries at most this many; the rest go in the next. */
export const REPORT_MAX = 500;

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function fromTask(locations: TaskLocation[]): LocationFix[] {
  return locations
    .filter((l) => Number.isFinite(l.coords.latitude) && Number.isFinite(l.coords.longitude) && l.timestamp > 0)
    .map((l) => ({
      at: Math.round(l.timestamp),
      lat: l.coords.latitude,
      lon: l.coords.longitude,
      accuracy: n(l.coords.accuracy),
      altitude: n(l.coords.altitude),
      speed: n(l.coords.speed) !== null && l.coords.speed! >= 0 ? l.coords.speed! : null,
      source: l.source && TASK_SOURCES.has(l.source) ? l.source : ("significant" as const),
    }));
}

/**
 * Precise fixes come every 30 m while the phone moves (about once a second
 * in a car), so they're sent together, at most this often; anything else
 * (an arrival, midna asking, the app opening) goes at once, and so does
 * what waits when the updates pause.
 */
export const SEND_EVERY_MS = 60_000;

/** Whether to send now what waits, `fixes` just added. */
export const sendNow = (fixes: LocationFix[], lastSent: number | null, now: number): boolean =>
  fixes.some((f) => f.source !== "precise") || lastSent === null || now - lastSent >= SEND_EVERY_MS;

/** Add fixes to the queue, oldest first, the same one (time and source) only once, at most QUEUE_MAX. */
export function enqueue(queue: LocationFix[], fixes: LocationFix[]): LocationFix[] {
  const seen = new Set(queue.map((f) => `${f.at}:${f.source}`));
  const next = [...queue];
  for (const f of fixes) {
    const k = `${f.at}:${f.source}`;
    if (seen.has(k)) continue;
    seen.add(k);
    next.push(f);
  }
  next.sort((a, b) => a.at - b.at);
  return next.length > QUEUE_MAX ? next.slice(next.length - QUEUE_MAX) : next;
}

/** What's left once midna has `sent`: fixes queued meanwhile stay. */
export function dequeue(queue: LocationFix[], sent: LocationFix[]): LocationFix[] {
  const gone = new Set(sent.map((f) => `${f.at}:${f.source}`));
  return queue.filter((f) => !gone.has(`${f.at}:${f.source}`));
}

/** The geofence id of a saved place, and back. */
export const regionId = (p: Pick<Place, "id">) => `place:${p.id}`;
export const placeOf = (identifier: string | undefined): number | null => {
  const m = identifier?.match(/^place:(\d+)$/);
  return m ? Number(m[1]) : null;
};

/** The geofences for the saved places. */
export const regionsFor = (places: Place[]) =>
  places.map((p) => ({ identifier: regionId(p), latitude: p.lat, longitude: p.lon, radius: p.radius, notifyOnEnter: true, notifyOnExit: true }));

/** What the watched geofences are, to tell whether they need registering again. */
export const regionsKey = (places: Place[]) =>
  places
    .map((p) => `${p.id}:${p.lat.toFixed(6)},${p.lon.toFixed(6)}:${Math.round(p.radius)}`)
    .sort()
    .join("|");

export type Inside = Record<string, "inside" | "outside">;

/**
 * Whether a geofence event is news. iOS reports every region's state each
 * time the geofences are registered, the app's relaunches included, and
 * sometimes reports a crossing twice: only a change from what was last
 * known is an arrival or a departure. The first state heard for a place is
 * only noted — being outside the gym when it is saved is no departure.
 */
export function crossing(inside: Inside, identifier: string, now: "inside" | "outside"): { inside: Inside; news: "arrive" | "leave" | null } {
  const was = inside[identifier];
  const next = { ...inside, [identifier]: now };
  if (was === undefined || was === now) return { inside: next, news: null };
  return { inside: next, news: now === "inside" ? "arrive" : "leave" };
}

/** Forget the states of places no longer watched. */
export const keepWatched = (inside: Inside, places: Place[]): Inside => {
  const ids = new Set(places.map(regionId));
  return Object.fromEntries(Object.entries(inside).filter(([k]) => ids.has(k)));
};

/** "4 min ago", "2 h ago", "3 days ago": how old the last report is, as Settings says it. */
export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
