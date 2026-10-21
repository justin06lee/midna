import { useColorScheme } from "react-native";

/** The desktop's colours (style.css there), so midna looks like itself on every screen. */
const light = {
  bg: "#f3f3f4",
  panel: "#ffffff",
  sunken: "#f6f6f7",
  active: "rgba(12, 12, 14, 0.075)",
  ink: "#0c0c0e",
  ink2: "#3a3a40",
  dim: "#6f6f78",
  dimmer: "#a3a3ab",
  line: "rgba(12, 12, 14, 0.075)",
  line2: "rgba(12, 12, 14, 0.13)",
  primary: "#0c0c0e",
  primaryInk: "#ffffff",
  danger: "#c4302b",
  ok: "#2f8f4e",
  warn: "#b7791f",
};

const dark: typeof light = {
  bg: "#0b0b0c",
  panel: "#141416",
  sunken: "#1a1a1d",
  active: "rgba(255, 255, 255, 0.08)",
  ink: "#ededf0",
  ink2: "#c6c6cc",
  dim: "#8b8b94",
  dimmer: "#5d5d66",
  line: "rgba(255, 255, 255, 0.07)",
  line2: "rgba(255, 255, 255, 0.12)",
  primary: "#ededf0",
  primaryInk: "#0b0b0c",
  danger: "#ff6b63",
  ok: "#5fcf80",
  warn: "#e8b04a",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export const mono = "Menlo";
