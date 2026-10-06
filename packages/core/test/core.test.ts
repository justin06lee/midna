import { describe, expect, test } from "bun:test";
import { ARCHIVE_BELOW, DAY, Store, afterQuietHours, fmt, parseWhen, renderContext, strength } from "../src/index.ts";

const TZ = "America/Los_Angeles";
const fresh = () => {
  const s = Store.open(":memory:");
  s.updateSettings({ timezone: TZ });
  return s;
};

describe("time", () => {
  test("local wall-clock round-trips through the timezone", () => {
    expect(fmt(parseWhen("2026-10-02 09:30", TZ), TZ)).toBe("2026-10-02 Fri 09:30");
    expect(fmt(parseWhen("2026-10-02T16:30:00Z", TZ), TZ)).toBe("2026-10-02 Fri 09:30");
    expect(fmt(parseWhen("2026-12-02 09:30", TZ), TZ)).toBe("2026-12-02 Wed 09:30"); // across DST
  });

  test("relative times", () => {
    const now = Date.UTC(2026, 9, 1, 12);
    expect(parseWhen("+90m", TZ, now) - now).toBe(90 * 60_000);
    expect(parseWhen("+2d", TZ, now) - now).toBe(2 * DAY);
  });

  test("garbage is refused with a hint", () => {
    expect(() => parseWhen("next tuesday-ish", TZ)).toThrow(/ISO 8601/);
  });

  test("quiet hours hold until they end, across midnight", () => {
    const quiet = { start: "23:00", end: "08:00" };
    expect(fmt(afterQuietHours(parseWhen("2026-10-01 23:30", TZ), TZ, quiet), TZ)).toBe("2026-10-02 Fri 08:00");
    expect(fmt(afterQuietHours(parseWhen("2026-10-02 03:15", TZ), TZ, quiet), TZ)).toBe("2026-10-02 Fri 08:00");
    const day = parseWhen("2026-10-02 12:00", TZ);
    expect(afterQuietHours(day, TZ, quiet)).toBe(day);
    expect(afterQuietHours(day, TZ, null)).toBe(day);
  });
});

describe("memory", () => {
  test("strength decays with disuse, faster for less important facts", () => {
    const now = Date.now();
    const f = (importance: number, idleDays: number) => strength({ importance, pinned: 0, use_count: 0, last_used_at: now - idleDays * DAY }, now, false);
    expect(f(3, 30)).toBeLessThan(ARCHIVE_BELOW);
    expect(f(8, 30)).toBeGreaterThan(0.5);
    expect(f(5, 0)).toBeCloseTo(0.5);
    expect(strength({ importance: 1, pinned: 1, use_count: 0, last_used_at: 0 }, now, false)).toBe(Infinity);
  });

  test("faded facts are archived, linked and pinned ones survive", () => {
    const s = fresh();
    const now = Date.now();
    const old = now - 400 * DAY;
    const goal = s.planning.saveGoal({ title: "Run a marathon", horizon: "year" });
    const trivia = s.memory.remember({ content: "Had pasta on a Tuesday", kind: "context", importance: 2 }, old);
    const pinned = s.memory.remember({ content: "Name is Justin", kind: "identity", importance: 3, pinned: true }, old);
    const linked = s.memory.remember({ content: "Knee hurts after 15k", kind: "pattern", importance: 4, links: [{ entity: "goal", id: goal.id }] }, now - 20 * DAY);
    expect(s.memory.fade(now)).toBe(1);
    expect(s.memory.get(trivia.id)!.archive_reason).toBe("faded");
    expect(s.memory.get(pinned.id)!.archived_at).toBeNull();
    expect(s.memory.get(linked.id)!.archived_at).toBeNull();
    // Once the goal is done the link stops protecting the fact.
    s.planning.saveGoal({ status: "done" }, goal.id);
    expect(s.memory.fade(now + 60 * DAY)).toBe(1);
  });

  test("revise supersedes and keeps history; recall finds only the live version", () => {
    const s = fresh();
    const a = s.memory.remember({ content: "Lives in Seoul", kind: "identity", importance: 8 });
    const b = s.memory.revise(a.id, "Lives in San Francisco since 2026");
    expect(s.memory.get(a.id)!.superseded_by).toBe(b.id);
    const hits = s.memory.recall("where does the user live lives");
    expect(hits.map((h) => h.id)).toEqual([b.id]);
    expect(() => s.memory.revise(a.id, "again")).toThrow(/superseded/);
  });

  test("recall reinforces what it returns", () => {
    const s = fresh();
    const f = s.memory.remember({ content: "Prefers deep work before noon", kind: "preference", importance: 6 }, Date.now() - 10 * DAY);
    s.memory.recall("deep work");
    const after = s.memory.get(f.id)!;
    expect(after.use_count).toBe(1);
    expect(after.last_used_at).toBeGreaterThan(f.last_used_at);
  });
});

