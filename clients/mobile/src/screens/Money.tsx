import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { MidnaError, budgetLine, budgetUse, dayLabel, entryAmount, entryNote, ledgerDays, ledgerEmpty, localDay, money, moneySums, monthName, zakatLine, type Ledger, type LedgerBudget, type LedgerEntry } from "@midna/protocol";
import { type as face, useTheme, type Theme } from "../theme";
import { Button, Group, GroupNote, GroupTitle, Problem, Row } from "../ui";
import type { Midna } from "../useMidna";

/** How often the ledger is asked for again while the screen is up; a turn of midna's ending asks at once. */
const REFETCH_MS = 5 * 60_000;
/** How many categories and entries are shown before the rest is left to a question. */
const CATEGORIES = 6;
const ENTRIES = 40;

/**
 * What King of Greed holds, as midna's host reads it. Asked for when the link comes up, when the app comes
 * forward, and when a turn of midna's ends: that is when an entry may just have been made.
 */
function useLedger(midna: Midna) {
  const { client, link, thinking } = midna;
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [problem, setProblem] = useState("");
  const [none, setNone] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    async (fresh = false) => {
      setLoading(true);
      try {
        setLedger(await client.ledger(fresh));
        setProblem("");
        setNone(false);
      } catch (err) {
        // 503: no ledger on this host. 404: a host from before it could be read.
        if (err instanceof MidnaError && (err.status === 503 || err.status === 404)) setNone(true);
        else setProblem(`Couldn't read the ledger: ${(err as Error).message}`);
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  const live = link === "live";
  useEffect(() => {
    if (!live) return;
    void load();
    const again = setInterval(() => void load(), REFETCH_MS);
    const fg = AppState.addEventListener("change", (s) => s === "active" && void load());
    return () => {
      clearInterval(again);
      fg.remove();
    };
  }, [live, load]);

  const wasThinking = useRef(false);
  useEffect(() => {
    if (wasThinking.current && !thinking) void load(true);
    wasThinking.current = thinking !== null;
  }, [thinking, load]);

  return { ledger, problem, none, loading, load };
}

/**
 * Money: what the user holds, how the month stands against its budgets, and the latest entries, from the
 * ledger midna keeps with them (King of Greed). Read only: an entry is made by telling midna in the chat.
 */
export function Money({ midna, head, foot }: { midna: Midna; head: number; foot: number }) {
  const t = useTheme();
  const { ledger, problem, none, loading, load } = useLedger(midna);

  if (none)
    return (
      <View style={[s.empty, { paddingTop: head + 60 }]}>
        <Text style={[s.emptyTitle, { color: t.ink }]}>No ledger on this midna</Text>
        <Text style={[s.emptyText, { color: t.inkSoft }]}>King of Greed keeps the ledger on midna's host. Once it is set up there, your money shows here.</Text>
      </View>
    );
  if (!ledger)
    return (
      <View style={[s.empty, { paddingTop: head + 60 }]}>
        {problem ? (
          <>
            <Text style={[s.emptyText, { color: t.inkSoft }]}>{problem}</Text>
            <Button small label="Try again" onPress={() => void load(true)} />
          </>
        ) : (
          <ActivityIndicator color={t.inkSoft} />
        )}
      </View>
    );

  const month = monthName(ledger.month.month);
  const assets = ledger.accounts.filter((a) => a.kind === "asset");
  const debts = ledger.accounts.filter((a) => a.kind === "debt" && a.balance !== 0);
  const days = ledgerDays(ledger.recent.slice(0, ENTRIES));
  const today = localDay(Date.now());
  const toPurify = moneySums(ledger.riba.toPurify, "");
  const hadInterest = Object.values(ledger.riba.received).some((n) => n > 0);

  return (
    <ScrollView testID="money" contentContainerStyle={[s.body, { paddingTop: head + 8, paddingBottom: foot + 24 }]} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load(true)} />}>
      <View style={s.hero}>
        <Text style={[s.heroLabel, { color: t.inkSoft }]}>Net worth</Text>
        <Text testID="money-worth" style={[s.heroFigure, { color: t.ink }]} numberOfLines={1} adjustsFontSizeToFit>
          {money(ledger.worth.total, ledger.worth.currency)}
        </Text>
        <View style={s.stats}>
          <View style={s.stat}>
            <Text style={[s.statLabel, { color: t.inkSoft }]}>{`Spent in ${month}`}</Text>
            <Text style={[s.statFigure, { color: t.ink }]}>{moneySums(ledger.month.spent, money(0, ledger.worth.currency))}</Text>
          </View>
          <View style={s.stat}>
            <Text style={[s.statLabel, { color: t.inkSoft }]}>Earned</Text>
            <Text style={[s.statFigure, { color: t.ink }]}>{moneySums(ledger.month.earned, money(0, ledger.worth.currency))}</Text>
          </View>
        </View>
        {ledger.worth.missingRates.length ? <Text style={[s.heroNote, { color: t.inkFaint }]}>{`Without ${ledger.worth.missingRates.join(", ")}: no exchange rate.`}</Text> : null}
      </View>
      <Problem text={problem} />

      {ledgerEmpty(ledger) ? (
        <GroupNote>Nothing in the ledger yet. Tell midna which accounts you keep and what you spend ("5,600원 starbucks"), and it shows here.</GroupNote>
      ) : null}

      {ledger.budgets.length ? (
        <>
          <GroupTitle>{`Budgets · ${month}`}</GroupTitle>
          <Group>
            {ledger.budgets.map((b, n) => (
              <Budget key={b.name} budget={b} first={n === 0} t={t} />
            ))}
          </Group>
        </>
      ) : null}

      {assets.length ? (
        <>
          <GroupTitle>Accounts</GroupTitle>
          <Group>
            {assets.map((a, n) => (
              <Row key={a.name} first={n === 0} label={a.name} value={money(a.balance, a.currency)} />
            ))}
          </Group>
        </>
      ) : null}

      {ledger.owed.length + debts.length ? (
        <>
          <GroupTitle>Between you and others</GroupTitle>
          <Group>
            {ledger.owed.map((o, n) => (
              <Row key={`o${o.person}${o.currency}`} first={n === 0} label={o.person} note="owes you" value={money(o.amount, o.currency)} />
            ))}
            {debts.map((d, n) => (
              <Row key={`d${d.name}`} first={ledger.owed.length + n === 0} label={d.person ?? d.name} note="you owe" value={money(Math.abs(d.balance), d.currency)} />
            ))}
          </Group>
        </>
      ) : null}

      {ledger.month.categories.length ? (
        <>
          <GroupTitle>{`Where it went · ${month}`}</GroupTitle>
          <Group>
            {ledger.month.categories.slice(0, CATEGORIES).map((c, n) => (
              <Row key={`${c.name}${c.currency}`} first={n === 0} label={c.name} value={money(c.amount, c.currency)} />
            ))}
          </Group>
        </>
      ) : null}

      {ledger.zakat || hadInterest ? (
        <>
          <GroupTitle>Halal</GroupTitle>
          <Group>
            {hadInterest ? <Row first label="Interest to give away" value={toPurify || "All given away"} tone={toPurify ? "warn" : undefined} /> : null}
            {ledger.zakat ? (
              <Row
                first={!hadInterest}
                label="Zakat"
                note={ledger.zakat.nisab !== undefined ? `Nisab ${money(ledger.zakat.nisab, ledger.zakat.currency)}` : undefined}
                value={zakatLine(ledger.zakat)}
                tone={ledger.zakat.due ? "warn" : undefined}
              />
            ) : null}
          </Group>
          <GroupNote>The ledger works these out; the ruling is yours.</GroupNote>
        </>
      ) : null}

      {days.map((d) => (
        <View key={d.day} style={s.day}>
          <View style={s.dayHead}>
            <Text accessibilityRole="header" style={[s.dayName, { color: t.inkSoft }]}>
              {dayLabel(d.day, today)}
            </Text>
            {Object.keys(d.spent).length ? <Text style={[s.daySpent, { color: t.inkFaint }]}>{moneySums(d.spent)}</Text> : null}
          </View>
          <Group>
            {d.entries.map((e, n) => (
              <Entry key={e.id} entry={e} first={n === 0} t={t} />
            ))}
          </Group>
        </View>
      ))}

      {!ledgerEmpty(ledger) ? <GroupNote>Tell midna what you spend and it lands here. To change or look further back, ask it.</GroupNote> : null}
    </ScrollView>
  );
}

