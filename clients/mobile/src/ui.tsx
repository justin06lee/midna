import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";
import { useTheme } from "./theme";

/** A full-width or inline button, as iOS fills them: "primary" in the tint, the one thing to do on a screen; the others on a quiet grey, their words in the tint or in red. */
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
  const bg = kind === "primary" ? t.primary : t.fill;
  const fg = kind === "primary" ? t.primaryInk : kind === "danger" ? t.danger : t.primary;
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
        { backgroundColor: bg, opacity: off ? 0.45 : pressed ? 0.7 : 1 },
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
        style={[s.input, { color: t.ink, backgroundColor: t.panel }, props.style]}
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
  return <View style={[s.card, { backgroundColor: t.panel }, style]}>{children}</View>;
}

/** A heading over a group of rows, as iOS sets one: small, grey, capitals. */
export function GroupTitle({ children }: { children: string }) {
  const t = useTheme();
  return <Text style={[s.groupTitle, { color: t.dim }]}>{children}</Text>;
}

/** The words under a group that say what it does. */
export function GroupNote({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[s.groupNote, { color: t.dim }]}>{children}</Text>;
}

/** A group of rows on one rounded surface: how iOS Settings lays out a list. Rows draw their own separators. */
export function Group({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[s.group, { backgroundColor: t.panel }, style]}>{children}</View>;
}

/**
 * One row of a Group: what it is on the left, its value on the right in
 * grey; a chevron when it opens something, a tick when it is the one chosen.
 * `first` leaves out the hairline above it.
 */
export function Row({
  label,
  value,
  note,
  onPress,
  first,
  chevron,
  checked,
  tone,
  busy,
  testID,
}: {
  label: string;
  value?: string;
  note?: string;
  onPress?: () => void;
  first?: boolean;
  chevron?: boolean;
  /** Present on a row that is one of a choice: true draws the tick. */
  checked?: boolean;
  tone?: "tint" | "danger" | "warn";
  busy?: boolean;
  testID?: string;
}) {
  const t = useTheme();
  const body = (
    <View style={[s.rowBody, !first && { borderTopColor: t.line, borderTopWidth: StyleSheet.hairlineWidth }]}>
      <View style={[s.rowText, !value && s.rowTextAlone]}>
        <Text numberOfLines={1} style={[s.rowLabel, { color: tone === "tint" ? t.primary : tone === "danger" ? t.danger : t.ink }]}>
          {label}
        </Text>
        {note ? <Text style={[s.rowNote, { color: t.dim }]}>{note}</Text> : null}
      </View>
      {value ? (
        <Text selectable={!onPress} numberOfLines={1} style={[s.rowValue, { color: tone === "warn" ? t.warn : t.dim }]}>
          {value}
        </Text>
      ) : null}
      {busy ? <ActivityIndicator size="small" color={t.dim} /> : checked ? <Text style={[s.tick, { color: t.primary }]}>✓</Text> : null}
      {chevron ? <Text style={[s.chevron, { color: t.dimmer }]}>›</Text> : null}
    </View>
  );
  if (!onPress) return <View style={s.row}>{body}</View>;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={checked === undefined ? undefined : { selected: checked }} onPress={onPress} style={({ pressed }) => [s.row, pressed && { backgroundColor: t.active }]}>
      {body}
    </Pressable>
  );
}

/** How long ago, or what time today: "14:05", "Tue 09:12". */
export function time(at: number): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (new Date().toDateString() === d.toDateString()) return hm;
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${hm}`;
}

const s = StyleSheet.create({
  groupTitle: { fontSize: 13, textTransform: "uppercase", marginHorizontal: 16, marginBottom: -8 },
  groupNote: { fontSize: 13, lineHeight: 18, marginHorizontal: 16, marginTop: -8 },
  group: { borderRadius: 12, overflow: "hidden" },
  row: { paddingLeft: 16 },
  rowBody: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10, paddingRight: 16, paddingVertical: 11 },
  // The label keeps its width and the value takes what is left, so a long name is cut only when the row itself is too narrow.
  rowText: { flexShrink: 1 },
  // With no value beside it, the label has the row.
  rowTextAlone: { flex: 1 },
  rowLabel: { fontSize: 17 },
  rowNote: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  rowValue: { flex: 1, minWidth: 0, fontSize: 17, textAlign: "right" },
  tick: { fontSize: 17, fontWeight: "600", marginLeft: "auto" },
  chevron: { fontSize: 22, lineHeight: 22, marginTop: -2 },
  button: { height: 50, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  small: { height: 34, borderRadius: 17, paddingHorizontal: 14 },
  label: { fontSize: 17, fontWeight: "600" },
  smallLabel: { fontSize: 15, fontWeight: "500" },
  field: { gap: 6 },
  fieldLabel: { fontSize: 13, marginLeft: 16, textTransform: "uppercase" },
  input: { height: 44, borderRadius: 10, paddingHorizontal: 16, fontSize: 17 },
  hint: { fontSize: 13, lineHeight: 18, marginHorizontal: 16 },
  problem: { fontSize: 15, lineHeight: 20 },
  card: { borderRadius: 12, padding: 16, gap: 10 },
});
