import { useEffect, useState } from "react";
import { Modal, Platform, Settings as RNSettings, StyleSheet, Text, View } from "react-native";
import TabView from "react-native-bottom-tabs";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SymbolViewProps } from "expo-symbols";
import type { PhoneConnection } from "../connection";
import { onFocusTap } from "../focus";
import { type as face, useTheme } from "../theme";
import { Button, CircleButton, SheetBar } from "../ui";
import { useMidna } from "../useMidna";
import { Approvals } from "./Approvals";
import { Chat } from "./Chat";
import { useModels } from "./Models";
import { Settings } from "./Settings";
import { Today } from "./Today";
import { preview } from "../preview";
import { Vault } from "./Vault";

type Tab = "chat" | "today" | "vault";
type Sheet = "approvals" | "settings" | null;

/** What a preview launch asks to see (-midnaTab today; preview.ts): a tab, or one of the two sheets. */
const asked = ((t) => (preview && typeof t === "string" ? t : ""))(Platform.OS === "ios" ? (RNSettings.get("midnaTab") as unknown) : null);
const firstTab: Tab = asked === "today" || asked === "vault" ? asked : "chat";
const firstSheet: Sheet = asked === "approvals" || asked === "settings" ? asked : null;

const TABS: Record<Tab, { name: string; icon: Extract<SymbolViewProps["name"], string> }> = {
  chat: { name: "Chat", icon: "bubble.left.fill" },
  today: { name: "Today", icon: "calendar" },
  vault: { name: "Vault", icon: "key.fill" },
};
const ROUTES = (Object.keys(TABS) as Tab[]).map((key) => ({ key, title: TABS[key].name, focusedIcon: { sfSymbol: TABS[key].icon }, testID: `tab-${key}` }));

/** What the system's tab bar covers at the foot of a screen: its own height, and how far it floats off the bottom edge. */
const BAR = 62;
const barBottom = (inset: number) => Math.max(inset - 13, 8);

/** A colour of the theme with no opacity, for a fade to nothing that doesn't pass through grey. */
const clear = (hex: string) => `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, 0)`;

/**
 * Paired. The system's own tab bar (Chat, Today, Vault: Liquid Glass on
 * iOS 26, floating over the foot of the screen), and over the top a clear
 * bar with midna's name between two glass buttons (what waits for a yes,
 * and Settings: both open as sheets). Each screen runs under both, so the
 * glass has something to bend.
 */
