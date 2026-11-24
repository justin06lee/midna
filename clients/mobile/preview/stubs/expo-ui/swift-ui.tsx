import type { ReactNode } from "react";
import { Text as RNText, View } from "react-native-web";

// SwiftUI through @expo/ui, which a browser has none of: a menu shows only its label, and its items are left out.
export const Host = ({ children, testID }: { children?: ReactNode; testID?: string }) => <View testID={testID}>{children}</View>;
export const Menu = ({ label }: { label: ReactNode }) => <>{typeof label === "string" ? <RNText>{label}</RNText> : label}</>;
export const HStack = ({ children, spacing = 0 }: { children?: ReactNode; spacing?: number }) => <View style={{ flexDirection: "row", alignItems: "center", gap: spacing, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 17, backgroundColor: "rgba(128,128,128,0.16)" }}>{children}</View>;
export const Text = ({ children }: { children?: ReactNode }) => <RNText style={{ fontFamily: '"Space Grotesk"', fontWeight: "500", fontSize: 13, color: "#8d877e" }}>{children}</RNText>;
export const Image = () => <RNText style={{ fontSize: 9, color: "#8d877e" }}>⌃⌄</RNText>;
export const Button = () => null;
export const Section = () => null;
