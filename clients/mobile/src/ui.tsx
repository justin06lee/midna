import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";
import { useTheme } from "./theme";

/** A full-width or inline button: "primary" is the one thing to do on a screen. */
export function Button({
  label,
  onPress,
  kind = "secondary",
  busy,
  disabled,
  small,
  style,
  testID,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  busy?: boolean;
  disabled?: boolean;
  small?: boolean;
  style?: ViewStyle;
  testID?: string;
}) {
  const t = useTheme();
  const off = disabled || busy;
  const bg = kind === "primary" ? t.primary : t.panel;
  const fg = kind === "primary" ? t.primaryInk : kind === "danger" ? t.danger : t.ink;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        small && s.small,
        { backgroundColor: bg, borderColor: kind === "primary" ? bg : t.line2, opacity: off ? 0.45 : pressed ? 0.7 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : <Text style={[s.label, small && s.smallLabel, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

/** A labelled text field. */
export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={s.field}>
      <Text style={[s.fieldLabel, { color: t.dim }]}>{label}</Text>
      <TextInput
        placeholderTextColor={t.dimmer}
        autoCorrect={false}
        {...props}
        style={[s.input, { color: t.ink, backgroundColor: t.panel, borderColor: t.line2 }, props.style]}
      />
      {hint ? <Text style={[s.hint, { color: t.dim }]}>{hint}</Text> : null}
    </View>
  );
}

/** A line that says something went wrong, and what was kept. */
export function Problem({ text }: { text: string }) {
  const t = useTheme();
  if (!text) return null;
  return (
    <Text accessibilityRole="alert" style={[s.problem, { color: t.danger }]}>
      {text}
    </Text>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[s.card, { backgroundColor: t.panel, borderColor: t.line }, style]}>{children}</View>;
}

/** How long ago, or what time today: "14:05", "Tue 09:12". */
export function time(at: number): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (new Date().toDateString() === d.toDateString()) return hm;
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${hm}`;
}

const s = StyleSheet.create({
  button: { height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  small: { height: 32, borderRadius: 16, paddingHorizontal: 13 },
  label: { fontSize: 16, fontWeight: "600" },
  smallLabel: { fontSize: 14, fontWeight: "500" },
  field: { gap: 6 },
  fieldLabel: { fontSize: 13, fontWeight: "500" },
  input: { height: 46, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, fontSize: 16 },
  hint: { fontSize: 12.5, lineHeight: 17 },
  problem: { fontSize: 14, lineHeight: 19 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 10 },
});