describe("planning", () => {
  test("goal changes are renegotiations with reasons", () => {
    const s = fresh();
    const g = s.planning.saveGoal({ title: "Ship v1", horizon: "quarter" });
    s.planning.renegotiateGoal(g.id, { status: "paused" }, "moving to a new city first");
    const [change] = s.planning.goalChanges(g.id);
    expect(change!.change).toContain('status: "active" → "paused"');
    expect(change!.reason).toBe("moving to a new city first");
  });

  test("tasks close with a timestamp and reopen without one", () => {
    const s = fresh();
    const t = s.planning.saveTask({ title: "Call the landlord" });
    expect(s.planning.saveTask({ status: "done" }, t.id).done_at).not.toBeNull();
    expect(s.planning.saveTask({ status: "todo" }, t.id).done_at).toBeNull();
    expect(() => s.planning.saveTask({ title: "x" }, 999)).toThrow(/no task/);
  });

  test("the working context marks orphan tasks and stays bounded", () => {
    const s = fresh();
    for (let i = 0; i < 300; i++) s.planning.saveTask({ title: `Task number ${i} with a reasonably long title to fill space` });
    const ctx = renderContext(s);
    expect(ctx).toContain("NO GOAL");
    expect(ctx).toContain("more (use the tools");
    expect(ctx.length).toBeLessThan(20_000);
    expect(ctx).toContain("none recorded yet");
  });
});

describe("schedule and outbox", () => {
  test("due wakeups are claimed once; recurring ones come back", () => {
    const s = fresh();
    const now = parseWhen("2026-10-01 08:00", TZ);
    const once = s.schedule.add({ dueAt: now - 1000, reason: "check on Bob", tz: TZ }, now - 5000);
    const daily = s.schedule.add({ cron: "0 8 * * *", reason: "morning brief", kind: "ritual", tz: TZ }, now - DAY);
    const claimed = s.schedule.claimDue(now + 1000);
    expect(claimed.map((w) => w.id).sort()).toEqual([once.id, daily.id].sort());
    expect(s.schedule.claimDue(now + 1000)).toEqual([]);
    s.schedule.finish(once.id, true, TZ, now + 2000);
    s.schedule.finish(daily.id, true, TZ, now + 2000);
    expect(s.schedule.get(once.id)!.status).toBe("done");
    const next = s.schedule.get(daily.id)!;
    expect(next.status).toBe("pending");
    expect(fmt(next.due_at, TZ)).toBe("2026-10-02 Fri 08:00");
  });

  test("held items are released in delivery order", () => {
    const s = fresh();
    s.updateSettings({ quietHours: { start: "23:00", end: "08:00" } });
    const night = parseWhen("2026-10-01 23:30", TZ);
    const held = s.tell({ kind: "notification", text: "fyi thing", priority: "fyi" }, night);
    const urgent = s.tell({ kind: "notification", text: "flight cancelled", priority: "urgent" }, night + 1000);
    const reply = s.tell({ kind: "message", text: "sure, done" }, night + 2000);
    expect(held.seq).toBe(0);
    expect([urgent.seq, reply.seq]).toEqual([1, 2]);
    expect(s.outbox.release(parseWhen("2026-10-02 08:00", TZ))).toBe(1);
    expect(s.outbox.since(2).map((i) => i.text)).toEqual(["fyi thing"]);
  });

  test("pairing codes are single-use and case-insensitive", () => {
    const s = fresh();
    const { code } = s.devices.pairingCode();
    const paired = s.devices.pair(code.toLowerCase(), "laptop", "desktop");
    expect(paired).not.toBeNull();
    expect(s.devices.authenticate(paired!.token)!.name).toBe("laptop");
    expect(s.devices.pair(code, "again", "desktop")).toBeNull();
    s.devices.revoke(paired!.device.id);
    expect(s.devices.authenticate(paired!.token)).toBeNull();
  });
});
