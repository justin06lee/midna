import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import { AppState, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { MidnaError, type CalendarBlock } from "@midna/protocol";
import { bold, radius, type as face, useTheme, type Theme } from "../theme";
import { clock, clockParts, midnight, span, timetable, type Day, type Gap, type Row } from "../timetable";
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
export function Today({ midna, foot }: { midna: Midna; foot: number }) {
  const t = useTheme();
  const now = useMinute();
  const { blocks, problem, loading, load } = useDay(midna);
  const table = blocks ? timetable(blocks, now) : null;

  // Opened, the table shows the block on now (or the next) near the top, not the morning's.
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const tableTop = useRef(0);
  const placed = useRef(false);
  const onRowAt = useCallback((y: number) => {
    if (placed.current) return;
    placed.current = true;
    scroller.current?.scrollTo({ y: Math.max(0, tableTop.current + y - 220), animated: false });
  }, []);

  return (
    <ScrollView ref={scroller} testID="today" contentContainerStyle={[s.body, { paddingBottom: foot + 24 }]} refreshControl={<RefreshControl refreshing={loading && blocks !== null} onRefresh={() => void load()} />}>
      <Text style={[s.date, { color: t.inkSoft }]}>{weekday(now)}</Text>
      {table && (table.now || table.next) ? <NowNext table={table} now={now} t={t} /> : null}
      <Problem text={problem} />
      {table && table.today.rows.length + table.today.allDay.length > 0 ? (
        <View onLayout={(e) => (tableTop.current = e.nativeEvent.layout.y)}>
          <Table day={table.today} now={now} t={t} onFocusRow={onRowAt} />
        </View>
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
    <View style={[s.now, { backgroundColor: on ? t.tint : t.raised }]}>
      {on ? (
        <>
          <Text style={[s.label, { color: t.accent }]}>Now</Text>
          <Text style={[s.nowTitle, { color: t.ink }]}>{on.title}</Text>
          <Text style={[s.nowMeta, { color: t.inkSoft }]}>{`until ${clock(on.end!)} · ${span(on.end! - now)} left${on.place ? ` · ${on.place}` : ""}`}</Text>
        </>
      ) : (
        <Text style={[s.nowMeta, { color: t.inkSoft }]}>Nothing planned right now.</Text>
      )}
      {next ? (
        <Text style={[s.nextLine, { color: t.ink }]}>
          <Text style={{ color: t.inkSoft }}>Next </Text>
          {`${midnight(next.start) !== midnight(now) ? "tomorrow " : ""}${clock(next.start)}  ${next.title}`}
        </Text>
      ) : null}
    </View>
  );
}

/** A day's blocks in a column: the time on the left, what on the right; the block on now on the faint accent, what's past quieter. No lines between rows. */
function Table({ day, now, t, onFocusRow }: { day: Day; now: number; t: Theme; onFocusRow?: (y: number) => void }) {
  // AM or PM is said at the first time and where it changes, not at every row.
  let period = "";
  const shownPeriod = (at: number) => {
    const p = clockParts(at).period;
    const show = p !== period;
    period = p;
    return show ? p : "";
  };
  const focus = day.rows.find((r) => !("gap" in r) && (r.state === "now" || r.next));
  return (
    <View style={[s.table, { backgroundColor: t.raised }]}>
      {day.allDay.map((r) => (
        <View key={`a${r.id}`} style={s.row}>
          <Text style={[s.time, { color: t.inkSoft }]}>all day</Text>
          <View style={s.what}>
            <Text style={[s.title, { color: t.ink }]}>{r.title}</Text>
          </View>
        </View>
      ))}
      {day.rows.map((r) =>
        "gap" in r ? (
          <Free key={`g${r.start}`} gap={r} t={t} />
        ) : (
          <Block key={r.id} r={r} now={now} t={t} period={shownPeriod(r.start)} onLayoutY={r === focus ? onFocusRow : undefined} />
        ),
      )}
    </View>
  );
}

function Block({ r, now, t, period, onLayoutY }: { r: Row; now: number; t: Theme; period: string; onLayoutY?: (y: number) => void }) {
  const past = r.state === "past";
  const on = r.state === "now";
  // What a block says under its name: how long, where, whose, and whether it's approved. A check-in's result will sit at the right.
  const meta = [r.end !== null ? span(r.end - r.start) : null, r.place, r.from, r.tentative ? "not approved yet" : null].filter(Boolean).join(" · ");
  return (
    <View
      style={[s.row, on && [s.onRow, { backgroundColor: t.tint }]]}
      onLayout={onLayoutY ? (e) => onLayoutY(e.nativeEvent.layout.y) : undefined}
      accessibilityLabel={`${clock(r.start)}, ${r.title}${on ? ", now" : r.next ? ", next" : ""}`}
    >
      <View style={s.timeCol}>
        <Text style={[s.time, { color: on ? t.accent : past ? t.inkFaint : t.ink }, on && s.strong]}>
          {clockParts(r.start).time}
          {period ? <Text style={s.period}>{` ${period}`}</Text> : null}
        </Text>
        {r.end !== null && midnight(r.end) === midnight(r.start) ? <Text style={[s.until, { color: past ? t.inkFaint : t.inkSoft }]}>{clockParts(r.end).time}</Text> : null}
      </View>
      <View style={s.what}>
        <Text style={[s.title, { color: past ? t.inkSoft : t.ink }, on && s.strong]} numberOfLines={2}>
          {r.title}
        </Text>
        {meta ? <Text style={[s.meta, { color: past ? t.inkFaint : t.inkSoft }]}>{meta}</Text> : null}
      </View>
      {on ? <Text style={[s.tag, { color: t.accent }]}>{r.end ? `${span(r.end - now)} left` : "Now"}</Text> : r.next ? <Text style={[s.tag, { color: t.inkSoft }]}>Next</Text> : null}
    </View>
  );
}

/** Time nothing is planned for, said quietly in the column. */
function Free({ gap, t }: { gap: Gap; t: Theme }) {
  return (
    <View style={[s.row, s.freeRow]}>
      <Text style={[s.time, s.freeText, { color: t.inkFaint }]}>{clockParts(gap.start).time}</Text>
      <Text style={[s.freeText, { color: t.inkFaint }]}>{`Free · ${span(gap.end - gap.start)}`}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingTop: 8, gap: 24 },
  date: { ...face(13, "medium"), marginHorizontal: 6, marginBottom: -16 },
  section: { gap: 24 },
  now: { borderRadius: radius.card, borderCurve: "continuous", paddingHorizontal: 16, paddingVertical: 15, gap: 3 },
  label: face(12, "medium"),
  nowTitle: face(21, "bold", 27),
  nowMeta: face(14),
  nextLine: { ...face(14), marginTop: 10 },
  table: { borderRadius: radius.card, borderCurve: "continuous", paddingVertical: 6, paddingHorizontal: 6 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 10, paddingVertical: 10 },
  onRow: { borderRadius: 12, borderCurve: "continuous" },
  timeCol: { width: 64 },
  time: { ...face(14), fontVariant: ["tabular-nums"], width: 64 },
  period: face(11, "medium"),
  until: { ...face(12), fontVariant: ["tabular-nums"], marginTop: 1 },
  what: { flex: 1, gap: 2 },
  title: face(16, "regular", 21),
  strong: bold,
  meta: face(13),
  tag: { ...face(12, "medium"), marginTop: 2 },
  freeRow: { paddingVertical: 5 },
  freeText: face(13),
});
