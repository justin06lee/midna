import type { Database } from "bun:sqlite";
import { MAX_PLACES, PLACE_RADIUS_DEFAULT, placeAt, type LocationFix, type LocationPoint, type LocationState, type Place } from "@midna/protocol";

/**
 * Where the user has been: every fix their phone sent, kept forever, and the
 * saved places the phone watches (home, the office, …). Fixes are never
 * deleted; a deleted place is only hidden, so the fixes taken there keep
 * its name.
 */

type PlaceRow = { id: number; name: string; lat: number; lon: number; radius_m: number; created_at: number; updated_at: number };
const place = (r: PlaceRow): Place => ({ id: r.id, name: r.name, lat: r.lat, lon: r.lon, radius: r.radius_m, created_at: r.created_at, updated_at: r.updated_at });

const POINT_COLUMNS = `l.id, l.at, l.lat, l.lon, l.accuracy_m AS accuracy, l.altitude_m AS altitude, l.speed_mps AS speed, l.source, l.place_id, p.name AS place_name, l.received_at
  FROM location_points l LEFT JOIN places p ON p.id = l.place_id`;

export class Location {
  constructor(private readonly db: Database) {}

  /**
   * Keep a phone's fixes. The same fix sent twice (a retry) is kept once.
   * Each is marked with the saved place it was in, as the places are now;
   * an arrival or departure names its place, if that place still exists.
   * How many were new.
   */
  report(deviceId: string, fixes: LocationFix[], now = Date.now()): number {
    const places = this.places();
    const insert = this.db.query(
      `INSERT OR IGNORE INTO location_points (device_id, at, lat, lon, accuracy_m, altitude_m, speed_mps, source, place_id, received_at)
       VALUES ($device, $at, $lat, $lon, $accuracy, $altitude, $speed, $source, $place, $now)`,
    );
    let kept = 0;
    this.db.transaction(() => {
      for (const f of fixes) {
        const named = f.place !== undefined && (f.source === "arrive" || f.source === "leave") ? places.find((p) => p.id === f.place) : undefined;
        const inside = named ?? (f.source === "leave" ? null : placeAt(places, f));
        kept += insert.run({
          device: deviceId, at: f.at, lat: f.lat, lon: f.lon, accuracy: f.accuracy ?? null, altitude: f.altitude ?? null, speed: f.speed ?? null,
          source: f.source, place: inside?.id ?? null, now,
        }).changes;
      }
    })();
    return kept;
  }

  /** The latest fix: the one the phone took last, not the one that arrived last. */
  latest(): LocationPoint | null {
    return this.db.query(`SELECT ${POINT_COLUMNS} ORDER BY l.at DESC, l.id DESC LIMIT 1`).get() as LocationPoint | null;
  }

  /** The latest fix among those that arrived at or after `since` (ms): what the phone sent once midna asked. */
  receivedSince(since: number): LocationPoint | null {
    return this.db.query(`SELECT ${POINT_COLUMNS} WHERE l.received_at >= $since ORDER BY l.at DESC, l.id DESC LIMIT 1`).get({ since }) as LocationPoint | null;
  }

  /** Fixes taken from `from` to `to`, oldest first; at most `limit`, the latest ones when there are more. */
  history(from: number, to: number, limit = 500): LocationPoint[] {
    const rows = this.db
      .query(`SELECT ${POINT_COLUMNS} WHERE l.at >= $from AND l.at <= $to ORDER BY l.at DESC, l.id DESC LIMIT $limit`)
      .all({ from, to, limit }) as LocationPoint[];
    return rows.reverse();
  }

  count(from = 0, to = Number.MAX_SAFE_INTEGER): number {
    return (this.db.query("SELECT count(*) AS n FROM location_points WHERE at >= $from AND at <= $to").get({ from, to }) as { n: number }).n;
  }

  /**
   * Where the user is now, judged from the latest fix: the saved place it is
   * in (none just after leaving one), and since when — the first of the
   * latest run of fixes in that place.
   */
  state(): LocationState {
    const latest = this.latest();
    const places = this.places();
    const here = !latest || latest.source === "leave" ? null : placeAt(places, latest);
    let since: number | null = null;
    if (latest && here) {
      // The latest fix taken anywhere else (or leaving here) ends the run; the first one after it starts it.
      const before = this.db
        .query("SELECT at, lat, lon, source, place_id FROM location_points WHERE at <= $at ORDER BY at DESC, id DESC LIMIT 2000")
        .all({ at: latest.at }) as Array<Pick<LocationPoint, "at" | "lat" | "lon" | "source" | "place_id">>;
      since = latest.at;
      for (const p of before) {
        if (p.source === "leave" || placeAt(places, p)?.id !== here.id) break;
        since = p.at;
      }
    }
    return { latest, place: here, since, points: this.count(), places };
  }

  places(): Place[] {
    return (this.db.query("SELECT * FROM places WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE").all() as PlaceRow[]).map(place);
  }

  place(id: number): Place | null {
    const r = this.db.query("SELECT * FROM places WHERE id = $id AND deleted_at IS NULL").get({ id }) as PlaceRow | null;
    return r ? place(r) : null;
  }

  /** The place so named (any case). */
  named(name: string): Place | null {
    const r = this.db.query("SELECT * FROM places WHERE lower(name) = lower($name) AND deleted_at IS NULL").get({ name: name.trim() }) as PlaceRow | null;
    return r ? place(r) : null;
  }

  /**
   * Save a place: a new one, or — with an id, or a name already saved (any
   * case) — move or rename that one. At most MAX_PLACES, as iOS watches no
   * more.
   */
  savePlace(fields: { name?: string; lat?: number; lon?: number; radius?: number }, id?: number, now = Date.now()): Place {
    const name = fields.name?.trim();
    const existing = id !== undefined ? this.place(id) : name ? this.named(name) : null;
    if (id !== undefined && !existing) throw new Error(`no place ${id}`);
    if (name !== undefined && !name) throw new Error("a place needs a name");
    if (existing) {
      const clash = name ? this.named(name) : null;
      if (clash && clash.id !== existing.id) throw new Error(`there is already a place called "${clash.name}"`);
      this.db
        .query("UPDATE places SET name = $name, lat = $lat, lon = $lon, radius_m = $radius, updated_at = $now WHERE id = $id")
        // Found by its name, it keeps the name as saved: "home" moves Home, it doesn't rename it.
        .run({ id: existing.id, name: id !== undefined && name ? name : existing.name, lat: fields.lat ?? existing.lat, lon: fields.lon ?? existing.lon, radius: fields.radius ?? existing.radius, now });
      return this.place(existing.id)!;
    }
    if (!name || fields.lat === undefined || fields.lon === undefined) throw new Error("a new place needs a name and where it is");
    if (this.places().length >= MAX_PLACES) throw new Error(`the phone can watch at most ${MAX_PLACES} places; delete one first`);
    const r = this.db
      .query("INSERT INTO places (name, lat, lon, radius_m, created_at, updated_at) VALUES ($name, $lat, $lon, $radius, $now, $now)")
      .run({ name, lat: fields.lat, lon: fields.lon, radius: fields.radius ?? PLACE_RADIUS_DEFAULT, now });
    return this.place(Number(r.lastInsertRowid))!;
  }

  /** Stop watching a place. The fixes taken there keep its name. */
  deletePlace(id: number, now = Date.now()): boolean {
    return this.db.query("UPDATE places SET deleted_at = $now WHERE id = $id AND deleted_at IS NULL").run({ id, now }).changes > 0;
  }
}
