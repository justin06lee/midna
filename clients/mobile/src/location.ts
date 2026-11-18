import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import Storage from "expo-sqlite/kv-store";
import * as TaskManager from "expo-task-manager";
import { MidnaError, type LocationFix, type MidnaClient, type Place } from "@midna/protocol";
import MidnaLocation from "./midnaLocation";
import { clientFor, type PhoneConnection } from "./connection";
import { REPORT_MAX, crossing, dequeue, enqueue, fromTask, keepWatched, placeOf, regionsFor, regionsKey, sendNow, type Inside, type TaskLocation } from "./locationQueue";

/**
 * Where the phone is, for midna (modules/midna-location): with Always, a
 * precise fix every 30 m while the phone moves (iOS pauses the GPS while it
 * sits still); significant changes (about 500 m) as the net that brings the
 * app back when iOS has ended it; arriving at or leaving a saved place
 * (geofences); a fix each time the app is opened; and one whenever midna
 * asks, by a silent push. Each fix waits in SQLite until midna has it, and
 * goes straight to midna's host and nowhere else.
 *
 * Most fixes come while the phone is locked, when the pairing's token can't
 * be read (it is readable only while the phone is unlocked). So the
 * background tasks send with a token that can only report the phone's
 * location (POST /v1/location/token), kept readable after the first unlock
 * and never synced off the phone.
 */

/** The native task (its name is from before precise fixes; iOS keeps it registered under it). */
const TRACKING_TASK = "midna-significant-changes";
const PLACES_TASK = "midna-places";

const QUEUE = "midna.location.queue";
const INSIDE = "midna.location.inside";
const WATCHED = "midna.location.watched";
/** When midna last took a report, ms. */
const LAST_SENT = "midna.location.sent";
/** "on" once the user turned location on in the app; gone once they turned it off. */
const CHOSEN = "midna.location.on";

/** The location-only token, and the pairing it belongs to. */
interface Reporter {
  url: string;
  token: string;
  /** The phone's own device id: a reporter for another pairing is stale. */
  phone: string;
}
const REPORTER = "midna.location.reporter";
const reporterOpts: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

const readJson = <T>(key: string, fallback: T): T => {
  const s = Storage.getItemSync(key);
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const writeJson = (key: string, v: unknown) => Storage.setItemSync(key, JSON.stringify(v));

export async function reporter(): Promise<Reporter | null> {
  const s = await SecureStore.getItemAsync(REPORTER, reporterOpts).catch(() => null);
  if (!s) return null;
  try {
    return JSON.parse(s) as Reporter;
  } catch {
    return null;
  }
}

// ── the background tasks ───────────────────────────────────────────────
// Defined when the app's JavaScript loads (index.ts imports this first), so iOS relaunching the app for a location event finds them.

TaskManager.defineTask<{ locations: TaskLocation[]; flush?: boolean }>(TRACKING_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const fixes = fromTask(data.locations ?? []);
  remember(fixes);
  // The updates paused (the phone sits still): what waits goes now, before iOS lets the app sleep.
  if (data.flush ? readJson<LocationFix[]>(QUEUE, []).length : fixes.length && sendNow(fixes, Math.max(lastSent() ?? 0, lastTry) || null, Date.now())) await send();
});

TaskManager.defineTask<{ eventType: Location.LocationGeofencingEventType; region: Location.LocationRegion }>(PLACES_TASK, async ({ data, error }) => {
  if (error || !data?.region) return;
  const id = data.region.identifier ?? "";
  const place = placeOf(id);
  if (place === null) return;
  const { inside, news } = crossing(readJson<Inside>(INSIDE, {}), id, data.eventType === Location.LocationGeofencingEventType.Enter ? "inside" : "outside");
  writeJson(INSIDE, inside);
  if (!news) return;
  // Where iOS last placed the phone, which it has without asking the GPS; else the place itself, as far off as it is wide.
  const known = await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000 }).catch(() => null);
  remember([
    known
      ? { ...fromTask([known])[0]!, at: Date.now(), source: news, place }
      : { at: Date.now(), lat: data.region.latitude, lon: data.region.longitude, accuracy: data.region.radius, source: news, place },
  ]);
  await send();
});

/** Keep fixes until midna has them. */
function remember(fixes: LocationFix[]) {
  if (fixes.length) writeJson(QUEUE, enqueue(readJson<LocationFix[]>(QUEUE, []), fixes));
}

let sending: Promise<void> | null = null;
/** When a send was last tried, ms: offline, precise fixes don't each try again. */
let lastTry = 0;

/**
 * Send what waits, a report at a time, with the location-only token; then
 * watch the places midna answered with. What doesn't get through stays for
 * the next fix, or the next time the app is opened. One at a time.
 */
export function send(): Promise<void> {
  return (sending ??= (async () => {
    lastTry = Date.now();
    const r = await reporter();
    if (!r) return;
    const client = clientFor(r.url, r.token);
    for (let queue = readJson<LocationFix[]>(QUEUE, []); queue.length; queue = readJson<LocationFix[]>(QUEUE, [])) {
      const batch = queue.slice(0, REPORT_MAX);
      const receipt = await client.reportLocation({ fixes: batch });
      writeJson(QUEUE, dequeue(readJson<LocationFix[]>(QUEUE, []), batch));
      Storage.setItemSync(LAST_SENT, String(Date.now()));
      await watch(receipt.places);
    }
  })()
    .catch(async (err: Error) => {
      // Retired on the host (unpaired from another device, say): the next start, with the pairing's token, makes another.
      if (err instanceof MidnaError && err.status === 401) await SecureStore.deleteItemAsync(REPORTER, reporterOpts).catch(() => {});
      console.warn(`location: not sent yet: ${err.message}`);
    })
    .finally(() => (sending = null)));
}

