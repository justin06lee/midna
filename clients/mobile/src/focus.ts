import { requireOptionalNativeModule } from "expo";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Linking } from "react-native";
import { MidnaClient, type FocusReport, type FocusRules } from "@midna/protocol";
import type { PhoneConnection } from "./connection";
import type { Window } from "./focusTime";
import { ensureReporter, reporter } from "./location";

export { clock, minutes, parseWindow, type Window } from "./focusTime";

/** Screen Time on this phone, as modules/midna-focus/ios/MidnaFocusModule.swift reports it. */
export interface FocusStatus {
  /** This build carries the Family Controls entitlement (app.config.js with MIDNA_FOCUS=1). */
  available: boolean;
  /** Justin allowed Screen Time for midna. */
  authorized: boolean;
  apps: number;
  categories: number;
  sites: number;
  /** Held on demand, until let go or `heldUntil` (ms). */
  held: boolean;
  heldUntil?: number;
  /** A daily window is holding them now. */
  inWindow: boolean;
  /** The shield is up now. */
  shielded: boolean;
  /** A lift runs until then (ms). */
  liftedUntil?: number;
  /** Daily windows, minutes after midnight. */
  windows: Window[];
  /** Minutes in the held apps today, in quarter hours. */
  minutesToday: number;
  hitsToday: number;
  offer?: { title: string; url: string | null };
}

interface MidnaFocus {
  status(): FocusStatus;
  authorize(): Promise<boolean>;
  pick(): Promise<boolean>;
  /** midna's rules, as fetched or pushed. */
  applyRules(rules: FocusRules): void;
  report(): FocusReport;
  /** Lift at once, for the lift midna recorded as `id`. */
  lift(minutes: number, id: string | null): void;
  endLift(): void;
}

/** The module, or null in a build without it. */
export const focus = requireOptionalNativeModule<MidnaFocus>("MidnaFocus");

/** Screen Time as it stands, or null when this build can't do it. */
export function focusStatus(): FocusStatus | null {
  const s = focus?.status();
  return s?.available ? s : null;
}

/**
 * midna holds the rules; the phone fetches them, carries them out and says how
 * the days went. On launch and each return to the foreground; the silent push
 * below does the same while the app is closed. Also hands the location-only
 * token to the push, which may come while the phone is locked.
 */
export async function syncFocus(client: MidnaClient, connection: PhoneConnection): Promise<FocusStatus | null> {
  if (!focus || !focusStatus()) return null;
  const { rules } = await client.focus();
  focus.applyRules(rules);
  await client.reportFocus(focus.report());
  await ensureReporter(client, connection).catch(() => {});
  return focusStatus();
}

/** midna's silent push (`midna: "focus"`, packages/daemon/src/push.ts): the rules ride in it, and the phone answers with its numbers. */
const FOCUS_TASK = "midna-focus-push";
TaskManager.defineTask<{ data?: { midna?: string; rules?: FocusRules } }>(FOCUS_TASK, async ({ data }) => {
  const push = data?.data;
  if (push?.midna !== "focus" || !focus || !focusStatus()) return;
  if (push.rules) focus.applyRules(push.rules);
  const r = await reporter();
  if (r) await new MidnaClient(r.url, r.token).reportFocus(focus.report()).catch(() => {});
});
if (focus) void Notifications.registerTaskAsync(FOCUS_TASK).catch(() => {});

/**
 * A tap on a notification a shield's button left (targets/focus-shield-action):
 * the offer opens its link; "Ask midna" opens the lift, which asks for a reason.
 */
export function onFocusTap(ask: () => void) {
  const handle = (r: Notifications.NotificationResponse | null) => {
    const data = r?.notification.request.content.data as { midnaFocus?: string; url?: string } | undefined;
    if (data?.midnaFocus === "offer" && data.url) void Linking.openURL(data.url).catch(() => {});
    else if (data?.midnaFocus) ask();
  };
  // The app was opened by the tap itself.
  const last = Notifications.getLastNotificationResponse();
  if (last?.notification.request.content.data?.midnaFocus) {
    Notifications.clearLastNotificationResponse();
    handle(last);
  }
  return Notifications.addNotificationResponseReceivedListener(handle);
}