/** A budget: its name, what is left, and a bar of how much is used. The bar is ink, and the accent once it has run over. */
function Budget({ budget, first, t }: { budget: LedgerBudget; first: boolean; t: Theme }) {
  const { used, over } = budgetUse(budget);
  return (
    <View style={s.row} accessibilityLabel={`${budget.name}, ${budgetLine(budget)}`}>
      <View style={[s.budgetBody, !first && { borderTopColor: t.hairline, borderTopWidth: StyleSheet.hairlineWidth }]}>
        <View style={s.line}>
          <Text numberOfLines={1} style={[s.name, { color: t.ink }]}>
            {budget.name}
          </Text>
          <Text numberOfLines={1} style={[s.left, { color: over ? t.warn : t.inkSoft }]}>
            {budgetLine(budget)}
          </Text>
        </View>
        <View style={[s.track, { backgroundColor: t.fill }]}>
          <View style={[s.used, { width: `${Math.round(used * 100)}%`, backgroundColor: over ? t.accent : t.inkSoft }]} />
        </View>
      </View>
    </View>
  );
}

/** One entry: what it was, with its category and account under it, and the amount at the right. */
function Entry({ entry, first, t }: { entry: LedgerEntry; first: boolean; t: Theme }) {
  const amount = entryAmount(entry);
  const note = entryNote(entry);
  return (
    <View style={s.row} accessibilityLabel={`${entry.description}, ${amount.text}`}>
      <View style={[s.entryBody, !first && { borderTopColor: t.hairline, borderTopWidth: StyleSheet.hairlineWidth }]}>
        <View style={s.what}>
          <Text numberOfLines={1} style={[s.name, { color: t.ink }]}>
            {entry.description || entry.other}
          </Text>
          {note ? (
            <Text numberOfLines={1} style={[s.note, { color: t.inkSoft }]}>
              {note}
            </Text>
          ) : null}
        </View>
        <Text style={[s.amount, { color: amount.tone === "in" ? t.ok : amount.tone === "moved" ? t.inkSoft : t.ink }]}>{amount.text}</Text>
      </View>
    </View>
  );
}

