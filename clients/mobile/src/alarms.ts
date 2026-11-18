import { requireOptionalNativeModule } from "expo";
import * as Notifications from "expo-notifications";
import Storage from "expo-sqlite/kv-store";
import * as TaskManager from "expo-task-manager";
import type { Alarm, AlarmAuthorization, AlarmReport, MidnaClient } from "@midna/protocol";
import { alarmSync, type AlarmsOnPhone, type PushedAlarms } from "./alarmsSync";
import { clientFor, type PhoneConnection } from "./connection";
import { ensureReporter, onBackgroundWake, reporter } from "./location";

export { heldOf, upcoming, type AlarmsOnPhone } from "./alarmsSync";

/**
 * midna's alarms on this phone (modules/midna-alarms): midna holds the list,
 * and the phone hands it to iOS's own alarms (AlarmKit, iOS 26), which ring
 * out loud through silent mode and a Focus as the Clock app's do. The list
 * comes when the app is opened, in a silent push when midna changes it, and
 * now and then when a move wakes the app in the background. After each, the
 * phone tells midna what iOS holds, so midna knows an alarm will ring.
 *
 * The push and the background wake mostly come while the phone is locked,
 * when the pairing's token can't be read: they use the location-only token
 * (location.ts), which may read and report alarms too.
 */

/** The alarms as modules/midna-alarms/ios takes and answers them: JSON both ways. */
interface MidnaAlarms {
  authorization(): string;
  requestAuthorization(): Promise<string>;
  sync(alarms: string, ask: boolean): Promise<string>;
}

/** The module, or null in a build without it. */
const native = requireOptionalNativeModule<MidnaAlarms>("MidnaAlarms");

const AUTHORIZATIONS: AlarmAuthorization[] = ["authorized", "denied", "notDetermined", "unsupported"];
const authorizationOf = (v: unknown): AlarmAuthorization => (AUTHORIZATIONS.includes(v as AlarmAuthorization) ? (v as AlarmAuthorization) : "unsupported");

/** midna's clock when the list iOS has was read. */
const AS_OF = "midna.alarms.asOf";
/** When the background last asked midna for the list, ms. */
const LAST_BACKGROUND = "midna.alarms.background";
/** A move wakes the app every few tens of metres; the list is asked for at most this often. */
const BACKGROUND_EVERY_MS = 15 * 60_000;

/** Hand the list to iOS; what it holds afterwards, as midna takes it. */
async function apply(alarms: Alarm[], ask: boolean): Promise<AlarmReport> {
  if (!native) return { authorization: "unsupported", scheduled: [] };
  const held = JSON.parse(await native.sync(JSON.stringify(alarms), ask)) as { authorization?: string; scheduled?: Array<{ id: string; updatedAt: number }>; problems?: Array<{ id: string; error: string }> };
  return {
    authorization: authorizationOf(held.authorization),
    scheduled: (held.scheduled ?? []).slice(0, 100),
    problems: (held.problems ?? []).slice(0, 100).map((p) => ({ id: p.id.slice(0, 64), error: p.error.slice(0, 300) })),
  };
}

const alarms = alarmSync({
  apply,
  lastAsOf: () => Number(Storage.getItemSync(AS_OF)) || 0,
  setAsOf: (asOf) => Storage.setItemSync(AS_OF, String(asOf)),
});

/** Whether the user lets midna set alarms on this phone. */
export function alarmAuthorization(): AlarmAuthorization {
  try {
    return native ? authorizationOf(native.authorization()) : "unsupported";
  } catch {
    return "unsupported";
  }
}

/**
 * From the app, on launch and each return to the foreground: iOS brought up
 * to midna's list, and midna told what it holds. With `ask`, iOS asks the
 * user to allow alarms the first time. Also keeps the token the background
 * uses. Null with a midna before alarms.
 */
export async function syncAlarms(client: MidnaClient, connection: PhoneConnection, opts: { ask?: boolean } = {}): Promise<AlarmsOnPhone | null> {
  if (native) await ensureReporter(client, connection).catch(() => {});
  return alarms.sync(client, opts);
}

/** In the background: with the token readable while locked, when there is one. */
async function inBackground(pushed?: PushedAlarms): Promise<void> {
  const r = await reporter();
  await alarms.sync(r ? clientFor(r.url, r.token) : null, pushed ? { pushed } : {});
}

// ── the background ─────────────────────────────────────────────────────
// Defined when the app's JavaScript loads (index.ts imports this early), so iOS launching the app for a push finds it.

/** midna's silent push (`midna: "alarms"`, packages/daemon/src/push.ts): the list rides in it. */
const ALARMS_TASK = "midna-alarms-push";
TaskManager.defineTask<{ data?: { midna?: string } & PushedAlarms }>(ALARMS_TASK, async ({ data }) => {
  const push = data?.data;
  if (push?.midna !== "alarms" || !native) return;
  await inBackground(push).catch((err: Error) => console.warn(`alarms: ${err.message}`));
});
if (native) void Notifications.registerTaskAsync(ALARMS_TASK).catch(() => {});

// A push Apple held back or dropped (Low Power Mode, too many in an hour) is made up for when a move next wakes the app.
if (native) {
  onBackgroundWake(async () => {
    const now = Date.now();
    if (now - (Number(Storage.getItemSync(LAST_BACKGROUND)) || 0) < BACKGROUND_EVERY_MS) return;
    Storage.setItemSync(LAST_BACKGROUND, String(now));
    await inBackground();
  });
}
