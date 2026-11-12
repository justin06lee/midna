import * as LocalAuthentication from "expo-local-authentication";

/**
 * Face ID before any approval is answered from this phone, or a password is
 * shown or copied — Face ID only: no passcode fallback, so a phone picked up
 * unlocked can't say yes. Null when it matched; otherwise why nothing
 * happened ("" when the user cancelled, which needs no telling).
 */
export async function faceId(reason: string, to: "answer approvals" | "see passwords" = "answer approvals"): Promise<string | null> {
  const approvals = to === "answer approvals";
  if (!(await LocalAuthentication.hasHardwareAsync())) return approvals ? "This phone has no Face ID, so approvals can't be answered here." : "This phone has no Face ID, so passwords can't be shown here.";
  if (!(await LocalAuthentication.isEnrolledAsync())) return `Set up Face ID in Settings to ${to} here.`;
  const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, disableDeviceFallback: true, fallbackLabel: "", cancelLabel: "Cancel" });
  if (r.success) return null;
  if (r.error === "user_cancel" || r.error === "system_cancel" || r.error === "app_cancel") return "";
  if (r.error === "lockout") return "Face ID is locked after too many tries. Unlock the phone with its passcode, then try again.";
  return approvals ? "Face ID didn't match, so nothing was sent." : "Face ID didn't match.";
}
