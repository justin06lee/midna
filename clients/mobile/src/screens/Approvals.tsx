import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { Approval } from "@midna/protocol";
import { approvalOutcome } from "../lines";
import { useTheme } from "../theme";
import { Card, time } from "../ui";
import type { Midna } from "../useMidna";
import { ApprovalButtons } from "./Chat";

/** "1:42 left" */
function left(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")} left`;
}

/**
 * What midna wants to do on your computers and waits for a yes on — each
 * answer behind Face ID — and how the ones seen here ended. No answer in
 * time is a no.
 */
export function Approvals({ midna }: { midna: Midna }) {
  const t = useTheme();
  const [now, setNow] = useState(Date.now());
  const all = useMemo(() => [...midna.approvals.values()], [midna.approvals]);
  const waiting = all.filter((a) => a.state === "pending").sort((a, b) => a.requestedAt - b.requestedAt);
  const over = all.filter((a) => a.state !== "pending").sort((a, b) => (b.answeredAt ?? b.expiresAt) - (a.answeredAt ?? a.expiresAt));
  useEffect(() => {
    if (!waiting.length) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [waiting.length]);

  return (
    <ScrollView testID="approvals" contentContainerStyle={s.body}>
      {waiting.length === 0 ? (
        <View style={s.empty}>
          <Text style={[s.emptyTitle, { color: t.ink }]}>Nothing waits for your yes</Text>
          <Text style={[s.emptyText, { color: t.dim }]}>When midna wants to do something risky on one of your computers, it asks here, on the computer itself, in chat and on Telegram. The first answer wins.</Text>
        </View>
      ) : (
        waiting.map((a) => <Waiting key={a.id} a={a} now={now} midna={midna} />)
      )}
      {over.length > 0 && (
        <View style={s.section}>
          <Text style={[s.heading, { color: t.dim }]}>Earlier</Text>
          {over.map((a) => (
            <View key={a.id} style={[s.past, { borderBottomColor: t.line }]}>
              <Text style={[s.pastSummary, { color: t.ink }]}>{a.summary}</Text>
              <Text style={[s.pastMeta, { color: t.dim }]}>
                {approvalOutcome(a)} · {time(a.answeredAt ?? a.requestedAt)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function Waiting({ a, now, midna }: { a: Approval; now: number; midna: Midna }) {
  const t = useTheme();
  const remaining = a.expiresAt - now;
  return (
    <Card>
      <View style={s.top}>
        <Text style={[s.device, { color: t.dim }]}>
          {a.deviceName} · {a.capability}
        </Text>
        <Text style={[s.left, { color: remaining < 30_000 ? t.danger : t.dim }]}>{left(remaining)}</Text>
      </View>
      <Text style={[s.summary, { color: t.ink }]}>midna wants to {a.summary}</Text>
      <ApprovalButtons approval={a} midna={midna} canSend={midna.link === "live" && remaining > 0} />
    </Card>
  );
}

const s = StyleSheet.create({
  body: { padding: 14, gap: 12 },
  empty: { paddingTop: 60, paddingHorizontal: 18, gap: 8, alignItems: "center" },
  emptyTitle: { fontSize: 18, fontWeight: "600" },
  emptyText: { fontSize: 15, lineHeight: 21, textAlign: "center" },
  section: { marginTop: 18, gap: 2 },
  heading: { fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 },
  past: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 3 },
  pastSummary: { fontSize: 15 },
  pastMeta: { fontSize: 13 },
  top: { flexDirection: "row", justifyContent: "space-between" },
  device: { fontSize: 13, fontWeight: "500" },
  left: { fontSize: 13, fontVariant: ["tabular-nums"] },
  summary: { fontSize: 17, lineHeight: 23, fontWeight: "500" },
});
