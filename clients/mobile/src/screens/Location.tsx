import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { PLACE_RADIUS_DEFAULT, type LocationState, type Place } from "@midna/protocol";
import type { PhoneConnection } from "../connection";
import { draftKey, useDraft } from "../drafts";
import { here, lastSent, locationSetup, preciseAccuracy, turnOff, turnOn, watch, type LocationSetup } from "../location";
import { ago } from "../locationQueue";
import { useTheme } from "../theme";
import { Button, Card, Field, Problem, time } from "../ui";
import type { Midna } from "../useMidna";

const NEW = "new";
/** The places midna suggests saving first. */
const SUGGESTED = ["Home", "Office", "Gym", "Masjid"];
/** How wide a place is: iOS is unreliable under 100 m. */
const SIZES = [100, 150, 300, 500];

/**
 * Location, in Settings: whether the phone reports where it is, when it last
 * did, and the saved places it watches. Off until the user turns it on,
 * after a plain account of what it does.
 */
export function LocationSettings({ midna, connection, onBack }: { midna: Midna; connection: PhoneConnection; onBack: () => void }) {
  const t = useTheme();
  const key = draftKey(connection);
  const [setup, setSetup] = useState<LocationSetup | null>(null);
  const [state, setState] = useState<LocationState | null>(null);
  const [sent, setSent] = useState<number | null>(lastSent);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const open = useDraft(`${key}:location:open`);

  const refresh = useCallback(async () => {
    setSetup(await locationSetup());
    setSent(lastSent());
    setState(await midna.client.location().catch(() => null));
  }, [midna.client]);

  // iPhone Settings may have changed while the app was away.
  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener("change", (s) => s === "active" && void refresh());
    return () => sub.remove();
  }, [refresh]);

  const on = async () => {
    setBusy(true);
    setProblem("");
    try {
      const now = await turnOn(midna.client, connection);
      if (now === "denied") setProblem("Location is off for midna in iPhone Settings. Turn it on there, under Privacy & Security → Location Services → midna.");
      await refresh();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const off = () =>
    Alert.alert("Turn off location?", "Your iPhone stops telling midna where you are. What midna has kept stays on midna.", [
      { text: "Cancel", style: "cancel" },
      { text: "Turn off", style: "destructive", onPress: () => void turnOff().then(refresh) },
    ]);

  if (setup === null)
    return (
      <View style={s.loading}>
        <ActivityIndicator color={t.dim} />
      </View>
    );

  const places = state?.places ?? [];
  const editing = open.value === NEW ? null : places.find((p) => String(p.id) === open.value);
  if (open.value && (open.value === NEW || editing))
    return (
      <PlaceEditor
        midna={midna}
        place={editing ?? null}
        places={places}
        draft={key}
        onBack={() => open.set("")}
        onDone={() => {
          open.set("");
          void refresh();
        }}
      />
    );

  return (
    <ScrollView testID="location" contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <Back label="Settings" onPress={onBack} />
      <Text style={[s.title, { color: t.ink }]}>Location</Text>

      {setup === "off" || setup === "denied" ? (
        <>
          <Text style={[s.lede, { color: t.dim }]}>midna can know where you are, so it can help with what's around you and notice when you get home or leave work.</Text>
          <Card>
            <Text style={[s.para, { color: t.ink2 }]}>Your iPhone sends midna your precise location as you move, every few tens of metres, and when you arrive at or leave a place you've saved. It stops while you stay put. midna can also ask where you are right now.</Text>
            <Text style={[s.para, { color: t.ink2 }]}>It goes only to your midna, on your own machine, and is kept there as your history.</Text>
            <Text style={[s.para, { color: t.ink2 }]}>iOS asks twice. Allow while using the app, then change to Always, and keep Precise Location on, so it works while the app is closed.</Text>
          </Card>
          <Problem text={problem} />
          {setup === "denied" ? (
            <Button kind="primary" label="Open iPhone Settings" onPress={() => void Linking.openSettings()} />
          ) : (
            <Button testID="location-on" kind="primary" label="Turn on location" busy={busy} onPress={() => void on()} />
          )}
        </>
      ) : (
        <>
          <Card style={s.card}>
            <Row k="Location" v={setup === "always" ? "On" : "Only while the app is open"} warn={setup !== "always"} />
            <Row k="Last update" v={sent ? `${time(sent)} · ${ago(Date.now() - sent)}` : "Not yet"} />
            {state?.latest ? <Row k="Where" v={state.place ? state.place.name : "Not at a saved place"} /> : null}
            <Row k="Kept on midna" v={state ? `${state.points.toLocaleString()} ${state.points === 1 ? "point" : "points"}` : "—"} last />
          </Card>
          {setup === "while-using" ? (
            <>
              <Text style={[s.note, { color: t.dim }]}>With Always, your iPhone sends where you are while the app is closed, and midna can ask. In iPhone Settings, choose Location → Always.</Text>
              <Button small label="Open iPhone Settings" onPress={() => void Linking.openSettings()} style={{ alignSelf: "flex-start" }} />
            </>
          ) : null}
          {!preciseAccuracy() ? (
            <>
              <Text style={[s.note, { color: t.dim }]}>Precise Location is off, so midna only gets roughly where you are, a few kilometres wide. In iPhone Settings, choose Location and turn on Precise Location.</Text>
              <Button small label="Open iPhone Settings" onPress={() => void Linking.openSettings()} style={{ alignSelf: "flex-start" }} />
            </>
          ) : null}

          <View style={s.top}>
            <Text style={[s.heading, { color: t.ink }]}>Places</Text>
            <Button small label="Add" onPress={() => open.set(NEW)} testID="place-add" />
          </View>
          {places.length === 0 ? (
            <Text style={[s.note, { color: t.dim }]}>No places yet. Save home, the office, the gym or the masjid while you're there, and midna hears when you arrive and leave.</Text>
          ) : (
            <View style={[s.list, { backgroundColor: t.panel, borderColor: t.line }]}>
              {places.map((p, n) => (
                <Pressable
                  key={p.id}
                  testID={`place-${p.id}`}
                  accessibilityRole="button"
                  onPress={() => open.set(String(p.id))}
                  style={({ pressed }) => [s.row, n > 0 && { borderTopColor: t.line, borderTopWidth: StyleSheet.hairlineWidth }, pressed && { backgroundColor: t.active }]}
                >
                  <Text style={[s.rowTitle, { color: t.ink }]}>{p.name}</Text>
                  <Text style={[s.rowMeta, { color: t.dim }]}>{state?.place?.id === p.id ? "You're here" : `${Math.round(p.radius)} m across`}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <Text style={[s.note, { color: t.dim }]}>midna can save and change places too, when you ask it.</Text>
          <Problem text={problem} />
          <Button kind="danger" label="Turn off location" onPress={off} style={{ marginTop: 8 }} />
        </>
      )}
    </ScrollView>
  );
}

/** One saved place, or a new one: its name and size; a new one is saved where the phone is. */
function PlaceEditor({ midna, place, places, draft, onBack, onDone }: { midna: Midna; place: Place | null; places: Place[]; draft: string; onBack: () => void; onDone: () => void }) {
  const t = useTheme();
  const key = `${draft}:location:${place?.id ?? NEW}`;
  const name = useDraft(`${key}:name`, place?.name ?? "");
  const size = useDraft(`${key}:size`, String(Math.round(place?.radius ?? PLACE_RADIUS_DEFAULT)));
  const [busy, setBusy] = useState<"save" | "move" | "delete" | null>(null);
  const [problem, setProblem] = useState("");
  const taken = new Set(places.map((p) => p.name.toLowerCase()));
  const suggested = place ? [] : SUGGESTED.filter((n) => !taken.has(n.toLowerCase()));

  const run = async (what: NonNullable<typeof busy>, work: () => Promise<void>) => {
    setBusy(what);
    setProblem("");
    try {
      await work();
      // The phone watches the places as they are now.
      await watch(await midna.client.places()).catch(() => {});
      name.clear();
      size.clear();
      onDone();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const radius = Number(size.value) || PLACE_RADIUS_DEFAULT;
  const save = () =>
    run("save", async () => {
      const n = name.value.trim();
      if (!n) throw new Error("A place needs a name.");
      if (!place) {
        if (taken.has(n.toLowerCase())) throw new Error(`There's already a place called ${n}.`);
        const fix = await here();
        await midna.client.savePlace({ name: n, lat: fix.lat, lon: fix.lon, radius });
        return;
      }
      const patch = { ...(n !== place.name ? { name: n } : {}), ...(radius !== Math.round(place.radius) ? { radius } : {}) };
      if (Object.keys(patch).length) await midna.client.editPlace(place.id, patch);
    });

  const move = () =>
    place &&
    run("move", async () => {
      const fix = await here();
      await midna.client.editPlace(place.id, { lat: fix.lat, lon: fix.lon });
    });

  const remove = () =>
    place &&
    Alert.alert(`Delete ${place.name}?`, "Your iPhone stops watching it. Where you've been there stays in your history.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void run("delete", () => midna.client.deletePlace(place.id).then(() => {})) },
    ]);

  const discard = () => {
    name.clear();
    size.clear();
    onBack();
  };

  return (
    <ScrollView testID="place-editor" contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <View style={s.top}>
        <Back label="Location" onPress={onBack} />
        <Pressable accessibilityRole="button" onPress={discard} hitSlop={12} style={s.back}>
          <Text style={[s.backText, { color: t.dim }]}>Discard</Text>
        </Pressable>
      </View>
      <Text style={[s.title, { color: t.ink }]}>{place ? place.name : "New place"}</Text>
      <Field testID="place-name" label="Name" value={name.value} onChangeText={name.set} placeholder="Home" autoCapitalize="words" />
      {suggested.length ? (
        <View style={s.chips}>
          {suggested.map((n) => (
            <Chip key={n} label={n} selected={name.value === n} onPress={() => name.set(n)} />
          ))}
        </View>
      ) : null}
      <View style={s.group}>
        <Text style={[s.label, { color: t.dim }]}>Size</Text>
        <View style={s.chips}>
          {SIZES.map((m) => (
            <Chip key={m} label={`${m} m`} selected={radius === m} onPress={() => size.set(String(m))} />
          ))}
        </View>
        <Text style={[s.hint, { color: t.dim }]}>How far around it counts as being there. A house or a gym is 100–150 m; a campus is more.</Text>
      </View>
      <Problem text={problem} />
      <Button testID="place-save" kind="primary" label={place ? "Save" : "Save here"} busy={busy === "save"} disabled={busy !== null && busy !== "save"} onPress={() => void save()} />
      {place ? null : <Text style={[s.hint, { color: t.dim, textAlign: "center" }]}>Saved where your iPhone is now.</Text>}
      {place ? (
        <>
          <Button label="Move it to where I am" busy={busy === "move"} disabled={busy !== null && busy !== "move"} onPress={() => void move()} />
          <Button kind="danger" label="Delete place" busy={busy === "delete"} onPress={remove} style={{ marginTop: 4 }} />
        </>
      ) : null}
    </ScrollView>
  );
}

function Back({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Back to ${label}`} onPress={onPress} hitSlop={12} style={s.back}>
      <Text style={[s.backText, { color: t.dim }]}>‹ {label}</Text>
    </Pressable>
  );
}

function Row({ k, v, warn, last }: { k: string; v: string; warn?: boolean; last?: boolean }) {
  const t = useTheme();
  return (
    <View style={[s.kv, !last && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <Text style={[s.key, { color: t.dim }]}>{k}</Text>
      <Text numberOfLines={1} style={[s.value, { color: warn ? t.warn : t.ink }]}>
        {v}
      </Text>
    </View>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [s.chip, { borderColor: selected ? t.ink : t.line2, backgroundColor: selected ? t.active : t.panel, opacity: pressed ? 0.7 : 1 }]}
    >
      <Text style={[s.chipText, { color: selected ? t.ink : t.ink2 }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  body: { padding: 16, gap: 14 },
  loading: { flex: 1, paddingTop: 60, alignItems: "center" },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  title: { fontSize: 24, fontWeight: "700" },
  heading: { fontSize: 17, fontWeight: "600" },
  lede: { fontSize: 15, lineHeight: 21, marginTop: -6 },
  para: { fontSize: 15, lineHeight: 21 },
  card: { paddingVertical: 4, gap: 0 },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 11, gap: 16 },
  key: { fontSize: 15 },
  value: { fontSize: 15, flexShrink: 1, textAlign: "right" },
  list: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  row: { paddingHorizontal: 16, paddingVertical: 12, minHeight: 52, justifyContent: "center", gap: 2 },
  rowTitle: { fontSize: 16.5, fontWeight: "500" },
  rowMeta: { fontSize: 14 },
  note: { fontSize: 13.5, lineHeight: 19, paddingHorizontal: 4 },
  back: { minHeight: 44, justifyContent: "center" },
  backText: { fontSize: 16 },
  group: { gap: 8 },
  label: { fontSize: 13, fontWeight: "500" },
  hint: { fontSize: 12.5, lineHeight: 17 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { height: 32, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 13, justifyContent: "center" },
  chipText: { fontSize: 14, fontWeight: "500" },
});
