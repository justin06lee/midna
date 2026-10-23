import { useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PhoneConnection } from "../connection";
import { useTheme } from "../theme";
import { Button } from "../ui";
import { useMidna } from "../useMidna";
import { Approvals } from "./Approvals";
import { Chat } from "./Chat";
import { Settings } from "./Settings";

type Tab = "chat" | "approvals" | "settings";

/** Paired: the header, and Chat, Approvals and Settings as tabs along the bottom. */
export function Main({ connection, onPairAgain, onUnpaired }: { connection: PhoneConnection; onPairAgain: () => void; onUnpaired: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const midna = useMidna(connection);
  const [tab, setTab] = useState<Tab>("chat");
  const waiting = [...midna.approvals.values()].filter((a) => a.state === "pending").length;
  const offline = midna.link === "lost";

  if (midna.link === "unpaired") {
    return (
      <View style={[s.root, s.gone, { backgroundColor: t.bg, paddingTop: insets.top + 60 }]}>
        <Text style={[s.goneTitle, { color: t.ink }]}>This phone isn't paired any more</Text>
        <Text style={[s.goneText, { color: t.dim }]}>midna no longer knows this phone's token: it was unpaired from another device, or midna was set up again. Pair again with a new code from `midna pair`.</Text>
        <Button label="Pair again" kind="primary" onPress={onPairAgain} />
      </View>
    );
  }

  return (
    <View style={[s.root, { backgroundColor: t.bg }]}>
      <View style={[s.header, { paddingTop: insets.top + 6, borderBottomColor: t.line }]}>
        <View style={[s.mark, { opacity: offline ? 0.35 : 1 }]}>
          <Image accessibilityLabel="midna" source={require("../../assets/icon.png")} style={s.icon} />
          {midna.thinking ? <ActivityIndicator size="small" color={t.dim} style={s.spinner} /> : null}
        </View>
      </View>
      <View style={[s.body, { opacity: offline ? 0.45 : 1 }]}>
        {tab === "chat" && <Chat midna={midna} connection={connection} onOpenApprovals={() => setTab("approvals")} />}
        {tab === "approvals" && <Approvals midna={midna} />}
        {tab === "settings" && <Settings midna={midna} connection={connection} onPairAgain={onPairAgain} onUnpaired={onUnpaired} />}
      </View>
      <View style={[s.tabs, { paddingBottom: Math.max(insets.bottom, 8), borderTopColor: t.line, backgroundColor: t.bg }]}>
        {(["chat", "approvals", "settings"] as const).map((k) => (
          <Pressable key={k} testID={`tab-${k}`} accessibilityRole="tab" accessibilityState={{ selected: tab === k }} onPress={() => setTab(k)} style={s.tab}>
            <Text style={[s.tabText, { color: tab === k ? t.ink : t.dimmer, fontWeight: tab === k ? "600" : "500" }]}>
              {k === "chat" ? "Chat" : k === "approvals" ? "Approvals" : "Settings"}
            </Text>
            {k === "approvals" && waiting > 0 ? (
              <View style={[s.badge, { backgroundColor: t.danger }]}>
                <Text style={s.badgeText}>{waiting}</Text>
              </View>
            ) : null}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { alignItems: "center", paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  mark: { alignItems: "center", justifyContent: "center", height: 30 },
  icon: { width: 28, height: 28, borderRadius: 7 },
  spinner: { position: "absolute", left: 38 },
  body: { flex: 1 },
  tabs: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
  tab: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, height: 36 },
  tabText: { fontSize: 15 },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#fff", fontSize: 11.5, fontWeight: "700" },
  gone: { paddingHorizontal: 24, gap: 14 },
  goneTitle: { fontSize: 24, fontWeight: "700" },
  goneText: { fontSize: 15.5, lineHeight: 21 },
});
