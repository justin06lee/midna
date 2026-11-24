import { useEffect, useState } from "react";
import { Modal, Platform, Pressable, Settings as RNSettings, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SymbolViewProps } from "expo-symbols";
import type { PhoneConnection } from "../connection";
import { onFocusTap } from "../focus";
import { type as face, useTheme } from "../theme";
import { Button, CircleButton, Glass, Icon, SheetBar } from "../ui";
import { useMidna } from "../useMidna";
import { Approvals } from "./Approvals";
import { Chat } from "./Chat";
import { ModelSheet, modelNow, useModels } from "./Models";
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

const TABS: Record<Tab, { name: string; icon: SymbolViewProps["name"] }> = {
  chat: { name: "Chat", icon: "bubble.left.fill" },
  today: { name: "Today", icon: "calendar" },
  vault: { name: "Vault", icon: "key.fill" },
};

/** The tab capsule's height, and how far it stands off the bottom of the screen. */
const BAR = 60;
const barBottom = (inset: number) => Math.max(inset - 12, 10);

/**
 * Paired. A bar with midna's name between two round buttons (what waits for
 * a yes, and Settings: both open as sheets), the screen, and Chat, Today and
 * Vault in a capsule that floats over its foot.
 */
export function Main({ connection, onPairAgain, onUnpaired }: { connection: PhoneConnection; onPairAgain: () => void; onUnpaired: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const midna = useMidna(connection);
  const [tab, setTab] = useState<Tab>(firstTab);
  const [sheet, setSheet] = useState<Sheet>(firstSheet);
  const [picking, setPicking] = useState(false);
  const models = useModels(midna, picking || sheet === "settings");
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
  const model = modelNow(midna, models);

  if (midna.link === "unpaired") {
    return (
      <View style={[s.root, s.gone, { backgroundColor: t.ground, paddingTop: insets.top + 72 }]}>
        <Text style={[s.goneTitle, { color: t.ink }]}>This phone isn't paired any more</Text>
        <Text style={[s.goneText, { color: t.inkSoft }]}>midna no longer knows this phone's token: it was unpaired from another device, or midna was set up again. Pair again with a new code from `midna pair`.</Text>
        <Button label="Pair Again" kind="primary" onPress={onPairAgain} />
      </View>
    );
  }

  // What the screen under the floating capsule must leave clear at its foot.
  const foot = barBottom(insets.bottom) + BAR + 8;
  // How the bar says midna stands, when that is worth saying.
  const standing = offline ? "Offline" : midna.link === "connecting" ? "Connecting…" : midna.thinking ? "Thinking…" : null;
  const bg = tab === "chat" ? t.paper : t.ground;
  return (
    <View style={[s.root, { backgroundColor: bg }]}>
      <View style={[s.header, { paddingTop: insets.top + 2 }]}>
        <CircleButton testID="open-approvals" icon="hand.raised" label={waiting > 0 ? `Approvals, ${waiting} waiting` : "Approvals"} dot={waiting > 0} onPress={() => setSheet("approvals")} />
        <View style={s.title}>
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
      <View style={[s.body, { opacity: offline ? 0.5 : 1 }]}>
        {tab === "chat" && <Chat midna={midna} connection={connection} foot={foot} model={model} onPickModel={() => setPicking(true)} onOpenApprovals={() => setSheet("approvals")} />}
        {tab === "today" && <Today midna={midna} foot={foot} />}
        {tab === "vault" && <Vault midna={midna} connection={connection} foot={foot} />}
      </View>
      <View pointerEvents="box-none" style={[s.dock, { bottom: barBottom(insets.bottom) }]}>
        <Glass lifted style={s.tabs}>
          {(Object.keys(TABS) as Tab[]).map((k) => (
            <Pressable key={k} testID={`tab-${k}`} accessibilityRole="tab" accessibilityLabel={TABS[k].name} accessibilityState={{ selected: tab === k }} onPress={() => setTab(k)} style={[s.tab, tab === k && { backgroundColor: t.fill }]}>
              <Icon name={TABS[k].icon} size={21} color={tab === k ? t.accent : t.ink} />
              <Text style={[s.tabText, { color: tab === k ? t.accent : t.ink }]}>{TABS[k].name}</Text>
            </Pressable>
          ))}
        </Glass>
      </View>
      <ModelSheet midna={midna} models={models} open={picking} onClose={() => setPicking(false)} />
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
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 8, gap: 12 },
  title: { flex: 1, alignItems: "center", justifyContent: "center", height: 44 },
  wordmark: { ...face(22, "bold"), letterSpacing: -0.4 },
  name: face(17, "bold"),
  standing: { ...face(11), marginTop: -1 },
  body: { flex: 1 },
  dock: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  tabs: { flexDirection: "row", height: BAR, borderRadius: BAR / 2, padding: 4, gap: 2, overflow: "hidden" },
  tab: { width: 86, height: BAR - 8, borderRadius: (BAR - 8) / 2, alignItems: "center", justifyContent: "center", gap: 3 },
  tabText: face(11, "medium"),
  gone: { paddingHorizontal: 24, gap: 16 },
  goneTitle: face(28, "bold", 34),
  goneText: face(16, "regular", 22),
});
