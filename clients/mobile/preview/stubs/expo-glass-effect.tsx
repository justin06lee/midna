// Liquid Glass is iOS 26's; the browser has none, so the app draws its raised shade instead.
export const isLiquidGlassAvailable = () => false;
export const isGlassEffectAPIAvailable = () => false;
export { View as GlassView, View as GlassContainer } from "react-native-web";
