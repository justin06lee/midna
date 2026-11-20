import { describe, expect, test } from "bun:test";
import type { CalendarBlock } from "@midna/protocol";
import { midnight, span, timetable, type Gap, type Row } from "../src/timetable.ts";

const DAY = new Date(2026, 10, 20).getTime();
const at = (h: number, m = 0, days = 0) => new Date(2026, 10, 20 + days, h, m).getTime();
let id = 0;
const block = (title: string, start: number, end: number | null, more: Partial<CalendarBlock> = {}): CalendarBlock => ({
  id: ++id, title, starts_at: start, ends_at: end, all_day: 0, location: null, notes: null, source: "midna", status: "confirmed", updated_at: 0, ...more,
});
const rows = (r: Array<Row | Gap>) => r.map((x) => ("gap" in x ? `gap ${span(x.end - x.start)}` : `${x.title} ${x.state}${x.next ? " next" : ""}`));

describe("today's timetable", () => {
  const plan = [
    block("Wake, Fajr", at(4, 30), at(5)),
    block("caveira call", at(5), at(6), { location: "Zoom" }),
    block("Read Justice", at(6), at(7)),
    block("Deep work", at(8), at(11, 30)),
    block("Lunch", at(11, 30), at(12, 30)),
    block("Dinner", at(18, 30), at(19, 30), { source: "google", status: "tentative" }),
  ];

  test("in order, with what's on now, what's next, and unplanned time of half an hour or more", () => {
    const t = timetable(plan, at(9, 15));
    expect(rows(t.today.rows)).toEqual(["Wake, Fajr past", "caveira call past", "Read Justice past", "gap 1 h", "Deep work now", "Lunch later next", "gap 6 h", "Dinner later"]);
    expect(t.now?.title).toBe("Deep work");
    expect(t.next?.title).toBe("Lunch");
    const dinner = t.today.rows.at(-1) as Row;
    expect([dinner.from, dinner.tentative]).toEqual(["google", true]);
  });

  test("between blocks nothing is on, and the next is the next", () => {
    const t = timetable(plan, at(7, 20));
    expect(t.now).toBeNull();
    expect(t.next?.title).toBe("Deep work");
  });

  test("a block's end is the next one's start: at the turn, the new one is on", () => {
    expect(timetable(plan, at(5)).now?.title).toBe("caveira call");
  });

  test("a block from last night that runs past midnight is on today's table; one that ended at midnight isn't", () => {
    const t = timetable([block("Sleep", at(23, 0, -1), at(4, 30)), block("Late", at(22, 0, -1), DAY)], at(2));
    expect(rows(t.today.rows)).toEqual(["Sleep now"]);
    expect(t.today.date).toBe(DAY);
  });

  test("a moment is passed or ahead, never on; an all-day event sits apart", () => {
    const t = timetable([block("Pills", at(8), null), block("Holiday", DAY, at(0, 0, 1), { all_day: 1 })], at(9));
    expect(rows(t.today.rows)).toEqual(["Pills past"]);
    expect(t.today.allDay.map((r) => r.title)).toEqual(["Holiday"]);
    expect(t.now).toBeNull();
  });
});

describe("tomorrow", () => {
  test("a plan still waiting for the OK is only counted", () => {
    const t = timetable([block("Wake", at(4, 30, 1), at(5, 0, 1), { status: "tentative" }), block("Read", at(6, 0, 1), at(7, 0, 1), { status: "tentative" })], at(22));
    expect(t.tomorrow).toBeNull();
    expect(t.waiting).toBe(2);
    expect(t.next).toBeNull();
  });

  test("once approved it shows, and after today's last block its first is next", () => {
    const t = timetable([block("Wind down", at(21), at(22)), block("Wake", at(4, 30, 1), at(5, 0, 1)), block("Read", at(6, 0, 1), at(7, 0, 1))], at(22, 30));
    expect(t.waiting).toBe(0);
    expect(rows(t.tomorrow!.rows)).toEqual(["Wake later next", "gap 1 h", "Read later"]);
    expect(t.next?.title).toBe("Wake");
    expect(t.tomorrow!.date).toBe(midnight(at(22, 30), 1));
  });
});

test("spans read as a person says them", () => {
  expect([span(25 * 60_000), span(60 * 60_000), span(150 * 60_000)]).toEqual(["25 min", "1 h", "2 h 30 min"]);
});
