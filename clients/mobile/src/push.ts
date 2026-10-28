import * as Application from "expo-application";
import * as Notifications from "expo-notifications";
import { MidnaError, type MidnaClient } from "@midna/protocol";

/** Where push notifications stand on this phone. */
export type PushSetup = "unknown" | "on" | "denied" | "unsupported" | "failed";

// While the app is open the chat already shows what arrives: keep it in the list, no banner or sound.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

/**
 * Ask for notifications (iOS asks only the first time), get this phone's
 * Apple push token and give it to midna. Again on every launch and return to
 * the foreground: the token can change, and registering twice is harmless.
 */
export async function registerForPush(client: MidnaClient): Promise<PushSetup> {
  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status === "undetermined") ({ status } = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }));
    if (status !== "granted") return "denied";
    const { data: token } = await Notifications.getDevicePushTokenAsync();
    // TestFlight and App Store builds talk to production; a build run from Xcode to development. The host corrects a wrong guess.
    const env = await Application.getIosPushNotificationServiceEnvironmentAsync().catch(() => null);
    await client.registerPush({ token: String(token), environment: env === "development" || (env === null && __DEV__) ? "development" : "production" });
    return "on";
  } catch (err) {
    // A host before 0.13 has no push.
    if (err instanceof MidnaError && err.status === 404) return "unsupported";
    console.warn(`push registration failed: ${(err as Error).message}`);
    return "failed";
  }
}

/** The app is open: what the notifications said is in the chat now. */
export const clearDelivered = () => void Notifications.dismissAllNotificationsAsync().catch(() => {});

/** Re-register whenever iOS hands the app a new token. */
export const onTokenChange = (fn: () => void) => Notifications.addPushTokenListener(fn);
