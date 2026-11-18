import { useCallback, useEffect, useState } from "react";
import type { AlarmAuthorization } from "@midna/protocol";
import { Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { alarmAuthorization, heldOf, syncAlarms, upcoming, type AlarmsOnPhone } from "../alarms";
import type { PhoneConnection } from "../connection";
import { locationSetup, type LocationSetup } from "../location";
import { useTheme } from "../theme";
import { Button, Card, Problem } from "../ui";
import type { Midna } from "../useMidna";
import { LocationSettings } from "./Location";

/** Which midna this phone talks to, location, and the way out: pair again, or unpair. */
export function Settings({ midna, connection, onPairAgain, onUnpaired }: { midna: Midna; connection: PhoneConnection; onPairAgain: () => void; onUnpaired: () => void }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [location, setLocation] = useState<LocationSetup | null>(null);
  const [showLocation, setShowLocation] = useState(false);
  useEffect(() => {
    if (showLocation) return;
    void locationSetup().then(setLocation);
    const sub = AppState.addEventListener("change", (a) => a === "active" && void locationSetup().then(setLocation));
    return () => sub.remove();
  }, [showLocation]);
  // Alarms: what iOS holds of midna's list, looked at again whenever Settings shows or the app comes back.
  const [alarms, setAlarms] = useState<AlarmsOnPhone | null>(null);
  const [allowed, setAllowed] = useState(alarmAuthorization);
  const lookAtAlarms = useCallback(
    (ask = false) =>
      void syncAlarms(midna.client, connection, { ask })
        .then(setAlarms)
        .catch(() => {})
        .finally(() => setAllowed(alarmAuthorization())),
    [midna.client, connection],
  );
  useEffect(() => {
    lookAtAlarms();
    const sub = AppState.addEventListener("change", (a) => a === "active" && lookAtAlarms());
    return () => sub.remove();
  }, [lookAtAlarms]);
  const wanted = alarms ? upcoming(alarms.alarms) : [];
  const ringing = alarms ? upcoming(heldOf(alarms)) : [];
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
      </Card>
      <Card style={s.card}>
        <Pressable
          testID="settings-alarms"
          accessibilityRole="button"
          onPress={() => (allowed === "denied" ? void Linking.openSettings() : lookAtAlarms(true))}
          style={({ pressed }) => [s.row, s.last, pressed && { opacity: 0.6 }]}
        >
          <Text style={[s.key, { color: t.dim }]}>Alarms</Text>
          <Text style={[s.value, { color: allowed === "authorized" && ringing.length === wanted.length ? t.ink : t.warn }]}>{alarmsLabel(allowed, wanted.length, ringing.length)}</Text>
        </Pressable>
      </Card>
      <Text style={[s.note, { color: t.dim }]}>{alarmsNote(allowed)}</Text>
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

/** Whether midna's alarms will ring on this phone: how many iOS holds, of how many midna set. */
function alarmsLabel(allowed: AlarmAuthorization, wanted: number, held: number): string {
  if (allowed === "unsupported") return "Needs iOS 26";
  if (allowed === "denied") return "Off in iPhone Settings";
  if (allowed === "notDetermined") return "Tap to allow";
  if (wanted === 0) return "None set";
  return held === wanted ? `${held} set` : `${held} of ${wanted} set`;
}

function alarmsNote(allowed: AlarmAuthorization): string {
  if (allowed === "unsupported") return "midna's alarms need iOS 26.";
  if (allowed === "authorized") return "Alarms midna sets ring here like the Clock app's, through silent mode and a Focus. Ask midna to set, change or cancel one.";
  return "Allow alarms and midna can wake you: its alarms ring like the Clock app's, through silent mode and a Focus.";
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
