import type { CSSProperties } from "react";

// SF Symbols, which a browser has none of: a plain drawing for each name the app uses, so a screen reads the same.
const PATHS: Record<string, { d: string; fill?: boolean }> = {
  "bubble.left.fill": { d: "M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-5 4v-4H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", fill: true },
  calendar: { d: "M4 6h16a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM3 10h18M8 3v4M16 3v4" },
  "key.fill": { d: "M8 9a5 5 0 1 0 0 6l1 0h3l2-2 2 2 2-2 2 2 2-3-2-3H9z", fill: true },
  "hand.raised": { d: "M8 12V5a1.5 1.5 0 0 1 3 0v6V3.5a1.5 1.5 0 0 1 3 0V11V5a1.5 1.5 0 0 1 3 0v10c0 4-2.5 7-6 7s-5-2-7-6l-2-4c-.6-1.4 1.2-2.3 2-1z" },
  gearshape: { d: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 2.5l1.6 2.6 3-.6 1 2.9 2.9 1-.6 3 2.600 1.600-2.600 1.600.6 3-2.900 1-1 2.900-3-.6L12 21.5l-1.600-2.600-3 .6-1-2.900-2.900-1 .6-3L1.500 13l2.600-1.600-.6-3 2.900-1 1-2.900 3 .6z" },
  plus: { d: "M12 4v16M4 12h16" },
  "arrow.up": { d: "M12 20V5M5 12l7-7 7 7" },
  "chevron.right": { d: "M9 4l8 8-8 8" },
  "chevron.left": { d: "M15 4l-8 8 8 8" },
  "chevron.up.chevron.down": { d: "M7 9l5-5 5 5M7 15l5 5 5-5" },
  checkmark: { d: "M4 13l5 5L20 6" },
  xmark: { d: "M5 5l14 14M19 5L5 19" },
};

export function SymbolView({ name, size = 18, tintColor, style }: { name: string | { ios?: string }; size?: number; tintColor?: string; style?: CSSProperties }) {
  const p = PATHS[typeof name === "string" ? name : (name.ios ?? "")] ?? PATHS.plus!;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0, ...(style as CSSProperties) }} fill={p.fill ? tintColor : "none"} stroke={tintColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={p.d} />
    </svg>
  );
}
