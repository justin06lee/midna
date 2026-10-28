import * as Application from "expo-application";
import * as Notifications from "expo-notifications";
import { MidnaError, type MidnaClient } from "@midna/protocol";
import { pushRegistration, type PushSetup } from "./pushRegistration";

export type { PushSetup } from "./pushRegistration";

// While the app is open the chat already shows what arrives: keep it in the list, no banner or sound.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

/**
 * This phone's Apple push token, given to midna: asked for notifications
 * (iOS asks only the first time), then the token, on launch and on returns
 * to the foreground, at most once at a time and not the same one twice an
 * hour (pushRegistration.ts).
 */
export function phonePush(client: MidnaClient) {
  return pushRegistration({
    permitted: async () => {
      let { status } = await Notifications.getPermissionsAsync();
      if (status === "undetermined") ({ status } = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }));
      return status === "granted";
    },
    token: async () => String((await Notifications.getDevicePushTokenAsync()).data),
    // TestFlight and App Store builds talk to production; a build run from Xcode to development. The host corrects a wrong guess.
    environment: async () => {
      const env = await Application.getIosPushNotificationServiceEnvironmentAsync().catch(() => null);
      return env === "development" || (env === null && __DEV__) ? "development" : "production";
    },
    send: async (token, environment): Promise<PushSetup> => {
      try {
        await client.registerPush({ token, environment });
        return "on";
      } catch (err) {
        // A host before 0.13 has no push.
        if (err instanceof MidnaError && err.status === 404) return "unsupported";
        console.warn(`push registration failed: ${(err as Error).message}`);
        return "failed";
      }
    },
  });
}

/** The app is open: what the notifications said is in the chat now. */
export const clearDelivered = () => void Notifications.dismissAllNotificationsAsync().catch(() => {});

/** iOS handed the app a token: a new one, or the same again after any ask for it. */
export const onTokenChange = (fn: (token: string) => void) => Notifications.addPushTokenListener((t) => fn(String(t.data)));
