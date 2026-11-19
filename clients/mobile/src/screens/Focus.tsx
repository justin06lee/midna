import { useCallback, useEffect, useState } from "react";
import { Alert, AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { FocusRules, FocusRulesPatch } from "@midna/protocol";
import type { PhoneConnection } from "../connection";
import { clock, focus, focusStatus, minutes, parseWindow, syncFocus, type FocusStatus } from "../focus";
import { useTheme } from "../theme";
import { Button, Card, Field, Problem, time } from "../ui";
import type { Midna } from "../useMidna";
import { Back, Row } from "./Location";

/** How long a lift can be, in minutes of use. */
const LIFTS = [5, 15, 30];

/**
 * Screen Time, in Settings: the apps held back (chosen here: the choice
 * never leaves the phone), whether the shield is up, a lift with a reason,
 * the daily windows, today's minutes, and what a shield offers instead. midna
 * holds the rules: a change goes to midna, and what midna answers is applied.
 */
export function FocusSettings({ midna, connection, onBack }: { midna: Midna; connection: PhoneConnection; onBack: () => void }) {
  const t = useTheme();
  const [st, setSt] = useState<FocusStatus | null>(focusStatus);
  const [problem, setProblem] = useState("");
  const [reason, setReason] = useState("");
  const [lift, setLift] = useState(15);
  const [window, setWindow] = useState("");
  const [offer, setOffer] = useState(st?.offer?.title ?? "");
  const [offerUrl, setOfferUrl] = useState(st?.offer?.url ?? "");
  const refresh = useCallback(() => setSt(focusStatus()), []);
  // midna's rules as they are now, and the numbers to midna.
  useEffect(() => void syncFocus(midna.client, connection).then(refresh, () => {}), [midna.client, connection, refresh]);
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
  const shield = lifted ? `lifted until ${time(st.liftedUntil!)}` : st.shielded ? (st.inWindow && !st.held ? "up (window)" : st.heldUntil ? `up until ${time(st.heldUntil)}` : "up") : "down";

  /** A change to midna's rules: midna keeps it, and the phone applies what midna answers. */
  const change = (patch: FocusRulesPatch) => act(async () => fx.applyRules(await midna.client.setFocusRules(patch)));
  /** A lift: midna keeps it with its reason, and it starts now. With `endHold`, the hold is let go too. */
  const doLift = (endHold = false) =>
    act(async () => {
      const rules: FocusRules = await midna.client.liftFocus({ minutes: lift, reason: reason.trim(), ...(endHold ? { endHold } : {}) });
      fx.lift(lift, rules.lift?.id ?? null);
      fx.applyRules(rules);
      setReason("");
    });
  const addWindow = () => {
    const w = parseWindow(window);
    if (!w) return setProblem("A window looks like 21:00-23:30.");
    void change({ windows: [...st.windows, w] });
    setWindow("");
  };
  const dropWindow = (i: number) =>
    Alert.alert(`Remove ${clock(st.windows[i]!.start)}–${clock(st.windows[i]!.end)}?`, undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void change({ windows: st.windows.filter((_, j) => j !== i) }) },
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
            <Pressable accessibilityRole="button" onPress={() => void act(async () => (await fx.pick()) && (await syncFocus(midna.client, connection)))} style={({ pressed }) => [s.kv, { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }, pressed && { opacity: 0.6 }]}>
              <Text style={[s.key, { color: t.dim }]}>Held back</Text>
              <Text style={[s.value, { color: chosen ? t.ink : t.warn }]}>
                {chosen || "Choose apps"} <Text style={{ color: t.dimmer }}>›</Text>
              </Text>
            </Pressable>
            <Row k="Shield" v={shield} />
            <Row k="Today" v={`${minutes(st.minutesToday)} · met the shield ${st.hitsToday}×`} last />
          </Card>
          {chosen && !st.held ? <Button kind="primary" label="Hold them now" onPress={() => void change({ held: true, heldUntil: null })} /> : null}

          {lifted ? (
            <Button label="Put the shield back" onPress={() => void act(() => fx.endLift())} />
          ) : st.shielded ? (
            <View style={s.group}>
              <Text style={[s.heading, { color: t.ink }]}>Lift it</Text>
              <Field label="Why" value={reason} onChangeText={setReason} placeholder="Replying to Sam's DM" hint="midna keeps this, with how long, for your reviews." />
              <View style={s.chips}>
                {LIFTS.map((m) => (
                  <Pressable key={m} accessibilityRole="button" accessibilityState={{ selected: lift === m }} onPress={() => setLift(m)} style={[s.chip, { backgroundColor: lift === m ? t.primary : t.fill }]}>
                    <Text style={[s.chipText, { color: lift === m ? t.primaryInk : t.ink }]}>{m} min</Text>
                  </Pressable>
                ))}
              </View>
              <Button label={`Lift for ${lift} min of use`} disabled={reason.trim().length < 3} onPress={() => void doLift()} />
              {st.held ? <Button label="Let go of the hold" disabled={reason.trim().length < 3} onPress={() => void doLift(true)} /> : null}
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
            <Button small label="Save" onPress={() => void change({ offer: offer.trim() ? { title: offer.trim(), url: offerUrl.trim() || null } : null })} style={{ alignSelf: "flex-start" }} />
          </View>
        </>
      )}
      <Problem text={problem} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  body: { padding: 16, gap: 14 },
  title: { fontSize: 28, fontWeight: "700" },
  heading: { fontSize: 17, fontWeight: "600" },
  para: { fontSize: 15, lineHeight: 21 },
  card: { paddingVertical: 4, gap: 0 },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 11, gap: 16 },
  key: { fontSize: 17 },
  value: { fontSize: 17, flexShrink: 1, textAlign: "right" },
  group: { gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { height: 34, borderRadius: 17, paddingHorizontal: 14, justifyContent: "center" },
  chipText: { fontSize: 15, fontWeight: "500" },
});
