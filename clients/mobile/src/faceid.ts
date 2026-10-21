import * as LocalAuthentication from "expo-local-authentication";

/**
 * Face ID before any approval is answered from this phone — Face ID only:
 * no passcode fallback, so a phone picked up unlocked can't say yes. Null
 * when it matched; otherwise why nothing was sent ("" when the user
 * cancelled, which needs no telling).
 */
export async function faceId(reason: string): Promise<string | null> {
  if (!(await LocalAuthentication.hasHardwareAsync())) return "This phone has no Face ID, so approvals can't be answered here.";
  if (!(await LocalAuthentication.isEnrolledAsync())) return "Set up Face ID in Settings to answer approvals here.";
  const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, disableDeviceFallback: true, fallbackLabel: "", cancelLabel: "Cancel" });
  if (r.success) return null;
  if (r.error === "user_cancel" || r.error === "system_cancel" || r.error === "app_cancel") return "";
  if (r.error === "lockout") return "Face ID is locked after too many tries. Unlock the phone with its passcode, then try again.";
  return "Face ID didn't match, so nothing was sent.";
}
