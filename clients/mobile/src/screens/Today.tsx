import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { MidnaError, type CalendarBlock } from "@midna/protocol";
import { useTheme, type Theme } from "../theme";
import { clock, midnight, span, timetable, type Day, type Gap, type Row } from "../timetable";
import { GroupNote, GroupTitle, Problem } from "../ui";
import type { Midna } from "../useMidna";

/** How often the day is asked for again while the screen is up; a turn of midna's ending asks at once. */
const REFETCH_MS = 5 * 60_000;

/**
 * Today's and tomorrow's blocks from midna's calendar, from today's midnight. A host before 0.13.7 has no
 * calendar route: its overview stands in, which starts two hours back, so the morning drops off by noon.
 */
function useDay(midna: Midna) {
  const { client, link, thinking } = midna;
  const [blocks, setBlocks] = useState<CalendarBlock[] | null>(null);
  const [problem, setProblem] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const from = midnight(Date.now());
    try {
      setBlocks(await client.calendar(from, midnight(from, 2)));
      setProblem("");
    } catch (err) {
      if (err instanceof MidnaError && err.status === 404) {
        const o = await client.overview().catch(() => null);
        if (o) {
          setBlocks(o.events.map((e) => ({ ...e, notes: null, status: e.status === "tentative" ? "tentative" : "confirmed", updated_at: 0 })));
          setProblem("");
        }
      } else setProblem(`Couldn't load the day: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [client]);

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

  // midna may have changed the plan in the turn that just ended.
  const wasThinking = useRef(false);
  useEffect(() => {
    if (wasThinking.current && !thinking) void load();
    wasThinking.current = thinking !== null;
  }, [thinking, load]);

  return { blocks, problem, loading, load };
}

/** The minute, kept current: what is on changes on the minute, not on a refetch. */
function useMinute(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const fg = AppState.addEventListener("change", (s) => s === "active" && setNow(Date.now()));
    return () => {
      clearInterval(tick);
      fg.remove();
    };
  }, []);
  return now;
}

const weekday = (at: number) => new Date(at).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

/** The day as a timetable: what's on now and next above, then every block in order; tomorrow under it once approved. */
export function Today({ midna }: { midna: Midna }) {
  const t = useTheme();
  const now = useMinute();
  const { blocks, problem, loading, load } = useDay(midna);
  const table = blocks ? timetable(blocks, now) : null;

  return (
    <ScrollView testID="today" contentContainerStyle={s.body} refreshControl={<RefreshControl refreshing={loading && blocks !== null} onRefresh={() => void load()} />}>
      <Text style={[s.date, { color: t.dim }]}>{weekday(now)}</Text>
      {table && (table.now || table.next) ? <NowNext table={table} now={now} t={t} /> : null}
      <Problem text={problem} />
      {table && table.today.rows.length + table.today.allDay.length > 0 ? (
        <Table day={table.today} now={now} t={t} />
      ) : table ? (
        <GroupNote>Nothing planned today. midna plans each day the night before; it shows here once you approve it.</GroupNote>
      ) : null}
      {table?.tomorrow ? (
        <View style={s.section}>
          <GroupTitle>{`Tomorrow · ${new Date(table.tomorrow.date).toLocaleDateString(undefined, { weekday: "long" })}`}</GroupTitle>
          <Table day={table.tomorrow} now={now} t={t} />
        </View>
      ) : table && table.waiting > 0 ? (
        <GroupNote>{`Tomorrow's plan, ${table.waiting} block${table.waiting === 1 ? "" : "s"}, waits for your OK in the chat.`}</GroupNote>
      ) : null}
    </ScrollView>
  );
}

/** The block on now, how long it has left, and what comes after: on the accent's faint tone, the one zone that stands out. */
function NowNext({ table, now, t }: { table: NonNullable<ReturnType<typeof timetable>>; now: number; t: Theme }) {
  const on = table.now;
  const next = table.next;
  return (
    <View style={[s.now, { backgroundColor: on ? t.tint : t.panel }]}>
      {on ? (
        <>
          <Text style={[s.label, { color: t.primary }]}>NOW</Text>
          <Text style={[s.nowTitle, { color: t.ink }]}>{on.title}</Text>
          <Text style={[s.nowMeta, { color: t.dim }]}>{`until ${clock(on.end!)} · ${span(on.end! - now)} left${on.place ? ` · ${on.place}` : ""}`}</Text>
        </>
      ) : (
        <Text style={[s.nowMeta, { color: t.dim }]}>Nothing planned right now.</Text>
      )}
      {next ? (
        <Text style={[s.nextLine, { color: t.ink2 }]}>
          <Text style={{ color: t.dim }}>Next </Text>
          {`${midnight(next.start) !== midnight(now) ? "tomorrow " : ""}${clock(next.start)}  ${next.title}`}
        </Text>
      ) : null}
    </View>
  );
}

