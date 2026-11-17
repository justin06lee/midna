import { requireOptionalNativeModule } from "expo";
import * as Notifications from "expo-notifications";
import { Linking } from "react-native";
import type { Window } from "./focusTime";

export { clock, liftMessage, minutes, parseWindow, type Window } from "./focusTime";

/** Screen Time on this phone, as modules/midna-focus/ios/MidnaFocusModule.swift reports it. */
export interface FocusStatus {
  /** This build carries the Family Controls entitlement (app.config.js with MIDNA_FOCUS=1). */
  available: boolean;
  /** Justin allowed Screen Time for midna. */
  authorized: boolean;
  apps: number;
  categories: number;
  sites: number;
  /** Held on demand, until let go. */
  held: boolean;
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
  hold(on: boolean): void;
  lift(minutes: number): void;
  endLift(): void;
  setWindows(windows: Window[]): void;
  setOffer(title: string | null, url: string | null): void;
}

/** The module, or null in a build without it. */
export const focus = requireOptionalNativeModule<MidnaFocus>("MidnaFocus");

/** Screen Time as it stands, or null when this build can't do it. */
export function focusStatus(): FocusStatus | null {
  const s = focus?.status();
  return s?.available ? s : null;
}

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
