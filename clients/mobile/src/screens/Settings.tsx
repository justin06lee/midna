import { useCallback, useEffect, useState } from "react";
import type { AlarmAuthorization } from "@midna/protocol";
import { Alert, AppState, Linking, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { alarmAuthorization, heldOf, syncAlarms, upcoming, type AlarmsOnPhone } from "../alarms";
import type { PhoneConnection } from "../connection";
import { locationSetup, type LocationSetup } from "../location";
import { Group, GroupNote, Problem, Row, SheetBar } from "../ui";
import type { Midna } from "../useMidna";
import { focusStatus, minutes } from "../focus";
import { FocusSettings } from "./Focus";
import { LocationSettings } from "./Location";
import { ModelSheet, modelNow, type Models } from "./Models";

/**
 * Settings, as a sheet: the model midna thinks with, which midna this phone
 * talks to, location, Screen Time, alarms, and the way out: pair again, or
 * unpair. `focusAsk` changes when a shield's "Ask midna" was tapped: Screen
 * Time opens. The model's own sheet opens over this one, so it lives here.
 */
export function Settings({
  midna,
  connection,
  onPairAgain,
  onUnpaired,
  focusAsk = 0,
  models,
  onDone,
}: {
  midna: Midna;
  connection: PhoneConnection;
  onPairAgain: () => void;
  onUnpaired: () => void;
  focusAsk?: number;
  /** The brains' lists, for what is thinking now and the sheet that changes it. */
  models: Models;
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [picking, setPicking] = useState(false);
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

  if (showFocus || showLocation)
    return (
      <>
        <SheetBar title={showFocus ? "Screen Time" : "Location"} onDone={onDone} />
        {showFocus ? <FocusSettings midna={midna} connection={connection} onBack={() => setShowFocus(false)} /> : <LocationSettings midna={midna} connection={connection} onBack={() => setShowLocation(false)} />}
      </>
    );

  return (
    <>
      <SheetBar title="Settings" testID="settings-done" onDone={onDone} />
      <ScrollView testID="settings" contentContainerStyle={[s.body, { paddingBottom: insets.bottom + 32 }]}>
      <Group>
        <Row testID="settings-model" label="Model" value={modelNow(midna, models)} first chevron onPress={() => setPicking(true)} />
        <Row label="Mode" value={midna.status?.mode === "ask" ? "Asks first" : midna.status?.mode === "autonomous" ? "On its own" : "—"} />
      </Group>
      <Group>
        {rows.map(([k, v], n) => (
          <Row key={k} label={k} value={v} first={n === 0} />
        ))}
      </Group>
      <GroupNote>{whereAlertsGo(midna)}</GroupNote>
      <Group>
        <Row testID="settings-location" label="Location" value={locationLabel(location)} tone={location === "while-using" ? "warn" : undefined} first chevron onPress={() => setShowLocation(true)} />
        {focus ? (
          <Row
            testID="settings-focus"
            label="Screen Time"
            value={!focus.authorized ? "Off" : focus.shielded ? `Held · ${minutes(focus.minutesToday)} today` : `${minutes(focus.minutesToday)} today`}
            chevron
            onPress={() => setShowFocus(true)}
          />
        ) : null}
        <Row
          testID="settings-alarms"
          label="Alarms"
          value={alarmsLabel(allowed, wanted.length, ringing.length)}
          tone={allowed === "authorized" && ringing.length === wanted.length ? undefined : "warn"}
          onPress={() => (allowed === "denied" ? void Linking.openSettings() : lookAtAlarms(true))}
        />
      </Group>
      <GroupNote>{alarmsNote(allowed)}</GroupNote>
      <Problem text={problem} />
      <Group>
        <Row testID="settings-pair-again" label="Pair Again" first onPress={busy ? undefined : onPairAgain} />
        <Row testID="settings-unpair" label="Unpair This Phone" tone="danger" busy={busy} onPress={busy ? undefined : unpair} />
      </Group>
      </ScrollView>
      <ModelSheet midna={midna} models={models} open={picking} onClose={() => setPicking(false)} />
    </>
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
  body: { paddingHorizontal: 16, paddingTop: 8, gap: 24 },
});
