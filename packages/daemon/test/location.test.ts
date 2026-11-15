import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MidnaClient, type LocationFix, type PairRequest } from "@midna/protocol";
import type { Brain, BrainRun } from "@midna/agent";
import { startDaemon, type RunningDaemon } from "../src/index.ts";

/**
 * Where the user is: the phone reports its fixes (with the pairing's token,
 * or a location-only one it can read while locked), midna keeps every one,
 * the apps manage the saved places, and midna's tools answer where the user
 * is and has been.
 */

const TZ = "America/Los_Angeles";
const HOME = { lat: 37.33182, lon: -122.03118 };
const GYM = { lat: 37.3349, lon: -122.009 };
const MIN = 60_000;

let home: string;
let daemon: RunningDaemon;
let host: MidnaClient;
let phone: MidnaClient;
let phoneId: string;
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
  return { client: new MidnaClient(daemon.url, p.token), id: p.deviceId };
};

const fix = (where: { lat: number; lon: number }, at: number, more: Partial<LocationFix> = {}): LocationFix => ({ ...where, at, accuracy: 65, source: "significant", ...more });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "midna-location-"));
  daemon = await startDaemon({ home, port: 17000 + Math.floor(Math.random() * 20000), brain, tickMs: 3_000, introDelayMs: 10 });
  daemon.store.updateSettings({ quietHours: null, timezone: TZ });
  host = new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim());
  ({ client: phone, id: phoneId } = await pair("Justin's iPhone", "mobile"));
  const intro = await until("a brain run", () => runs[0]);
  tools = new Client({ name: "fake-brain", version: "0" });
  await tools.connect(new StreamableHTTPClientTransport(new URL(intro.mcp.url), { requestInit: { headers: { authorization: `Bearer ${intro.mcp.token}` } } }));
}, 15_000);

