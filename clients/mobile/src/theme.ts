import { Platform, useColorScheme, type TextStyle } from "react-native";

/**
 * midna's look (docs/redesign.md): paper and ink, as ruri draws it, in
 * monet's warm dark. A surface is told from the next by the shade it is
 * printed in, never by a line drawn round it; ink leads, and the accent
 * marks only the one thing that is on or waits for you. The names are
 * ruri's, and the Mac app's (clients/desktop/src/style.css).
 */
const light = {
  /** The page a conversation is read on. */
  paper: "#ffffff",
  /** A shade off the page: a chip, a code block, a card on the page. */
  paperDim: "#f4f3f1",
  /** A screen of rows, a shade off the page. */
  ground: "#f1f0ee",
  /** A card on the ground, and the field a message is written in. */
  raised: "#ffffff",
  /** What floats over the screen: the tab bar. */
  raisedHigh: "#ffffff",
  ink: "#1d1c1a",
  inkSoft: "#66625c",
  inkFaint: "#8d877e",
  /** The user's own bubble: a grey, never the accent. */
  bubble: "#ecebe8",
  /** A wash of ink: a pressed row, a quiet button. */
  fill: "rgba(29, 28, 26, 0.08)",
  /** The one rule there is: between the rows of a group. */
  hairline: "rgba(29, 28, 26, 0.08)",
  /** The one thing that is on, or waits for you. */
  accent: "#a8731d",
  /** The accent, faint: behind the block that is on now. */
  tint: "rgba(168, 115, 29, 0.1)",
  destructive: "#c8321f",
  ok: "#3d8f4a",
  warn: "#a8731d",
  dark: false,
};

const dark: typeof light = {
  paper: "#141312",
  paperDim: "#1d1c1a",
  ground: "#141312",
  raised: "#1d1c1a",
  raisedHigh: "#262421",
  ink: "#ece8e1",
  inkSoft: "#b0a99e",
  inkFaint: "#8d877e",
  bubble: "#2c2a27",
  fill: "rgba(236, 232, 225, 0.1)",
  hairline: "rgba(236, 232, 225, 0.08)",
  accent: "#e2b26c",
  tint: "rgba(226, 178, 108, 0.13)",
  destructive: "#e0806b",
  ok: "#8fc48a",
  warn: "#e2b26c",
  dark: true,
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

type Weight = "regular" | "medium" | "bold";
const FACES: Record<Weight, string> = { regular: "SpaceGrotesk-Regular", medium: "SpaceGrotesk-Medium", bold: "SpaceGrotesk-Bold" };

/**
 * Space Grotesk at a size, in one of the three weights it ships in. A weight
 * is a face of its own here, so `fontWeight` is never set beside it. The
 * browser preview takes the family by its name and the weight as a number.
 */
export function type(size: number, weight: Weight = "regular", lineHeight?: number): TextStyle {
  const face: TextStyle = Platform.OS === "web" ? { fontFamily: '"Space Grotesk", system-ui, sans-serif', fontWeight: weight === "bold" ? "700" : weight === "medium" ? "500" : "400" } : { fontFamily: FACES[weight] };
  return { ...face, fontSize: size, ...(lineHeight ? { lineHeight } : {}) };
}

/** Bold, for words inside a run of text that is set in another weight. */
export const bold: TextStyle = Platform.OS === "web" ? { fontWeight: "700" } : { fontFamily: FACES.bold };

/**
 * SF Mono, through the system's monospaced face: iOS takes the "ui-monospace" family itself. The browser
 * preview is given the faces by name as well, since not every browser knows that word and would fall back to a serif.
 */
export const mono = Platform.select({ web: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace', default: "ui-monospace" });

/** One scale of corners and of room. */
export const radius = { chip: 8, card: 18, bubble: 20, field: 24 };
export const space = { edge: 16, group: 24 };
