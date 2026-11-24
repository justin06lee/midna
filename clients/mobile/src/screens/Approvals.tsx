import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { plainText, type Approval } from "@midna/protocol";
import { approvalOutcome } from "../lines";
import { useTheme, type as face } from "../theme";
import { Card, Group, GroupTitle, time } from "../ui";
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
          <Text style={[s.emptyText, { color: t.inkSoft }]}>When midna wants to do something risky on one of your computers, it asks here, on the computer itself, in chat and on Telegram. The first answer wins.</Text>
        </View>
      ) : (
        waiting.map((a) => <Waiting key={a.id} a={a} now={now} midna={midna} />)
      )}
      {over.length > 0 && (
        <View style={s.section}>
          <GroupTitle>Earlier</GroupTitle>
          <Group>
            {over.map((a, n) => (
              <View key={a.id} style={s.past}>
                <View style={[s.pastBody, n > 0 && { borderTopColor: t.hairline, borderTopWidth: StyleSheet.hairlineWidth }]}>
                  <Text style={[s.pastSummary, { color: t.ink }]}>{plainText(a.summary)}</Text>
                  <Text style={[s.pastMeta, { color: t.inkSoft }]}>
                    {approvalOutcome(a)} · {time(a.answeredAt ?? a.requestedAt)}
                  </Text>
                </View>
              </View>
            ))}
          </Group>
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
        <Text style={[s.device, { color: t.inkSoft }]}>
          {a.deviceName} · {a.capability}
        </Text>
        <Text style={[s.left, { color: remaining < 30_000 ? t.destructive : t.accent }]}>{left(remaining)}</Text>
      </View>
      <Text style={[s.summary, { color: t.ink }]}>midna wants to {plainText(a.summary)}</Text>
      <ApprovalButtons approval={a} midna={midna} canSend={midna.link === "live" && remaining > 0} />
    </Card>
  );
}

const s = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 48, gap: 16 },
  empty: { paddingTop: 72, paddingHorizontal: 20, gap: 10, alignItems: "center" },
  emptyTitle: face(19, "bold"),
  emptyText: { ...face(15, "regular", 21), textAlign: "center" },
  section: { marginTop: 8, gap: 24 },
  past: { paddingLeft: 16 },
  pastBody: { paddingVertical: 12, paddingRight: 16, gap: 3 },
  pastSummary: face(15, "regular", 20),
  pastMeta: face(13),
  top: { flexDirection: "row", justifyContent: "space-between" },
  device: face(13),
  left: { ...face(13, "medium"), fontVariant: ["tabular-nums"] },
  summary: face(17, "medium", 23),
});
