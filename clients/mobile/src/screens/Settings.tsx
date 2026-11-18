import { useEffect, useState } from "react";
import { Alert, AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PhoneConnection } from "../connection";
import { locationSetup, type LocationSetup } from "../location";
import { useTheme } from "../theme";
import { Button, Card, Problem } from "../ui";
import type { Midna } from "../useMidna";
import { focusStatus, minutes } from "../focus";
import { FocusSettings } from "./Focus";
import { LocationSettings } from "./Location";

/** Which midna this phone talks to, location, Screen Time, and the way out: pair again, or unpair. `focusAsk` changes when a shield's "Ask midna" was tapped: Screen Time opens. */
export function Settings({ midna, connection, onPairAgain, onUnpaired, focusAsk = 0 }: { midna: Midna; connection: PhoneConnection; onPairAgain: () => void; onUnpaired: () => void; focusAsk?: number }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [location, setLocation] = useState<LocationSetup | null>(null);
  const [showLocation, setShowLocation] = useState(false);
  const [showFocus, setShowFocus] = useState(focusAsk > 0);
  useEffect(() => void (focusAsk > 0 && setShowFocus(true)), [focusAsk]);
  const focus = showFocus ? null : focusStatus();
  useEffect(() => {
    if (showLocation) return;
    void locationSetup().then(setLocation);
    const sub = AppState.addEventListener("change", (a) => a === "active" && void locationSetup().then(setLocation));
    return () => sub.remove();
  }, [showLocation]);
  const rows: Array<[string, string]> = [
    ["midna", midna.status?.name ?? connection.name],
    ["Address", connection.url],
    ["Version", midna.status?.version ?? "—"],
    ["Lives on", midna.status?.host.name || "—"],
    ["Mode", midna.status?.mode ?? "—"],
    ["Notifications", notifications(midna)],
    ["This phone", connection.device],
  ];

  const unpair = () =>
    Alert.alert("Unpair this phone?", "midna forgets this phone, and it forgets midna. You can pair again with a new code.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unpair",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          setProblem("");
          try {
            await midna.client.revokeDevice(connection.device);
          } catch {
            // Unreachable: forget it here anyway; `midna paired` on the host shows what's left.
          }
          setBusy(false);
          onUnpaired();
        },
      },
    ]);

  if (showFocus) return <FocusSettings midna={midna} connection={connection} onBack={() => setShowFocus(false)} />;
  if (showLocation) return <LocationSettings midna={midna} connection={connection} onBack={() => setShowLocation(false)} />;

  return (
    <ScrollView testID="settings" contentContainerStyle={s.body}>
      <Card style={s.card}>
        {rows.map(([k, v]) => (
          <View key={k} style={[s.row, { borderBottomColor: t.line }]}>
            <Text style={[s.key, { color: t.dim }]}>{k}</Text>
            <Text selectable numberOfLines={1} style={[s.value, { color: t.ink }]}>
              {v}
            </Text>
          </View>
        ))}
      </Card>
      <Text style={[s.note, { color: t.dim }]}>{whereAlertsGo(midna)}</Text>
      <Card style={s.card}>
        <Pressable testID="settings-location" accessibilityRole="button" onPress={() => setShowLocation(true)} style={({ pressed }) => [s.row, s.last, pressed && { opacity: 0.6 }]}>
          <Text style={[s.key, { color: t.dim }]}>Location</Text>
          <Text style={[s.value, { color: location === "while-using" ? t.warn : t.ink }]}>
            {locationLabel(location)} <Text style={{ color: t.dimmer }}>›</Text>
          </Text>
        </Pressable>
        {focus ? (
          <Pressable testID="settings-focus" accessibilityRole="button" onPress={() => setShowFocus(true)} style={({ pressed }) => [s.row, s.last, { borderTopColor: t.line, borderTopWidth: StyleSheet.hairlineWidth }, pressed && { opacity: 0.6 }]}>
            <Text style={[s.key, { color: t.dim }]}>Screen Time</Text>
            <Text style={[s.value, { color: t.ink }]}>
              {!focus.authorized ? "Off" : focus.shielded ? `Held · ${minutes(focus.minutesToday)} today` : `${minutes(focus.minutesToday)} today`} <Text style={{ color: t.dimmer }}>›</Text>
            </Text>
          </Pressable>
        ) : null}
      </Card>
      <Problem text={problem} />
      <Button label="Pair again" onPress={onPairAgain} disabled={busy} />
      <Button label="Unpair this phone" kind="danger" busy={busy} onPress={unpair} />
    </ScrollView>
  );
}

/** Whether this phone gets notifications, and if not, why. */
function notifications(midna: Midna): string {
  if (midna.push === "denied") return "Off in iPhone Settings";
  if (midna.push === "unsupported") return "Needs midna 0.13";
  if (midna.push === "failed") return "Not registered yet";
  if (midna.push === "unknown") return "—";
  if (midna.status?.push && !midna.status.push.configured) return "Not set up on midna";
  return "On";
}

/** Whether this phone tells midna where it is. */
function locationLabel(l: LocationSetup | null): string {
  if (l === "always") return "On";
  if (l === "while-using") return "While open";
  if (l === "denied") return "Off in iPhone Settings";
  if (l === "off") return "Off";
  return "—";
}

/** Where reminders and questions reach the user while the app is closed. */
function whereAlertsGo(midna: Midna): string {
  const pushes = midna.push === "on" && midna.status?.push?.configured;
  if (pushes && midna.status?.alerts === "push") return "Reminders, questions and notifications reach you here; Telegram gets one only when a notification can't.";
  if (pushes && midna.status?.alerts === "both") return "Reminders, questions and notifications reach you here and on Telegram.";
  return "midna's messages reach you on Telegram while this app is closed.";
}

const s = StyleSheet.create({
  body: { padding: 14, gap: 14 },
  card: { paddingVertical: 4, gap: 0 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, gap: 16 },
  key: { fontSize: 15 },
  value: { fontSize: 15, flexShrink: 1, textAlign: "right" },
  last: { borderBottomWidth: 0 },
  note: { fontSize: 13.5, lineHeight: 19, paddingHorizontal: 4 },
});
