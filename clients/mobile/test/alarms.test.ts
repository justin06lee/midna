import { expect, test } from "bun:test";
import { MidnaError, type Alarm, type AlarmReport } from "@midna/protocol";
import { alarmSync, heldOf, upcoming } from "../src/alarmsSync";

const alarm = (label: string, more: Partial<Alarm> = {}): Alarm => ({ id: `0b0f6f0e-6d0a-4c50-9a51-${label.padStart(12, "0")}`, label, at: null, time: "04:30", days: [1, 2, 3, 4, 5, 6, 7], updatedAt: 1, ...more });

/** A phone whose iOS takes whatever it is given, and a midna holding `list`. */
function phone(list: Alarm[], opts: { authorization?: AlarmReport["authorization"] } = {}) {
  const state = { asOf: 0, clock: 100, applied: [] as Alarm[][], reports: [] as AlarmReport[], fetches: 0, offline: false, asked: [] as boolean[] };
  const sync = alarmSync({
    apply: async (alarms, ask) => {
      await Bun.sleep(1);
      state.applied.push(alarms);
      state.asked.push(ask);
      const authorization = opts.authorization ?? "authorized";
      return { authorization, scheduled: authorization === "authorized" ? alarms.map((a) => ({ id: a.id, updatedAt: a.updatedAt })) : [] };
    },
    lastAsOf: () => state.asOf,
    setAsOf: (n) => (state.asOf = n),
  });
  const host = {
    alarms: async () => {
      state.fetches++;
      if (state.offline) throw new Error("offline");
      return { alarms: list, asOf: state.clock++, phones: [] };
    },
    reportAlarms: async (r: AlarmReport) => {
      if (state.offline) throw new Error("offline");
      state.reports.push(r);
    },
  };
  return { sync, host, state };
}

test("opening the app fetches midna's list, hands it to iOS and says what iOS holds", async () => {
  const wake = alarm("wake");
  const p = phone([wake]);
  const on = await p.sync.sync(p.host, { ask: true });
  expect(on).toMatchObject({ alarms: [wake], reported: true });
  expect(p.state.asked).toEqual([true]);
  expect(p.state.reports).toEqual([{ authorization: "authorized", scheduled: [{ id: wake.id, updatedAt: 1 }] }]);
  expect(heldOf(on!)).toEqual([wake]);
});

test("a push brings the list itself: nothing is fetched, and it works with no token to hand", async () => {
  const p = phone([]);
  const fajr = alarm("fajr", { at: Date.now() + 3_600_000, time: null, days: [] });
  const on = await p.sync.sync(null, { pushed: { alarms: [fajr], asOf: 50 } });
  expect(p.state.fetches).toBe(0);
  expect(p.state.applied).toEqual([[fajr]]);
  // iOS has it, though midna couldn't be told.
  expect(on).toMatchObject({ reported: false });
  expect(p.state.asOf).toBe(50);
});

test("a push that comes late never puts an older list over a newer one: midna is asked instead", async () => {
  const now = [alarm("wake", { updatedAt: 2 })];
  const p = phone(now);
  await p.sync.sync(p.host); // the app opened: asOf 100
  await p.sync.sync(p.host, { pushed: { alarms: [], asOf: 40 } });
  expect(p.state.applied).toEqual([now, now]);
  expect(p.state.fetches).toBe(2);
  // With no way to ask, the old list is left alone.
  expect(await p.sync.sync(null, { pushed: { alarms: [], asOf: 41 } })).toBeNull();
  expect(p.state.applied.length).toBe(2);
});

test("a push too long to carry the list has it fetched", async () => {
  const p = phone([alarm("a"), alarm("b")]);
  await p.sync.sync(p.host, { pushed: {} });
  expect(p.state.fetches).toBe(1);
  expect(p.state.applied[0]!.length).toBe(2);
});

test("syncs run one at a time, in the order they were asked for", async () => {
  const p = phone([alarm("a")]);
  const first = p.sync.sync(p.host);
  const second = p.sync.sync(p.host, { pushed: { alarms: [alarm("b")], asOf: 1_000 } });
  await Promise.all([first, second]);
  expect(p.state.applied.map((l) => l.map((a) => a.label))).toEqual([["a"], ["b"]]);
});

test("offline, an open fails and the next one still runs; a midna before alarms is no error", async () => {
  const p = phone([alarm("a")]);
  p.state.offline = true;
  await expect(p.sync.sync(p.host)).rejects.toThrow("offline");
  p.state.offline = false;
  expect(await p.sync.sync(p.host)).toMatchObject({ reported: true });
  const old = { alarms: async () => Promise.reject(new MidnaError(404, "not found")), reportAlarms: async () => {} };
  expect(await p.sync.sync(old)).toBeNull();
});

test("when alarms aren't allowed, midna is told so and nothing counts as held", async () => {
  const p = phone([alarm("a")], { authorization: "denied" });
  const on = await p.sync.sync(p.host);
  expect(p.state.reports).toEqual([{ authorization: "denied", scheduled: [] }]);
  expect(heldOf(on!)).toEqual([]);
});

test("what's still to ring: recurring alarms and one-offs ahead; an alarm iOS holds as an older version isn't held", () => {
  const now = 1_000_000;
  const past = alarm("past", { at: now - 1, time: null, days: [] });
  const ahead = alarm("ahead", { at: now + 1, time: null, days: [] });
  const daily = alarm("daily", { updatedAt: 5 });
  expect(upcoming([past, ahead, daily], now)).toEqual([ahead, daily]);
  expect(heldOf({ alarms: [ahead, daily], held: { authorization: "authorized", scheduled: [{ id: daily.id.toUpperCase(), updatedAt: 4 }, { id: ahead.id.toUpperCase(), updatedAt: 1 }] }, reported: true })).toEqual([ahead]);
});