/** A day's blocks in a column: the time on the left, what on the right; the block on now on the faint accent, what's past quieter. No lines between rows. */
function Table({ day, now, t }: { day: Day; now: number; t: Theme }) {
  return (
    <View style={[s.table, { backgroundColor: t.panel }]}>
      {day.allDay.map((r) => (
        <View key={`a${r.id}`} style={s.row}>
          <Text style={[s.time, { color: t.dim }]}>all day</Text>
          <View style={s.what}>
            <Text style={[s.title, { color: t.ink }]}>{r.title}</Text>
          </View>
        </View>
      ))}
      {day.rows.map((r) => ("gap" in r ? <Free key={`g${r.start}`} gap={r} t={t} /> : <Block key={r.id} r={r} now={now} t={t} />))}
    </View>
  );
}

function Block({ r, now, t }: { r: Row; now: number; t: Theme }) {
  const past = r.state === "past";
  const on = r.state === "now";
  // What a block says under its name: how long, where, whose, and whether it's approved. A check-in's result will sit at the right.
  const meta = [r.end !== null ? span(r.end - r.start) : null, r.place, r.from, r.tentative ? "not approved yet" : null].filter(Boolean).join(" · ");
  return (
    <View style={[s.row, on && [s.onRow, { backgroundColor: t.tint }]]} accessibilityLabel={`${clock(r.start)}, ${r.title}${on ? ", now" : r.next ? ", next" : ""}`}>
      <View style={s.timeCol}>
        <Text style={[s.time, { color: on ? t.primary : past ? t.dimmer : t.ink2 }, on && s.strong]}>{clock(r.start)}</Text>
        {r.end !== null && midnight(r.end) === midnight(r.start) ? <Text style={[s.until, { color: past ? t.dimmer : t.dim }]}>{clock(r.end)}</Text> : null}
      </View>
      <View style={s.what}>
        <Text style={[s.title, { color: past ? t.dim : t.ink }, on && s.strong]} numberOfLines={2}>
          {r.title}
        </Text>
        {meta ? <Text style={[s.meta, { color: past ? t.dimmer : t.dim }]}>{meta}</Text> : null}
      </View>
      {on ? <Text style={[s.tag, { color: t.primary }]}>{r.end ? `${span(r.end - now)} left` : "Now"}</Text> : r.next ? <Text style={[s.tag, { color: t.dim }]}>Next</Text> : null}
    </View>
  );
}

/** Time nothing is planned for, said quietly in the column. */
function Free({ gap, t }: { gap: Gap; t: Theme }) {
  return (
    <View style={[s.row, s.freeRow]}>
      <Text style={[s.time, s.freeText, { color: t.dimmer }]}>{clock(gap.start)}</Text>
      <Text style={[s.freeText, { color: t.dimmer }]}>{`Free · ${span(gap.end - gap.start)}`}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  body: { padding: 16, paddingBottom: 40, gap: 22 },
  date: { fontSize: 15, marginHorizontal: 4, marginBottom: -10 },
  section: { gap: 14 },
  now: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, gap: 3 },
  label: { fontSize: 12, fontWeight: "600", letterSpacing: 0.4 },
  nowTitle: { fontSize: 22, fontWeight: "600", lineHeight: 28 },
  nowMeta: { fontSize: 15 },
  nextLine: { fontSize: 15, marginTop: 10 },
  table: { borderRadius: 12, paddingVertical: 6, paddingHorizontal: 6 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 10, paddingVertical: 9 },
  onRow: { borderRadius: 10 },
  timeCol: { width: 64 },
  time: { fontSize: 15, fontVariant: ["tabular-nums"], width: 64 },
  until: { fontSize: 13, fontVariant: ["tabular-nums"], marginTop: 1 },
  what: { flex: 1, gap: 2 },
  title: { fontSize: 17, lineHeight: 22 },
  strong: { fontWeight: "600" },
  meta: { fontSize: 13 },
  tag: { fontSize: 13, fontWeight: "500", marginTop: 2 },
  freeRow: { paddingVertical: 5 },
  freeText: { fontSize: 13 },
});
