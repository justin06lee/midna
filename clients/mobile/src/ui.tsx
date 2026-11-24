import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { radius, type as face, useTheme } from "./theme";

/** An SF Symbol, in a colour of the theme. */
export function Icon({ name, size = 18, color, weight = "medium" }: { name: SymbolViewProps["name"]; size?: number; color: string; weight?: "regular" | "medium" | "semibold" | "bold" }) {
  return <SymbolView name={name} size={size} tintColor={color} weight={weight} resizeMode="scaleAspectFit" style={{ width: size, height: size }} />;
}

const glass = isLiquidGlassAvailable();

/**
 * What floats over a screen (the tab bar, a button in the bar, the field a
 * message is written in): Liquid Glass where the iPhone has it (iOS 26),
 * and before it the theme's raised shade.
 */
export function Glass({ children, style, interactive, fallback, lifted }: { children?: ReactNode; style?: StyleProp<ViewStyle>; interactive?: boolean; fallback?: string; /** Before glass: a soft shadow under it, so a white bar reads on a white page. */ lifted?: boolean }) {
  const t = useTheme();
  if (glass)
    return (
      <GlassView glassEffectStyle="regular" isInteractive={interactive} style={style}>
        {children}
      </GlassView>
    );
  return <View style={[{ backgroundColor: fallback ?? t.raisedHigh }, style, lifted && s.lifted]}>{children}</View>;
}

/** A round button in a bar, 44 across: an icon on glass. `dot` marks that something behind it waits for you. */
export function CircleButton({ icon, label, onPress, dot, testID }: { icon: SymbolViewProps["name"]; label: string; onPress: () => void; dot?: boolean; testID?: string }) {
  const t = useTheme();
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} hitSlop={6} onPress={onPress} style={({ pressed }) => pressed && { opacity: 0.6 }}>
      <Glass interactive fallback={t.fill} style={s.circle}>
        <Icon name={icon} size={19} color={t.ink} />
      </Glass>
      {dot ? <View style={[s.dot, { backgroundColor: t.accent, borderColor: t.paper }]} /> : null}
    </Pressable>
  );
}

/**
 * A capsule button. "primary" is solid ink, the one thing to do on a screen;
 * the others are glass (a wash of ink before iOS 26), their words in ink or,
 * for what can't be undone, in red.
 */
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
  const fg = kind === "primary" ? t.paper : kind === "danger" ? t.destructive : t.ink;
  const inside = busy ? <ActivityIndicator size="small" color={fg} /> : <Text style={[small ? s.smallLabel : s.label, { color: fg }]}>{label}</Text>;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!off, busy: !!busy }} disabled={off} onPress={onPress} style={({ pressed }) => [{ opacity: off ? 0.4 : pressed ? 0.7 : 1 }, style]}>
      {kind === "primary" ? (
        // What leads is solid ink: a tint barely shows on glass.
        <View style={[s.button, small && s.small, { backgroundColor: t.ink }]}>{inside}</View>
      ) : (
        <Glass interactive fallback={t.fill} style={[s.button, small && s.small]}>
          {inside}
        </Glass>
      )}
    </Pressable>
  );
}

/** A choice to tap, in a row of them under a question: a glass capsule. */
export function Chip({ label, onPress, disabled, tone, busy, testID }: { label: string; onPress: () => void; disabled?: boolean; tone?: "lead" | "danger"; busy?: boolean; testID?: string }) {
  const t = useTheme();
  const fg = tone === "lead" ? t.paper : tone === "danger" ? t.destructive : t.ink;
  const inside = busy ? <ActivityIndicator size="small" color={fg} /> : <Text style={[s.smallLabel, { color: disabled ? (tone === "lead" ? fg : t.inkSoft) : fg }]}>{label}</Text>;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ opacity: disabled ? 0.45 : pressed ? 0.6 : 1 })}>
      {tone === "lead" ? (
        <View style={[s.chip, { backgroundColor: t.ink }]}>{inside}</View>
      ) : (
        <Glass interactive fallback={t.fill} style={s.chip}>
          {inside}
        </Glass>
      )}
    </Pressable>
  );
}

/** A labelled text field. */
export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={s.field}>
      <Text style={[s.groupTitle, { color: t.inkSoft }]}>{label}</Text>
      <TextInput placeholderTextColor={t.inkFaint} autoCorrect={false} {...props} style={[s.input, { color: t.ink, backgroundColor: t.raised }, props.style]} />
      {hint ? <Text style={[s.groupNote, { color: t.inkSoft }]}>{hint}</Text> : null}
    </View>
  );
}

/** A line that says something went wrong, and what was kept. */
export function Problem({ text }: { text: string }) {
  const t = useTheme();
  if (!text) return null;
  return (
    <Text accessibilityRole="alert" style={[s.problem, { color: t.destructive }]}>
      {text}
    </Text>
  );
}

/** A card: a rounded surface a shade off what it stands on, no line round it. */
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[s.card, { backgroundColor: t.raised }, style]}>{children}</View>;
}

