import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fmt, fromLocal, nextLocalTime, nextRing } from "@midna/core";
import { MidnaClient, type Alarm, type AlarmReport, type PairRequest } from "@midna/protocol";
import type { Brain, BrainRun } from "@midna/agent";
import { startDaemon, type RunningDaemon } from "../src/index.ts";
import { alarmsPayload, type ApnsResponse } from "../src/push.ts";

/**
 * Alarms on the phone: midna sets them with its tools, the list goes to the
 * phone in a silent push, the phone says what iOS holds (with the token it
 * can read while locked), and midna knows from that whether an alarm will
 * ring. Apple and the phone are stand-ins here.
 */

const TZ = "Asia/Seoul";
const KEY_ID = "TESTKEY123";
const MIN = 60_000;
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

interface Sent {
  headers: Record<string, string>;
  body: Record<string, any>;
}
const sent: Sent[] = [];
/** What Apple answers, and what the phone does with the push. */
let answer: (s: Sent) => ApnsResponse = () => ({ status: 200 });

let home: string;
let daemon: RunningDaemon;
let host: MidnaClient;
let phone: MidnaClient;
/** The phone's location-only token: what it has while locked. */
let locked: MidnaClient;
let tools: Client;
const runs: BrainRun[] = [];
const brain: Brain = async (run) => {
  runs.push(run);
  return { text: "ok", sessionId: `s-${runs.length}`, sessionCostUsd: 0 };
};

async function until<T>(what: string, fn: () => T | undefined, ms = 5_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) {
    const v = fn();
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; error: boolean; json: any }> {
  const r = (await tools.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = r.content[0]!.text;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { text, error: !!r.isError, json };
}

const pair = async (name: string, kind: PairRequest["kind"]) => {
  const p = await new MidnaClient(daemon.url).pair({ code: (await host.pairingCode()).code, deviceName: name, kind });
  return new MidnaClient(daemon.url, p.token);
};

/** The phone as it answers a push: iOS holds everything it was given. */
const holds = (alarms: Alarm[], more: Partial<AlarmReport> = {}): AlarmReport => ({ authorization: "authorized", scheduled: alarms.map((a) => ({ id: a.id, updatedAt: a.updatedAt })), ...more });
const phoneTakesThem = (s: Sent): ApnsResponse => {
  if (s.body.midna === "alarms") setTimeout(() => void locked.reportAlarms(holds(s.body.alarms)).catch(() => {}), 100);
  return { status: 200 };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "midna-alarms-"));
  writeFileSync(join(home, `AuthKey_${KEY_ID}.p8`), privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(join(home, "config.json"), JSON.stringify({ push: { apns: { keyId: KEY_ID, teamId: "TEAMID4567" } } }));
  daemon = await startDaemon({
    home,
    port: 17000 + Math.floor(Math.random() * 20000),
    brain,
    tickMs: 3_000,
    introDelayMs: 10,
    apnsTransport: async (_env, _token, headers, body) => {
      const s = { headers, body: JSON.parse(body) };
      sent.push(s);
      return answer(s);
    },
  });
  daemon.store.updateSettings({ quietHours: null, timezone: TZ });
  host = new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim());
  phone = await pair("Justin's iPhone", "mobile");
  await phone.registerPush({ token: "ab".repeat(32), environment: "production" });
  locked = new MidnaClient(daemon.url, (await phone.locationToken()).token);
  const intro = await until("a brain run", () => runs[0]);
  tools = new Client({ name: "fake-brain", version: "0" });
  await tools.connect(new StreamableHTTPClientTransport(new URL(intro.mcp.url), { requestInit: { headers: { authorization: `Bearer ${intro.mcp.token}` } } }));
}, 15_000);

afterAll(async () => {
  await tools.close().catch(() => {});
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  sent.length = 0;
  answer = () => ({ status: 200 });
});