export function Main({ connection, onPairAgain, onUnpaired }: { connection: PhoneConnection; onPairAgain: () => void; onUnpaired: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const midna = useMidna(connection);
  const [tab, setTab] = useState<Tab>(firstTab);
  const [sheet, setSheet] = useState<Sheet>(firstSheet);
  // Every brain's list is asked for at once: the model's menu is the system's, and opens without telling us.
  const models = useModels(midna, true);
  // A shield's "Ask midna" opens Screen Time's lift, which asks why.
  const [focusAsk, setFocusAsk] = useState(0);
  useEffect(() => {
    const sub = onFocusTap(() => {
      setSheet("settings");
      setFocusAsk((n) => n + 1);
    });
    return () => sub.remove();
  }, []);
  const waiting = [...midna.approvals.values()].filter((a) => a.state === "pending").length;
  const offline = midna.link === "lost";

  if (midna.link === "unpaired") {
    return (
      <View style={[s.root, s.gone, { backgroundColor: t.ground, paddingTop: insets.top + 72 }]}>
        <Text style={[s.goneTitle, { color: t.ink }]}>This phone isn't paired any more</Text>
        <Text style={[s.goneText, { color: t.inkSoft }]}>midna no longer knows this phone's token: it was unpaired from another device, or midna was set up again. Pair again with a new code from `midna pair`.</Text>
        <Button label="Pair Again" kind="primary" onPress={onPairAgain} />
      </View>
    );
  }

  // What a screen must leave clear: under the bar at its top, and over the tab bar at its foot.
  const head = insets.top + 54;
  const foot = barBottom(insets.bottom) + BAR + 8;
  // How the bar says midna stands, when that is worth saying.
  const standing = offline ? "Offline" : midna.link === "connecting" ? "Connecting…" : midna.thinking ? "Thinking…" : null;
  const bg = tab === "chat" ? t.paper : t.ground;
  return (
    <View style={[s.root, { backgroundColor: bg }]}>
      <View style={[s.root, { opacity: offline ? 0.5 : 1 }]}>
        <TabView
          navigationState={{ index: ROUTES.findIndex((r) => r.key === tab), routes: ROUTES }}
          onIndexChange={(i) => setTab(ROUTES[i]!.key)}
          getLazy={() => false}
          translucent
          hapticFeedbackEnabled
          tabBarActiveTintColor={t.accent}
          tabBarInactiveTintColor={t.ink}
          tabLabelStyle={{ fontFamily: "SpaceGrotesk-Medium", fontSize: 11 }}
          getSceneStyle={({ route }) => ({ backgroundColor: route.key === "chat" ? t.paper : t.ground })}
          renderScene={({ route }) =>
            route.key === "chat" ? (
              <Chat midna={midna} connection={connection} head={head} foot={foot} models={models} onOpenApprovals={() => setSheet("approvals")} />
            ) : route.key === "today" ? (
              <Today midna={midna} head={head} foot={foot} />
            ) : (
              <Vault midna={midna} connection={connection} head={head} foot={foot} />
            )
          }
        />
      </View>
      {/* The bar: clear, so what scrolls shows through its glass; a fade behind it keeps the name readable. */}
      <View pointerEvents="box-none" style={[s.header, { paddingTop: insets.top + 2, opacity: offline ? 0.5 : 1 }]}>
        <LinearGradient pointerEvents="none" colors={[bg, bg, clear(bg)]} locations={[0, 0.72, 1]} style={[StyleSheet.absoluteFill, s.fade]} />
        <CircleButton testID="open-approvals" icon="hand.raised" label={waiting > 0 ? `Approvals, ${waiting} waiting` : "Approvals"} dot={waiting > 0} onPress={() => setSheet("approvals")} />
        <View pointerEvents="none" style={s.title}>
          <Text numberOfLines={1} style={[tab === "chat" ? s.wordmark : s.name, { color: t.ink }]}>
            {tab === "chat" ? "midna" : TABS[tab].name}
          </Text>
          {standing ? (
            <Text testID="standing" numberOfLines={1} style={[s.standing, { color: t.inkSoft }]}>
              {standing}
            </Text>
          ) : null}
        </View>
        <CircleButton testID="open-settings" icon="gearshape" label="Settings" onPress={() => setSheet("settings")} />
      </View>
      <Modal visible={sheet === "approvals"} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSheet(null)}>
        <View style={[s.root, { backgroundColor: t.ground }]}>
          <SheetBar title="Approvals" testID="approvals-done" onDone={() => setSheet(null)} />
          <Approvals midna={midna} />
        </View>
      </Modal>
      <Modal visible={sheet === "settings"} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSheet(null)}>
        <View style={[s.root, { backgroundColor: t.ground }]}>
          <Settings midna={midna} connection={connection} models={models} onDone={() => setSheet(null)} onPairAgain={onPairAgain} onUnpaired={onUnpaired} focusAsk={focusAsk} />
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 8, gap: 12 },
  // Solid behind the name, then fading out past the bar, so what scrolls is never cut at a line nor read through the name.
  fade: { bottom: -22 },
  title: { flex: 1, alignItems: "center", justifyContent: "center", height: 44 },
  wordmark: { ...face(22, "bold"), letterSpacing: -0.4 },
  name: face(17, "bold"),
  standing: { ...face(11), marginTop: -1 },
  gone: { paddingHorizontal: 24, gap: 16 },
  goneTitle: face(28, "bold", 34),
  goneText: face(16, "regular", 22),
});
