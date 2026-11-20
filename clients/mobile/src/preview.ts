import { Platform, Settings } from "react-native";
import type { PhoneConnection } from "./connection";

/**
 * A connection handed in at launch, to look at the app in the simulator
 * against a throwaway midna (clients/mobile/scripts/sim-shot.sh):
 *
 *   xcrun simctl launch <device> sh.midna.mobile -midnaPreview <base64 of the connection's JSON> [-midnaTab today]
 *
 * iOS puts launch arguments in the app's defaults, which only someone running
 * the app from a Mac can set: no link or push can. While the app runs so it
 * saves nothing, and asks for no permission (notifications, location,
 * alarms), so nothing covers what is being looked at.
 */
function handed(): PhoneConnection | null {
  if (Platform.OS !== "ios") return null;
  const raw = Settings.get("midnaPreview") as unknown;
  if (typeof raw !== "string" || !raw) return null;
  try {
    const c = JSON.parse(atob(raw)) as Partial<PhoneConnection>;
    return typeof c.url === "string" && typeof c.token === "string" && typeof c.device === "string" ? { url: c.url, token: c.token, device: c.device, name: c.name ?? "midna" } : null;
  } catch {
    return null;
  }
}

export const previewConnection = handed();
export const preview = previewConnection !== null;