/** Watch exactly the saved places; nothing is registered again when they haven't changed. */
export async function watch(places: Place[]): Promise<void> {
  if (!chosen()) return;
  const key = regionsKey(places);
  const started = await Location.hasStartedGeofencingAsync(PLACES_TASK).catch(() => false);
  if (started && Storage.getItemSync(WATCHED) === key) return;
  writeJson(INSIDE, keepWatched(readJson<Inside>(INSIDE, {}), places));
  if (places.length === 0) {
    if (started) await Location.stopGeofencingAsync(PLACES_TASK);
  } else {
    const always = await Location.getBackgroundPermissionsAsync();
    if (!always.granted) return;
    await Location.startGeofencingAsync(PLACES_TASK, regionsFor(places));
  }
  Storage.setItemSync(WATCHED, key);
}

// ── from the app ───────────────────────────────────────────────────────

const chosen = () => Storage.getItemSync(CHOSEN) === "on";

/** Where location stands on this phone. */
export type LocationSetup =
  | "off" // never turned on, or turned off in the app
  | "always" // on, and iOS lets midna hear about moves while the app is closed
  | "while-using" // on, but iOS allows location only while the app is open
  | "denied"; // off in iPhone Settings

export async function locationSetup(): Promise<LocationSetup> {
  if (!chosen()) return "off";
  const fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted) return "denied";
  const bg = await Location.getBackgroundPermissionsAsync();
  return bg.granted ? "always" : "while-using";
}

/** When midna last took a report from this phone; null before the first. */
export const lastSent = (): number | null => Number(Storage.getItemSync(LAST_SENT)) || null;

/** The location-only token for this pairing: kept, or minted now. */
export async function ensureReporter(client: MidnaClient, connection: PhoneConnection): Promise<void> {
  const r = await reporter();
  if (r && r.phone === connection.device && r.url === connection.url) return;
  const made = await client.locationToken();
  await SecureStore.setItemAsync(REPORTER, JSON.stringify({ url: connection.url, token: made.token, phone: connection.device } satisfies Reporter), reporterOpts);
}

/**
 * Turn location on: iOS asks while-using first, then Always. Whatever the
 * answers, what they allow starts: with while-using, significant changes
 * while the app is open; with Always, precise fixes in the background, and
 * the saved places are watched.
 */
export async function turnOn(client: MidnaClient, connection: PhoneConnection): Promise<LocationSetup> {
  let fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted && fg.canAskAgain) fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return "denied";
  const bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted && bg.canAskAgain) await Location.requestBackgroundPermissionsAsync();
  Storage.setItemSync(CHOSEN, "on");
  await start(client, connection);
  return locationSetup();
}

/** Stop reporting. What midna has kept stays on midna; the location-only token goes. */
export async function turnOff(): Promise<void> {
  Storage.removeItemSync(CHOSEN);
  await MidnaLocation.stopTracking(TRACKING_TASK).catch(() => {});
  if (await Location.hasStartedGeofencingAsync(PLACES_TASK).catch(() => false)) await Location.stopGeofencingAsync(PLACES_TASK).catch(() => {});
  Storage.removeItemSync(WATCHED);
  Storage.removeItemSync(INSIDE);
  await SecureStore.deleteItemAsync(REPORTER, reporterOpts).catch(() => {});
}

/** Unpaired: nothing of location is kept on the phone either. */
export async function forgetLocation(): Promise<void> {
  await turnOff();
  Storage.removeItemSync(QUEUE);
  Storage.removeItemSync(LAST_SENT);
}

/**
 * Make sure what was turned on is running, for this pairing: on launch and
 * each return to the foreground, and after turning it on. Sends what waits,
 * and brings the watched places up to date with midna's.
 */
export async function start(client: MidnaClient, connection: PhoneConnection): Promise<void> {
  if (!chosen()) return;
  const fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted) return;
  try {
    await ensureReporter(client, connection);
  } catch (err) {
    // A host before location: nothing to send to, so nothing starts.
    if (err instanceof MidnaError && err.status === 404) return;
    throw err;
  }
  // Precise with Always; started again each time, as Always may have been given or taken away in iPhone Settings meanwhile.
  const always = (await Location.getBackgroundPermissionsAsync()).granted;
  await MidnaLocation.startTracking(TRACKING_TASK, always);
  await Promise.all([fixNow("app").catch((err: Error) => console.warn(`location: no fix on opening: ${err.message}`)), send()]);
  await watch(await client.places());
}

/** One fix now, sent to midna: `source` says why. */
async function fixNow(source: "app"): Promise<LocationFix> {
  const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  const fix: LocationFix = { ...fromTask([p])[0]!, source };
  remember([fix]);
  await send();
  return fix;
}

/** Whether iOS gives midna the precise location; with it off, every fix is a few kilometres wide. */
export const preciseAccuracy = (): boolean => {
  try {
    return MidnaLocation.hasPreciseAccuracy();
  } catch {
    return true;
  }
};

/**
 * Where the phone is right now, asked once because the user tapped to save
 * a place here. It goes to midna as a fix too.
 */
export async function here(): Promise<LocationFix> {
  let fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted && fg.canAskAgain) fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) throw new Error("Location is off for midna in iPhone Settings.");
  const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  const fix: LocationFix = { ...fromTask([p])[0]!, source: "app" };
  if (chosen()) {
    remember([fix]);
    void send();
  }
  return fix;
}