describe("midna sets alarms", () => {
  test("when the phone can't be reached, the alarm is kept and midna is told it isn't on the phone", async () => {
    answer = () => ({ status: 500, reason: "InternalServerError" });
    const started = Date.now();
    const set = await tool("alarm_set", { label: "Wake up: caveira call at 5", at: "+2d" });
    expect(set.error).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(set.json).toMatchObject({ label: "Wake up: caveira call at 5", on_phone: false });
    expect(set.json.why).toContain("no phone has reported");
    expect(set.json.note).toContain("couldn't be reached (500 InternalServerError)");
    expect(set.json.rings).toBe(fmt((await phone.alarms()).alarms[0]!.at, TZ));
  });

  test("the list rides to the phone in a silent push, and the alarm counts once the phone says iOS holds it", async () => {
    answer = phoneTakesThem;
    const set = (await tool("alarm_set", { label: "Fajr", at: "+1d" })).json;
    expect(set).toMatchObject({ label: "Fajr", on_phone: true });
    expect(set.note).toBeUndefined();
    const s = sent.find((x) => x.body.midna === "alarms")!;
    expect(s.headers).toMatchObject({ "apns-push-type": "background", "apns-priority": "5", "apns-topic": "sh.midna.mobile", "apns-collapse-id": "midna-alarms" });
    expect(s.body.aps).toEqual({ "content-available": 1 });
    expect(s.body.alarms.map((a: Alarm) => a.label)).toEqual(["Wake up: caveira call at 5", "Fajr"]);
    expect(s.body.alarms[1]).toMatchObject({ id: set.id, time: null, days: [] });
    // The first one went along, so it is on the phone now too.
    const list = (await tool("alarm_list")).json;
    expect(list.alarms.map((a: { on_phone: boolean }) => a.on_phone)).toEqual([true, true]);
    expect(list.phones).toMatchObject([{ name: "Justin's iPhone", alarms_allowed: true }]);
  });

  test("a repeating alarm rings every day unless days are given, on the phone's clock", async () => {
    answer = phoneTakesThem;
    const daily = (await tool("alarm_set", { label: "Wake", time: "4:30" })).json;
    expect(daily).toMatchObject({ time: "04:30", repeats: "every day", on_phone: true });
    const kept = (await phone.alarms()).alarms.find((a) => a.id === daily.id)!;
    expect(kept).toMatchObject({ at: null, time: "04:30", days: [1, 2, 3, 4, 5, 6, 7] });
    expect(daily.rings).toBe(fmt(nextRing(kept, TZ), TZ));
    expect(daily.rings).toEndWith("04:30");

    const some = (await tool("alarm_set", { label: "Gym", time: "06:15", days: ["fri", "mon"] })).json;
    expect(some).toMatchObject({ time: "06:15", repeats: "mon, fri" });
    expect((await tool("alarm_set", { label: "x", time: "25:00" })).error).toBe(true);
    expect((await tool("alarm_set", { label: "x", time: "06:00", at: "+1h" })).error).toBe(true);
    expect((await tool("alarm_set", { label: "x", at: "2020-01-01 06:00" })).text).toContain("that time has passed");
    expect((await tool("alarm_set", { label: "x", days: ["mon"], at: "+1h" })).error).toBe(true);
  });

  test("an alarm for the same time is the same alarm; a change makes a version the phone must take again", async () => {
    answer = phoneTakesThem;
    const before = (await tool("alarm_list")).json.alarms.find((a: { label: string }) => a.label === "Wake");
    const again = (await tool("alarm_set", { label: "Wake up", time: "04:30" })).json;
    expect(again).toMatchObject({ id: before.id, label: "Wake up", on_phone: true });
    expect((await phone.alarms()).alarms.filter((a) => a.time === "04:30").length).toBe(1);

    // The phone is off for the change: what it holds is the old version.
    answer = () => ({ status: 200 });
    daemon.store.alarms.set({ id: before.id, label: "Wake up", time: "04:45" });
    const stale = (await tool("alarm_list")).json.alarms.find((a: { id: string }) => a.id === before.id);
    expect(stale).toMatchObject({ time: "04:45", on_phone: false });
    expect(stale.why).toContain("hasn't taken it yet");
    expect((await tool("alarm_set", { id: "nope", label: "x", time: "05:00" })).text).toContain("no alarm nope");
  });

  test("midna says what stands in the way: alarms not allowed, an old iPhone, an alarm iOS refused", async () => {
    const all = (await phone.alarms()).alarms;
    const wake = all.find((a) => a.label === "Wake up")!;
    await phone.reportAlarms({ authorization: "notDetermined", scheduled: [] });
    expect((await tool("alarm_list")).json.alarms[0].why).toContain("tap Allow");
    expect((await tool("alarm_list")).json.phones[0].alarms_allowed).toBe("notDetermined");
    await phone.reportAlarms({ authorization: "unsupported", scheduled: [] });
    expect((await tool("alarm_list")).json.alarms[0].why).toContain("iOS 26");
    await phone.reportAlarms(holds(all.filter((a) => a !== wake), { problems: [{ id: wake.id, error: "maximumLimitReached" }] }));
    const list = (await tool("alarm_list")).json.alarms;
    expect(list.find((a: { id: string }) => a.id === wake.id)).toMatchObject({ on_phone: false, why: "iOS refused it: maximumLimitReached" });
    expect(list.filter((a: { on_phone: boolean }) => a.on_phone).length).toBe(all.length - 1);
  });

  test("a cancelled alarm leaves the list the phone is sent", async () => {
    answer = phoneTakesThem;
    const gym = (await tool("alarm_list")).json.alarms.find((a: { label: string }) => a.label === "Gym");
    expect((await tool("alarm_cancel", { id: gym.id })).json).toEqual({ cancelled: "Gym" });
    expect(sent.at(-1)!.body.alarms.some((a: Alarm) => a.id === gym.id)).toBe(false);
    expect((await tool("alarm_cancel", { id: gym.id })).error).toBe(true);
  });
});

