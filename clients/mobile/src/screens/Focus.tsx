import { useCallback, useEffect, useState } from "react";
import { Alert, AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { clock, focus, focusStatus, liftMessage, minutes, parseWindow, type FocusStatus } from "../focus";
import { useTheme } from "../theme";
import { Button, Card, Field, Problem, time } from "../ui";
import type { Midna } from "../useMidna";
import { Back, Row } from "./Location";

/** How long a lift can be, in minutes of use. */
const LIFTS = [5, 15, 30];

/**
 * Screen Time, in Settings: the apps midna holds back, whether the shield is
 * up, a lift with a reason (the reason goes to midna), the daily windows,
 * today's minutes, and what a shield offers instead.
 */
export function FocusSettings({ midna, onBack }: { midna: Midna; onBack: () => void }) {
  const t = useTheme();
  const [st, setSt] = useState<FocusStatus | null>(focusStatus);
  const [problem, setProblem] = useState("");
  const [reason, setReason] = useState("");
  const [lift, setLift] = useState(15);
  const [window, setWindow] = useState("");
  const [offer, setOffer] = useState(st?.offer?.title ?? "");
  const [offerUrl, setOfferUrl] = useState(st?.offer?.url ?? "");
  const refresh = useCallback(() => setSt(focusStatus()), []);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (a) => a === "active" && refresh());
    const tick = setInterval(refresh, 30_000);
    return () => {
      sub.remove();
      clearInterval(tick);
    };
  }, [refresh]);

  /** Run a native step; a failure is shown, and the state read again either way. */
  const act = async (fn: () => unknown) => {
    setProblem("");
    try {
      await fn();
    } catch (err) {
      setProblem((err as Error).message);
    }
    refresh();
  };

  const fx = focus;
  if (!st || !fx) return null;
  const chosen = [st.apps && `${st.apps} app${st.apps === 1 ? "" : "s"}`, st.categories && `${st.categories} categor${st.categories === 1 ? "y" : "ies"}`, st.sites && `${st.sites} site${st.sites === 1 ? "" : "s"}`].filter(Boolean).join(", ");
  const lifted = st.liftedUntil && st.liftedUntil > Date.now();
  const shield = lifted ? `lifted until ${time(st.liftedUntil!)}` : st.shielded ? (st.inWindow && !st.held ? "up (window)" : "up") : "down";

  const doLift = () =>
    act(async () => {
      fx.lift(lift);
      await midna.send(liftMessage(lift, reason));
      setReason("");
    });
  const addWindow = () => {
    const w = parseWindow(window);
    if (!w) return setProblem("A window looks like 21:00-23:30.");
    void act(() => fx.setWindows([...st.windows, w]));
    setWindow("");
  };
  const dropWindow = (i: number) =>
    Alert.alert(`Remove ${clock(st.windows[i]!.start)}–${clock(st.windows[i]!.end)}?`, undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void act(() => fx.setWindows(st.windows.filter((_, j) => j !== i))) },
    ]);

  return (
    <ScrollView testID="focus" contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <Back label="Settings" onPress={onBack} />
      <Text style={[s.title, { color: t.ink }]}>Screen Time</Text>
      {!st.authorized ? (
        <>
          <Text style={[s.para, { color: t.dim }]}>
            midna can hold the apps that eat your day behind a shield, on demand or at set times, and offer you something better when you reach for them. Lifting it takes a reason, which goes to midna. iPhone asks for Face ID once; you can take it back in Settings → Screen Time.
          </Text>
          <Button testID="focus-allow" kind="primary" label="Allow Screen Time" onPress={() => void act(() => fx.authorize())} />
        </>
      ) : (
        <>
          <Card style={s.card}>
            <Pressable accessibilityRole="button" onPress={() => void act(() => fx.pick())} style={({ pressed }) => [s.kv, { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }, pressed && { opacity: 0.6 }]}>
              <Text style={[s.key, { color: t.dim }]}>Held back</Text>
              <Text style={[s.value, { color: chosen ? t.ink : t.warn }]}>
                {chosen || "Choose apps"} <Text style={{ color: t.dimmer }}>›</Text>
              </Text>
            </Pressable>
            <Row k="Shield" v={shield} />
            <Row k="Today" v={`${minutes(st.minutesToday)} · met the shield ${st.hitsToday}×`} last />
          </Card>
          {chosen ? (
            st.held ? (
              <Button label="Let them go" onPress={() => void act(() => fx.hold(false))} />
            ) : (
              <Button kind="primary" label="Hold them now" onPress={() => void act(() => fx.hold(true))} />
            )
          ) : null}

          {lifted ? (
            <Button label="Put the shield back" onPress={() => void act(() => fx.endLift())} />
          ) : st.shielded ? (
            <View style={s.group}>
              <Text style={[s.heading, { color: t.ink }]}>Lift it</Text>
              <Field label="Why" value={reason} onChangeText={setReason} placeholder="Replying to Sam's DM" hint="midna gets this, with how long." />
              <View style={s.chips}>
                {LIFTS.map((m) => (
                  <Pressable key={m} accessibilityRole="button" accessibilityState={{ selected: lift === m }} onPress={() => setLift(m)} style={[s.chip, { borderColor: t.line, backgroundColor: lift === m ? t.ink : "transparent" }]}>
                    <Text style={[s.chipText, { color: lift === m ? t.bg : t.ink }]}>{m} min</Text>
                  </Pressable>
                ))}
              </View>
              <Button label={`Lift for ${lift} min of use`} disabled={reason.trim().length < 3} onPress={() => void doLift()} />
            </View>
          ) : null}

          <View style={s.group}>
            <Text style={[s.heading, { color: t.ink }]}>Every day</Text>
            {st.windows.length ? (
              <Card style={s.card}>
                {st.windows.map((w, i) => (
                  <Pressable key={i} accessibilityRole="button" accessibilityHint="Removes this window" onPress={() => dropWindow(i)} style={[s.kv, i < st.windows.length - 1 && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
                    <Text style={[s.key, { color: t.ink }]}>
                      {clock(w.start)}–{clock(w.end)}
                    </Text>
                    <Text style={[s.value, { color: t.dimmer }]}>held</Text>
                  </Pressable>
                ))}
              </Card>
            ) : null}
            <Field label="Hold them from" value={window} onChangeText={setWindow} placeholder="21:00-23:30" autoCapitalize="none" />
            <Button small label="Add" onPress={addWindow} disabled={!window.trim()} style={{ alignSelf: "flex-start" }} />
          </View>

          <View style={s.group}>
            <Text style={[s.heading, { color: t.ink }]}>Instead</Text>
            <Field label="What a shield offers" value={offer} onChangeText={setOffer} placeholder="Justice" />
            <Field label="Link that opens it" value={offerUrl} onChangeText={setOfferUrl} placeholder="ibooks://… or https://…" autoCapitalize="none" keyboardType="url" />
            <Button small label="Save" onPress={() => void act(() => fx.setOffer(offer.trim() || null, offerUrl.trim() || null))} style={{ alignSelf: "flex-start" }} />
          </View>
        </>
      )}
      <Problem text={problem} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  body: { padding: 16, gap: 14 },
  title: { fontSize: 24, fontWeight: "700" },
  heading: { fontSize: 17, fontWeight: "600" },
  para: { fontSize: 15, lineHeight: 21 },
  card: { paddingVertical: 4, gap: 0 },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 11, gap: 16 },
  key: { fontSize: 15 },
  value: { fontSize: 15, flexShrink: 1, textAlign: "right" },
  group: { gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { height: 32, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 13, justifyContent: "center" },
  chipText: { fontSize: 14, fontWeight: "500" },
});
