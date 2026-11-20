export * from "react-native-web";
import { useColorScheme as system } from "react-native-web";
const forced = new URLSearchParams(location.search).get("scheme");
export const useColorScheme = () => (forced === "dark" || forced === "light" ? forced : system());
export const ActionSheetIOS = { showActionSheetWithOptions: () => {} };