afterAll(async () => {
  await tools.close().catch(() => {});
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("the phone reports", () => {
  test("before any fix, midna says it doesn't know", async () => {
    expect((await tool("location_now")).text).toContain("No location yet");
    expect(await phone.location()).toMatchObject({ latest: null, place: null, points: 0 });
  });

  test("fixes are kept once each, and only the phone may send them", async () => {
    const t0 = Date.now() - 60 * MIN;
    const sent = [fix(GYM, t0), fix(HOME, t0 + 30 * MIN)];
    expect(await phone.reportLocation({ fixes: sent })).toEqual({ kept: 2, places: [] });
    // A retry after a lost answer keeps nothing new.
    expect((await phone.reportLocation({ fixes: sent })).kept).toBe(0);

    const mac = await pair("Mac", "desktop");
    await expect(mac.client.reportLocation({ fixes: [fix(HOME, t0)] })).rejects.toMatchObject({ status: 403 });
    await expect(phone.reportLocation({ fixes: [{ ...fix(HOME, t0), lat: 91 }] })).rejects.toMatchObject({ status: 400 });
    await expect(phone.reportLocation({ fixes: [] })).rejects.toMatchObject({ status: 400 });
    expect((await mac.client.location()).points).toBe(2);
  });

  test("the location-only token reports and does nothing else; a new one retires the last, and unpairing retires it", async () => {
    const p = await pair("Second iPhone", "mobile");
    const first = await p.client.locationToken();
    const second = await p.client.locationToken();
    const loc = new MidnaClient(daemon.url, second.token);
    const at = Date.now() - 45 * MIN;
    expect((await loc.reportLocation({ fixes: [fix(HOME, at, { source: "app" })] })).kept).toBe(1);
    // Kept under the phone's pairing: the same fix from its own token is the same fix.
    expect((await p.client.reportLocation({ fixes: [fix(HOME, at, { source: "app" })] })).kept).toBe(0);
    for (const call of [() => loc.location(), () => loc.status(), () => loc.history(), () => loc.places(), () => loc.locationToken(), () => loc.savePlace({ name: "x", ...HOME })]) {
      await expect(call()).rejects.toMatchObject({ status: 403 });
    }
    await expect(new MidnaClient(daemon.url, first.token).reportLocation({ fixes: [fix(HOME, at + 1)] })).rejects.toMatchObject({ status: 401 });
    // The host and the desktop can't mint one.
    await expect(host.locationToken()).rejects.toMatchObject({ status: 403 });

    await p.client.revokeDevice(p.id);
    await expect(loc.reportLocation({ fixes: [fix(HOME, at + 2)] })).rejects.toMatchObject({ status: 401 });
  });

  test("bridges never see where the user is", async () => {
    const telegram = await pair("Telegram", "bridge");
    await expect(telegram.client.location()).rejects.toMatchObject({ status: 403 });
    await expect(telegram.client.places()).rejects.toMatchObject({ status: 403 });
    await expect(telegram.client.savePlace({ name: "Home", ...HOME })).rejects.toMatchObject({ status: 403 });
  });
});

describe("places", () => {
  test("the app saves, moves, renames and deletes places; a name is one place, in any case", async () => {
    const saved = await phone.savePlace({ name: "Home", ...HOME });
    expect(saved).toMatchObject({ name: "Home", radius: 150 });
    const moved = await phone.savePlace({ name: "home", lat: HOME.lat + 0.0001, lon: HOME.lon, radius: 200 });
    expect(moved).toMatchObject({ id: saved.id, name: "Home", radius: 200 });
    expect((await phone.places()).length).toBe(1);

    const office = await phone.savePlace({ name: "Office", lat: 37.3861, lon: -122.0839 });
    await expect(phone.editPlace(office.id, { name: "HOME" })).rejects.toMatchObject({ status: 400 });
    expect(await phone.editPlace(office.id, { name: "Work" })).toMatchObject({ id: office.id, name: "Work" });
    await expect(phone.savePlace({ name: "Tiny", ...HOME, radius: 20 })).rejects.toMatchObject({ status: 400 });
    expect(await phone.deletePlace(office.id)).toEqual({ ok: true });
    await expect(phone.deletePlace(office.id)).rejects.toMatchObject({ status: 404 });
    await expect(phone.editPlace(office.id, { name: "Back" })).rejects.toMatchObject({ status: 404 });
    expect((await phone.places()).map((p) => p.name)).toEqual(["Home"]);
    // What the phone is told to watch comes back with every report.
    expect((await phone.reportLocation({ fixes: [fix(HOME, Date.now() - 20 * MIN)] })).places.map((p) => p.name)).toEqual(["Home"]);
  });

  test("midna's tools save a place where the phone last was, move one there, and delete one", async () => {
    // The phone was last at home (above): "this is my gym" while standing at the gym needs a fix there first.
    await phone.reportLocation({ fixes: [fix(GYM, Date.now() - 15 * MIN)] });
    const gym = await tool("place_save", { name: "Gym" });
    expect(gym.error).toBe(false);
    expect(gym.json).toMatchObject({ name: "Gym", at: `${GYM.lat.toFixed(5)},${GYM.lon.toFixed(5)}`, radius_m: 150 });
    expect((await tool("place_save", { name: "Masjid", lat: 37.35, lon: -122.0, radius_m: 300 })).json).toMatchObject({ name: "Masjid", radius_m: 300 });
    expect((await tool("place_save", { name: "Masjid", lat: 37.35 })).error).toBe(true);
    // A saved place without coordinates keeps its own; here=true moves it to the phone.
    expect((await tool("place_save", { name: "masjid", radius_m: 250 })).json).toMatchObject({ at: "37.35000,-122.00000", radius_m: 250 });
    expect((await tool("place_save", { name: "Masjid", here: true })).json.at).toBe(gym.json.at);
    expect((await tool("places_list")).json.map((p: { name: string }) => p.name)).toEqual(["Gym", "Home", "Masjid"]);
    const masjid = (await tool("places_list")).json.find((p: { name: string }) => p.name === "Masjid");
    expect((await tool("place_delete", { id: masjid.id })).text).toBe("deleted Masjid");
    expect((await tool("place_delete", { id: masjid.id })).error).toBe(true);
    expect((await phone.places()).map((p) => p.name)).toEqual(["Gym", "Home"]);
  });
});

describe("where the user is", () => {
  test("location_now names the place, since when, and how old the fix is", async () => {
    const now = Date.now();
    await phone.reportLocation({
      fixes: [
        fix(HOME, now - 12 * MIN, { source: "arrive", place: (await phone.places()).find((p) => p.name === "Home")!.id }),
        fix({ lat: HOME.lat + 0.0003, lon: HOME.lon }, now - 5 * MIN),
      ],
    });
    const here = (await tool("location_now")).json;
    expect(here).toMatchObject({ place: "Home", reported: "on a significant move", accuracy_m: 65 });
    expect(here.fix_age).toBe("5 min ago");
    expect(here.there_for).toBe("12 min");
    expect(here.map).toStartWith("https://maps.apple.com/?ll=");
    expect((await phone.location()).place?.name).toBe("Home");
  });

  test("after leaving, midna says so and how far the nearest place is", async () => {
    const homeId = (await phone.places()).find((p) => p.name === "Home")!.id;
    await phone.reportLocation({ fixes: [fix(HOME, Date.now() - 2 * MIN, { source: "leave", place: homeId })] });
    const left = (await tool("location_now")).json;
    expect(left.place).toBeNull();
    expect(left.just_left).toBe("Home");
    expect(left.nearest_place).toBe("Home");
    expect(left.fix_age).toBe("2 min ago");

    await phone.reportLocation({ fixes: [fix({ lat: 37.4, lon: -122.1 }, Date.now() - 1 * MIN)] });
    const away = (await tool("location_now")).json;
    expect(away.place).toBeNull();
    expect(away.nearest_is).toMatch(/^\d+(\.\d)? km away$/);
  });

  test("a fix that arrives late doesn't pass for the latest", async () => {
    const before = (await tool("location_now")).json.fix_at;
    await phone.reportLocation({ fixes: [fix(GYM, Date.now() - 3 * 60 * MIN)] });
    expect((await tool("location_now")).json.fix_at).toBe(before);
  });

  test("location_history lists the fixes in a window, oldest first, with each one's place and why", async () => {
    const all = (await tool("location_history")).json;
    expect(all.total).toBe(all.points.length);
    const ats = all.points.map((p: { at: string }) => p.at);
    expect([...ats].sort()).toEqual(ats);
    const why = all.points.map((p: { why: string }) => p.why);
    expect(why).toContain("arrived at Home");
    expect(why).toContain("left Home");
    expect(why).toContain("app opened");
    expect(all.points.find((p: { why: string }) => p.why === "arrived at Home").place).toBe("Home");

    const latestTwo = (await tool("location_history", { limit: 2 })).json;
    expect(latestTwo.points.length).toBe(2);
    expect(latestTwo.total).toBe(all.total);
    expect(latestTwo.points.at(-1).at).toBe(ats.at(-1));
    expect((await tool("location_history", { from: "2026-01-02", to: "2026-01-01" })).error).toBe(true);
  });

  test("a deleted place's fixes keep its name", async () => {
    const home = (await phone.places()).find((p) => p.name === "Home")!;
    await phone.deletePlace(home.id);
    const points = (await tool("location_history")).json.points;
    expect(points.find((p: { why: string }) => p.why === "left Home").place).toBe("Home");
  });
});
