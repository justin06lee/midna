import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PhoneConnection } from "../connection";
import { onFocusTap } from "../focus";
import { useTheme } from "../theme";
import { Button } from "../ui";
import { useMidna } from "../useMidna";
import { Approvals } from "./Approvals";
import { Chat } from "./Chat";
import { ModelSheet, modelNow, useModels } from "./Models";
import { Settings } from "./Settings";
import { Vault } from "./Vault";

type Tab = "chat" | "approvals" | "vault" | "settings";

const TABS: Record<Tab, string> = { chat: "Chat", approvals: "Approvals", vault: "Vault", settings: "Settings" };
/** Template images: the tab bar tints them (scripts/tabicons.ts in the desktop app draws them). */
const ICONS: Record<Tab, number> = {
  chat: require("../../assets/tab-chat.png"),
  approvals: require("../../assets/tab-approvals.png"),
  vault: require("../../assets/tab-vault.png"),
  settings: require("../../assets/tab-settings.png"),
};

/** Paired: the header (on Chat it names the model and opens the sheet that switches it), and Chat, Approvals, Vault and Settings as tabs along the bottom. */
export function Main({ connection, onPairAgain, onUnpaired }: { connection: PhoneConnection; onPairAgain: () => void; onUnpaired: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const midna = useMidna(connection);
  const [tab, setTab] = useState<Tab>("chat");
  const [picking, setPicking] = useState(false);
  const models = useModels(midna, picking);
  // A shield's "Ask midna" opens Screen Time's lift, which asks why.
  const [focusAsk, setFocusAsk] = useState(0);
  useEffect(() => {
    const sub = onFocusTap(() => {
      setTab("settings");
      setFocusAsk((n) => n + 1);
    });
    return () => sub.remove();
  }, []);
  const waiting = [...midna.approvals.values()].filter((a) => a.state === "pending").length;
  const offline = midna.link === "lost";

  if (midna.link === "unpaired") {
    return (
      <View style={[s.root, s.gone, { backgroundColor: t.grouped, paddingTop: insets.top + 60 }]}>
        <Text style={[s.goneTitle, { color: t.ink }]}>This phone isn't paired any more</Text>
        <Text style={[s.goneText, { color: t.dim }]}>midna no longer knows this phone's token: it was unpaired from another device, or midna was set up again. Pair again with a new code from `midna pair`.</Text>
        <Button label="Pair again" kind="primary" onPress={onPairAgain} />
      </View>
    );
  }

  // The conversation sits on a plain screen; the rest are grouped rows, on the grouped grey.
  const bg = tab === "chat" ? t.bg : t.grouped;
  return (
    <View style={[s.root, { backgroundColor: bg }]}>
      <View style={[s.header, { paddingTop: insets.top, borderBottomColor: t.line, opacity: offline ? 0.45 : 1 }]}>
        <View style={s.side}>
          <Image accessibilityLabel="midna" source={require("../../assets/mark.png")} style={[s.icon, { tintColor: t.ink }]} />
        </View>
        {tab === "chat" ? (
          <Pressable testID="header-model" accessibilityRole="button" accessibilityLabel={`Model: ${modelNow(midna, models)}. Change it`} hitSlop={8} onPress={() => setPicking(true)} style={({ pressed }) => [s.model, pressed && { opacity: 0.5 }]}>
            <Text numberOfLines={1} style={[s.title, { color: t.ink }]}>
              {modelNow(midna, models)}
            </Text>
            <Text style={[s.caret, { color: t.dim }]}>›</Text>
          </Pressable>
        ) : (
          <Text style={[s.title, s.plain, { color: t.ink }]}>{TABS[tab]}</Text>
        )}
        <View style={[s.side, s.right]}>{midna.thinking ? <ActivityIndicator size="small" color={t.dim} /> : null}</View>
      </View>
      <View style={[s.body, { opacity: offline ? 0.45 : 1 }]}>
        {tab === "chat" && <Chat midna={midna} connection={connection} onOpenApprovals={() => setTab("approvals")} />}
        {tab === "approvals" && <Approvals midna={midna} />}
        {tab === "vault" && <Vault midna={midna} connection={connection} />}
        {tab === "settings" && <Settings midna={midna} connection={connection} onPairAgain={onPairAgain} onUnpaired={onUnpaired} focusAsk={focusAsk} model={modelNow(midna, models)} onPickModel={() => setPicking(true)} />}
      </View>
      <View style={[s.tabs, { paddingBottom: Math.max(insets.bottom, 4), borderTopColor: t.line, backgroundColor: bg }]}>
        {(Object.keys(TABS) as Tab[]).map((k) => (
          <Pressable key={k} testID={`tab-${k}`} accessibilityRole="tab" accessibilityLabel={TABS[k]} accessibilityState={{ selected: tab === k }} onPress={() => setTab(k)} style={s.tab}>
            <View>
              <Image source={ICONS[k]} style={[s.tabIcon, { tintColor: tab === k ? t.primary : t.dim }]} />
              {k === "approvals" && waiting > 0 ? (
                <View style={[s.badge, { backgroundColor: t.danger }]}>
                  <Text style={s.badgeText}>{waiting}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[s.tabText, { color: tab === k ? t.primary : t.dim }]}>{TABS[k]}</Text>
          </Pressable>
        ))}
      </View>
      <ModelSheet midna={midna} models={models} open={picking} onClose={() => setPicking(false)} />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  side: { width: 44, height: 44, justifyContent: "center" },
  right: { alignItems: "flex-end" },
  icon: { width: 24, height: 24 },
  model: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, height: 44 },
  title: { flexShrink: 1, textAlign: "center", fontSize: 17, fontWeight: "600" },
  plain: { flex: 1 },
  caret: { fontSize: 20, lineHeight: 22, fontWeight: "600", transform: [{ rotate: "90deg" }] },
  body: { flex: 1 },
  tabs: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6 },
  tab: { flex: 1, alignItems: "center", gap: 2, height: 44 },
  tabIcon: { width: 26, height: 26 },
  tabText: { fontSize: 10, fontWeight: "500" },
  badge: { position: "absolute", top: -3, right: -10, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  gone: { paddingHorizontal: 24, gap: 14 },
  goneTitle: { fontSize: 28, fontWeight: "700" },
  goneText: { fontSize: 17, lineHeight: 22 },
});