/** The small label over a group of rows. */
export function GroupTitle({ children }: { children: string }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" style={[s.groupTitle, { color: t.inkSoft }]}>
      {children}
    </Text>
  );
}

/** The words under a group that say what it does. */
export function GroupNote({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[s.groupNote, { color: t.inkSoft }]}>{children}</Text>;
}

/** A group of rows on one raised, rounded surface. Rows draw the hairline between them. */
export function Group({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[s.group, { backgroundColor: t.raised }, style]}>{children}</View>;
}

/**
 * One row of a Group: what it is on the left, its value on the right, said
 * second; a chevron when it opens something, a tick when it is the one
 * chosen. `first` leaves out the hairline above it.
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
    <View style={[s.rowBody, !first && { borderTopColor: t.hairline, borderTopWidth: StyleSheet.hairlineWidth }]}>
      <View style={[s.rowText, !value && s.rowTextAlone]}>
        <Text numberOfLines={1} style={[s.rowLabel, { color: tone === "danger" ? t.destructive : t.ink }]}>
          {label}
        </Text>
        {note ? <Text style={[s.rowNote, { color: t.inkSoft }]}>{note}</Text> : null}
      </View>
      {value ? (
        <Text selectable={!onPress} numberOfLines={1} style={[s.rowValue, { color: tone === "warn" ? t.warn : t.inkSoft }]}>
          {value}
        </Text>
      ) : null}
      {busy ? <ActivityIndicator size="small" color={t.inkSoft} /> : checked ? <Icon name="checkmark" size={15} color={t.accent} weight="semibold" /> : null}
      {chevron ? <Icon name="chevron.right" size={12} color={t.inkFaint} weight="semibold" /> : null}
    </View>
  );
  if (!onPress) return <View style={s.row}>{body}</View>;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={checked === undefined ? undefined : { selected: checked }} onPress={onPress} style={({ pressed }) => [s.row, pressed && { backgroundColor: t.fill }]}>
      {body}
    </Pressable>
  );
}

/** The top of a sheet: what it is at the centre, and Done at the right, in the accent on glass. */
export function SheetBar({ title, onDone, onBack, testID }: { title: string; onDone: () => void; onBack?: () => void; testID?: string }) {
  const t = useTheme();
  return (
    <View style={s.sheetBar}>
      {onBack ? (
        <View style={s.sheetBack}>
          <CircleButton icon="chevron.left" label="Back" onPress={onBack} />
        </View>
      ) : null}
      <Text accessibilityRole="header" style={[s.sheetTitle, { color: t.ink }]}>
        {title}
      </Text>
      <Pressable testID={testID} accessibilityRole="button" accessibilityLabel="Done" hitSlop={8} onPress={onDone} style={({ pressed }) => [s.sheetDone, pressed && { opacity: 0.6 }]}>
        <Glass interactive fallback={t.fill} style={s.done}>
          <Text style={[s.doneText, { color: t.accent }]}>Done</Text>
        </Glass>
      </Pressable>
    </View>
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
  lifted: { overflow: "visible", shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 14, shadowOffset: { width: 0, height: 3 } },
  circle: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  dot: { position: "absolute", top: 1, right: 1, width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  groupTitle: { ...face(13, "medium"), marginHorizontal: 6, marginBottom: -16 },
  groupNote: { ...face(13, "regular", 18), marginHorizontal: 6, marginTop: -14 },
  group: { borderRadius: radius.card, overflow: "hidden" },
  row: { paddingLeft: 16 },
  rowBody: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: 10, paddingRight: 16, paddingVertical: 13 },
  // The label keeps its width and the value takes what is left, so a long name is cut only when the row itself is too narrow.
  rowText: { flexShrink: 1 },
  // With no value beside it, the label has the row.
  rowTextAlone: { flex: 1 },
  rowLabel: face(16),
  rowNote: { ...face(13, "regular", 18), marginTop: 2 },
  rowValue: { ...face(16), flex: 1, minWidth: 0, textAlign: "right" },
  button: { height: 50, borderRadius: 25, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, overflow: "hidden" },
  small: { height: 36, borderRadius: 18, paddingHorizontal: 15 },
  chip: { minHeight: 38, borderRadius: 19, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  label: face(16, "medium"),
  smallLabel: face(14, "medium"),
  field: { gap: 24 },
  input: { ...face(16), height: 50, borderRadius: radius.card, paddingHorizontal: 16 },
  problem: face(14, "regular", 19),
  card: { borderRadius: radius.card, padding: 16, gap: 12 },
  sheetBar: { height: 64, alignItems: "center", justifyContent: "center", marginTop: 6 },
  sheetTitle: face(17, "bold"),
  sheetBack: { position: "absolute", left: 16 },
  sheetDone: { position: "absolute", right: 16 },
  done: { height: 44, borderRadius: 22, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  doneText: face(16, "medium"),
});
