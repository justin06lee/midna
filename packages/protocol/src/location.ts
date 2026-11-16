import { z } from "zod";

/**
 * Where the user is, as their phone reports it: precise background fixes
 * every few tens of metres while it moves (iOS pauses them while it sits
 * still), iOS's significant location changes (about 500 m) as the net when
 * iOS has stopped the app, arriving at or leaving a saved place, a fix each
 * time the app is opened, and one when midna asks (a silent push). The
 * phone sends its points to midna's host and nowhere else; the host keeps
 * every one. After 0.13.2; "precise" and "requested" after 0.13.3.
 */

/**
 * What made the phone report: a precise background fix while moving, a
 * significant change, arriving at or leaving a saved place, the app being
 * opened, or midna asking.
 */
export const LocationSource = z.enum(["precise", "significant", "arrive", "leave", "app", "requested"]);
export type LocationSource = z.infer<typeof LocationSource>;

/** One fix, as the phone took it. */
export const LocationFix = z.object({
  /** When the phone took the fix, ms since the epoch (not when it was sent: a fix can wait for a connection). */
  at: z.number().int().positive(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Horizontal accuracy, metres. */
  accuracy: z.number().nonnegative().max(1e7).nullable().optional(),
  altitude: z.number().min(-1e5).max(1e5).nullable().optional(),
  /** Metres per second; null when the phone didn't know. */
  speed: z.number().nonnegative().max(1e4).nullable().optional(),
  source: LocationSource,
  /** For "arrive" and "leave": the saved place's id. */
  place: z.number().int().positive().optional(),
});
export type LocationFix = z.infer<typeof LocationFix>;

/** POST /v1/location: what the phone has gathered since it last got through, oldest first. The same fix twice is kept once. */
export const LocationReport = z.object({ fixes: z.array(LocationFix).min(1).max(1000) });
export type LocationReport = z.infer<typeof LocationReport>;

/** A saved place: the phone watches each one, and says when the user arrives or leaves. */
export interface Place {
  id: number;
  name: string;
  lat: number;
  lon: number;
  /** Metres. */
  radius: number;
  created_at: number;
  updated_at: number;
}

/** iOS watches a place no smaller than this reliably. */
export const PLACE_RADIUS_MIN = 100;
export const PLACE_RADIUS_MAX = 2_000;
export const PLACE_RADIUS_DEFAULT = 150;
/** iOS watches at most 20 regions per app, and the phone keeps one for itself: where it stopped, to wake the precise fixes when it moves on. */
export const MAX_PLACES = 19;

/** POST /v1/places: a new place, or one already named so moved; PATCH /v1/places/:id changes any of it. */
export const PlaceSave = z.object({
  name: z.string().trim().min(1).max(80),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  radius: z.number().min(PLACE_RADIUS_MIN).max(PLACE_RADIUS_MAX).optional(),
});
export type PlaceSave = z.input<typeof PlaceSave>;
export const PlacePatch = PlaceSave.partial().refine((p) => Object.values(p).some((v) => v !== undefined), "nothing to change");
export type PlacePatch = z.input<typeof PlacePatch>;

/** A fix as midna keeps it. */
export interface LocationPoint {
  id: number;
  at: number;
  lat: number;
  lon: number;
  accuracy: number | null;
  altitude: number | null;
  speed: number | null;
  source: LocationSource;
  /** The saved place it was in (or, for "leave", the one left), as the places were then. */
  place_id: number | null;
  place_name: string | null;
  received_at: number;
}

/** GET /v1/location: the latest fix, the saved place it is in, since when, and how many fixes midna keeps. */
export interface LocationState {
  latest: LocationPoint | null;
  /** The saved place the user is in now, judged from the latest fix. */
  place: Place | null;
  /** Since when they have been in it: the first of the latest run of fixes inside it. */
  since: number | null;
  points: number;
  places: Place[];
}

/** POST /v1/location's answer: how many fixes were new, and the places to watch, so the phone keeps its geofences current. */
export interface LocationReceipt {
  kept: number;
  places: Place[];
}

/**
 * POST /v1/location/token: a token that can only report this phone's
 * location (POST /v1/location), and nothing else. The phone keeps it where
 * it can be read while the phone is locked, which is when most fixes come;
 * the pairing's own token stays readable only while it is unlocked. A new
 * one retires the last; unpairing the phone retires it too.
 */
export interface LocationToken {
  deviceId: string;
  token: string;
}

const EARTH_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Metres between two points, on a sphere (haversine): plenty for places a few hundred metres across. */
export function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The saved place a point is in. Where places overlap, the smallest wins (home, not the neighbourhood around it), then the nearest centre. */
export function placeAt<P extends Pick<Place, "lat" | "lon" | "radius">>(places: P[], point: { lat: number; lon: number }): P | null {
  let best: { p: P; d: number } | null = null;
  for (const p of places) {
    const d = metresBetween(p, point);
    if (d > p.radius) continue;
    if (!best || p.radius < best.p.radius || (p.radius === best.p.radius && d < best.d)) best = { p, d };
  }
  return best?.p ?? null;
}