describe("the phone and the apps", () => {
  test("a one-off that rang stays in the phone's list for an hour (a sync mustn't stop it ringing), and off midna's", async () => {
    const rang = daemon.store.alarms.set({ label: "Rang", at: Date.now() - 10 * MIN }, Date.now() - 30 * MIN);
    const old = daemon.store.alarms.set({ label: "Long ago", at: Date.now() - 3 * 60 * MIN }, Date.now() - 4 * 60 * MIN);
    const ids = (await locked.alarms()).alarms.map((a) => a.id);
    expect(ids).toContain(rang.id);
    expect(ids).not.toContain(old.id);
    expect((await tool("alarm_list")).json.alarms.some((a: { label: string }) => a.label === "Rang")).toBe(false);
  });

  test("the location-only token reads and reports alarms and can't set one; a bridge sees none; the user's apps set and cancel", async () => {
    await expect(locked.reportAlarms({ authorization: "authorized", scheduled: [] })).resolves.toEqual({ ok: true });
    await expect(locked.setAlarm({ label: "x", time: "07:00" })).rejects.toMatchObject({ status: 403 });
    await expect(locked.status()).rejects.toMatchObject({ status: 403 });
    const telegram = await pair("Telegram", "bridge");
    await expect(telegram.alarms()).rejects.toMatchObject({ status: 403 });
    await expect(telegram.setAlarm({ label: "x", time: "07:00" })).rejects.toMatchObject({ status: 403 });
    const mac = await pair("Mac", "desktop");
    await expect(mac.reportAlarms({ authorization: "authorized", scheduled: [] })).rejects.toMatchObject({ status: 403 });

    const nap = await mac.setAlarm({ label: "Nap over", at: Date.now() + 25 * MIN });
    expect(nap).toMatchObject({ label: "Nap over", time: null, days: [] });
    expect(sent.at(-1)!.body.alarms.some((a: Alarm) => a.id === nap.id)).toBe(true);
    await expect(mac.setAlarm({ label: "x", at: Date.now() - MIN })).rejects.toMatchObject({ status: 400 });
    await expect(mac.setAlarm({ label: "x", time: "7:00" })).rejects.toMatchObject({ status: 400 });
    await expect(mac.setAlarm({ label: "x", at: Date.now() + MIN, time: "07:00" })).rejects.toMatchObject({ status: 400 });
    expect(await mac.cancelAlarm(nap.id)).toEqual({ ok: true });
    await expect(mac.cancelAlarm(nap.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("times", () => {
  test("the next ring is read on the user's clock", () => {
    // Wednesday 18 November 2026, 15:00 in Seoul.
    const now = fromLocal(2026, 11, 18, 15, 0, TZ);
    expect(fmt(nextLocalTime(4 * 60 + 30, [1, 2, 3, 4, 5, 6, 7], TZ, now), TZ)).toBe("2026-11-19 Thu 04:30");
    expect(fmt(nextLocalTime(4 * 60 + 30, [1], TZ, now), TZ)).toBe("2026-11-23 Mon 04:30");
    expect(fmt(nextLocalTime(15 * 60 + 1, [3], TZ, now), TZ)).toBe("2026-11-18 Wed 15:01");
    // Not this minute: the next one is a week on.
    expect(fmt(nextLocalTime(15 * 60, [3], TZ, now), TZ)).toBe("2026-11-25 Wed 15:00");
    expect(nextLocalTime(60, [], TZ, now)).toBeNull();
  });

  test("a list too long for one push is left for the phone to fetch", () => {
    const one: Alarm = { id: "0b0f6f0e-6d0a-4c50-9a51-0f8a0c1d2e3f", label: "가".repeat(60), at: null, time: "04:30", days: [1, 2, 3, 4, 5, 6, 7], updatedAt: 1_763_000_000_000 };
    expect(alarmsPayload([one])).toMatchObject({ midna: "alarms", alarms: [one] });
    const many = alarmsPayload(Array.from({ length: 20 }, () => one));
    expect(many).toEqual({ aps: { "content-available": 1 }, midna: "alarms" });
  });
});
