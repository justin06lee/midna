import { useColorScheme } from "react-native";

/**
 * iOS's own system colours, as UIKit gives them in light and dark: the plain
 * and the grouped backgrounds, the label greys, the separator, the fills
 * and the tints. Written out rather than taken from PlatformColor so every
 * one can be used in an opacity or a border all the same.
 */
const light = {
  /** A plain screen: the conversation. */
  bg: "#ffffff",
  /** A screen of grouped rows: Settings, the vault. */
  grouped: "#f2f2f7",
  /** A group of rows, or a field, on a grouped screen. */
  panel: "#ffffff",
  sunken: "#f2f2f7",
  /** What a quiet control is filled with: a chip, a secondary button. */
  fill: "rgba(118, 118, 128, 0.12)",
  active: "rgba(118, 118, 128, 0.2)",
  ink: "#000000",
  ink2: "#3a3a3c",
  dim: "rgba(60, 60, 67, 0.6)",
  dimmer: "rgba(60, 60, 67, 0.3)",
  line: "rgba(60, 60, 67, 0.29)",
  line2: "rgba(60, 60, 67, 0.29)",
  primary: "#007aff",
  primaryInk: "#ffffff",
  danger: "#ff3b30",
  ok: "#34c759",
  warn: "#ff9500",
};

const dark: typeof light = {
  bg: "#000000",
  grouped: "#000000",
  panel: "#1c1c1e",
  sunken: "#1c1c1e",
  fill: "rgba(118, 118, 128, 0.24)",
  active: "rgba(118, 118, 128, 0.36)",
  ink: "#ffffff",
  ink2: "#d1d1d6",
  dim: "rgba(235, 235, 245, 0.6)",
  dimmer: "rgba(235, 235, 245, 0.3)",
  line: "rgba(84, 84, 88, 0.6)",
  line2: "rgba(84, 84, 88, 0.6)",
  primary: "#0a84ff",
  primaryInk: "#ffffff",
  danger: "#ff453a",
  ok: "#30d158",
  warn: "#ff9f0a",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

/** SF Mono through the system's monospaced face (Menlo on anything older). Every other face is the system font: no fontFamily anywhere. */
export const mono = "ui-monospace";