const figures = { fontVariant: ["tabular-nums" as const] };
const s = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingTop: 8, gap: 24 },
  hero: { marginHorizontal: 6, marginTop: 6, gap: 2 },
  heroLabel: face(13, "medium"),
  heroFigure: { ...face(38, "bold", 46), letterSpacing: -0.8, ...figures },
  stats: { flexDirection: "row", gap: 28, marginTop: 12 },
  stat: { gap: 2, flexShrink: 1 },
  statLabel: face(12, "medium"),
  statFigure: { ...face(16, "medium", 21), ...figures },
  heroNote: { ...face(12, "regular", 17), marginTop: 2 },
  row: { paddingLeft: 16 },
  budgetBody: { paddingRight: 16, paddingTop: 13, paddingBottom: 14, gap: 9 },
  line: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  name: { ...face(16), flexShrink: 1 },
  left: { ...face(14), flex: 1, textAlign: "right", ...figures },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  used: { height: 4, borderRadius: 2 },
  day: { gap: 8 },
  dayHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginHorizontal: 6 },
  dayName: face(13, "medium"),
  daySpent: { ...face(13), ...figures },
  entryBody: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: 12, paddingRight: 16, paddingVertical: 11 },
  what: { flex: 1, gap: 2 },
  note: face(13, "regular", 18),
  amount: { ...face(16), ...figures },
  empty: { flex: 1, alignItems: "center", paddingHorizontal: 32, gap: 12 },
  emptyTitle: { ...face(17, "bold"), textAlign: "center" },
  emptyText: { ...face(14, "regular", 20), textAlign: "center" },
});
