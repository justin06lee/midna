export * from "react-native-web";
import { useColorScheme as system } from "react-native-web";
const forced = new URLSearchParams(location.search).get("scheme");
export const useColorScheme = () => (forced === "dark" || forced === "light" ? forced : system());
export const ActionSheetIOS = { showActionSheetWithOptions: () => {} };
// iOS defaults (launch arguments), which the browser has none of.
export const Settings = { get: (_key: string): unknown => undefined };
