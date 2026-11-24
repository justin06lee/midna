import { View } from "react-native-web";

/** A top-to-bottom gradient, as CSS draws one. */
export function LinearGradient({ colors, locations, style, pointerEvents }: { colors: string[]; locations?: number[]; style?: unknown; pointerEvents?: "none" }) {
  const stops = colors.map((c, i) => `${c} ${Math.round((locations?.[i] ?? i / (colors.length - 1)) * 100)}%`).join(", ");
  return <View pointerEvents={pointerEvents} style={[style, { backgroundImage: `linear-gradient(to bottom, ${stops})` }]} />;
}
