import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN } from "@midna/core";
import { MidnaClient, MidnaError, type OutboxItem } from "@midna/protocol";
import type { Brain } from "@midna/agent";
import { startDaemon, type RunningDaemon } from "../src/index.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { locatePayload, payload, wantsPush, type ApnsResponse } from "../src/push.ts";

/**
 * Push notifications: a phone registers its Apple push token, each alert
 * goes to Apple signed with the team's key, and a bridge asks whether a push
 * carried an item before sending it itself. Apple is a stand-in here.
 */

const KEY_ID = "TESTKEY123";
const TEAM_ID = "TEAMID4567";
const TOKEN = "ab".repeat(32);
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

interface Sent {
  env: string;
  token: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}
const sent: Sent[] = [];
/** What Apple answers next, per environment; 200 when unset. */
let answer: (s: Sent) => ApnsResponse | Promise<ApnsResponse> = () => ({ status: 200 });

let home: string;
let daemon: RunningDaemon;
let host: MidnaClient;
let phone: MidnaClient;
let phoneId: string;
let mcp: { url: string; token: string } | null = null;
const brain: Brain = async (run) => {
  mcp ??= run.mcp;
  return { text: "ok", sessionId: "s", sessionCostUsd: 0 };
};

async function until<T>(what: string, fn: () => T | undefined | null | false, ms = 5_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Release an item to the outbox; its id. */
const tell = (item: Partial<Pick<OutboxItem, "kind" | "priority" | "text">> & { options?: string[] } = {}) =>
  daemon.store.tell({ kind: "notification", text: "Stand-up in 10 minutes", priority: "normal", conversationId: MAIN, ...item }).id;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "midna-push-"));
  writeFileSync(join(home, `AuthKey_${KEY_ID}.p8`), privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(join(home, "config.json"), JSON.stringify({ push: { apns: { keyId: KEY_ID, teamId: TEAM_ID } } }));
  daemon = await startDaemon({
    home,
    port: 17000 + Math.floor(Math.random() * 20000),
    brain,
    tickMs: 50,
    introDelayMs: -1,
    apnsTransport: async (env, token, headers, body) => {
      const s = { env, token, headers, body: JSON.parse(body) };
      sent.push(s);
      return answer(s);
    },
  });
  daemon.store.updateSettings({ quietHours: null });
  host = new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim());
  const paired = await new MidnaClient(daemon.url).pair({ code: (await host.pairingCode()).code, deviceName: "Justin's iPhone", kind: "mobile" });
  phone = new MidnaClient(daemon.url, paired.token);
  phoneId = paired.deviceId;
});

afterAll(async () => {
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  sent.length = 0;
  answer = () => ({ status: 200 });
  await host.updateSettings({ alerts: "both" });
});

describe("registration", () => {
  test("the host's own token can't register a phone", async () => {
    const err = await host.registerPush({ token: TOKEN, environment: "production" }).catch((e) => e);
    expect(err).toBeInstanceOf(MidnaError);
    expect((err as MidnaError).status).toBe(403);
  });

  test("a token that isn't hex is refused", async () => {
    const err = await phone.registerPush({ token: "not-a-token", environment: "production" }).catch((e) => e);
    expect((err as MidnaError).status).toBe(400);
  });

  test("a phone registers, and status counts it", async () => {
    expect((await host.status()).push).toEqual({ configured: true, phones: 0 });
    await phone.registerPush({ token: TOKEN.toUpperCase(), environment: "production" });
    await phone.registerPush({ token: TOKEN, environment: "production" });
    const s = await host.status();
    expect(s.push).toEqual({ configured: true, phones: 1 });
    expect(s.alerts).toBe("both");
  });

  test("the same token again from the same phone writes nothing; another environment does", async () => {
    const other = "cd".repeat(32);
    expect(daemon.store.push.register(phoneId, { token: other, environment: "production" })).toBe(true);
    expect(daemon.store.push.register(phoneId, { token: other.toUpperCase(), environment: "production" })).toBe(false);
    expect(daemon.store.push.register(phoneId, { token: other, environment: "development" })).toBe(true);
    // Through the API it's still ok, as many times as a phone says it.
    for (let i = 0; i < 3; i++) expect(await phone.registerPush({ token: other, environment: "development" })).toEqual({ ok: true });
    daemon.store.push.unregister(other);
  });
});

describe("alerts", () => {
  test("an alert goes to Apple, signed with the team's key, and Telegram still sends it", async () => {
    const id = tell();
    const s = await until("a push", () => sent[0]);
    expect(s.env).toBe("production");
    expect(s.token).toBe(TOKEN);
    expect(s.headers["apns-topic"]).toBe("sh.midna.mobile");
    expect(s.headers["apns-push-type"]).toBe("alert");
    expect(s.headers["apns-collapse-id"]).toBe(`outbox-${id}`);
    expect(s.body.aps.alert).toEqual({ title: "midna", body: "Stand-up in 10 minutes" });
    expect(s.body.outboxId).toBe(id);

    const [head, claims, sig] = s.headers.authorization!.replace(/^bearer /, "").split(".");
    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({ alg: "ES256", kid: KEY_ID });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString()).iss).toBe(TEAM_ID);
    const ok = verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"));
    expect(ok).toBe(true);

    expect(await phone.delivery(id, 5_000)).toEqual({ channel: "both", push: "sent", bridges: true });
  });

  /** The user writes from a client, as POST /v1/messages logs it. */
  const wrote = (client: string) => daemon.store.log.addMessage({ conversationId: MAIN, role: "user", text: "what's next?", client, seen: true });

  test("a reply to what was said elsewhere, and anything fyi, are not pushed", async () => {
    wrote("desktop");
    tell({ kind: "message" });
    tell({ priority: "fyi" });
    const id = tell({ text: "the one that counts" });
    await until("the alert's push", () => sent.find((s) => s.body.outboxId === id));
    expect(sent).toHaveLength(1);
  });

  test("a reply to what was said on the phone is pushed, time-sensitive, with a badge counting what came since the app was last used", async () => {
    await phone.status(); // the app was just used
    await Bun.sleep(5);
    wrote("mobile");
    const first = tell({ kind: "message", text: "Here's the plan." });
    const s = await until("the reply's push", () => sent.find((x) => x.body.outboxId === first));
    expect(s.body.aps.alert.body).toBe("Here's the plan.");
    expect(s.body.aps["interruption-level"]).toBe("time-sensitive");
    expect(s.body.aps.sound).toBe("default");
    expect(s.body.aps.badge).toBe(1);
    const second = tell({ kind: "message", text: "And one more thing." });
    expect((await until("the second push", () => sent.find((x) => x.body.outboxId === second))).body.aps.badge).toBe(2);
    // Opening the app (any request) starts the count again.
    await Bun.sleep(5);
    await phone.status();
    const third = tell({ kind: "message", text: "Later." });
    expect((await until("the third push", () => sent.find((x) => x.body.outboxId === third))).body.aps.badge).toBe(1);
    // A reply never holds Telegram back, whatever the alerts setting: bridges only ask about alerts.
    wrote("desktop");
  });

  test("under \"push\", Telegram stays out of what a push carried", async () => {
    await host.updateSettings({ alerts: "push" });
    const id = tell({ kind: "question", text: "Move the dentist?", options: ["Yes", "No"] });
    expect(await phone.delivery(id, 5_000)).toEqual({ channel: "push", push: "sent", bridges: false });
    expect(sent[0]!.body.aps.alert.body).toBe("Move the dentist?\nYes · No");
  });

  test("under \"push\", a bridge waits on Apple's answer", async () => {
    await host.updateSettings({ alerts: "push" });
    answer = async () => (await Bun.sleep(300), { status: 200 });
    const id = tell();
    const started = Date.now();
    expect(await phone.delivery(id, 5_000)).toEqual({ channel: "push", push: "sent", bridges: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  test("under \"push\", Telegram sends what Apple refused", async () => {
    await host.updateSettings({ alerts: "push" });
    answer = () => ({ status: 500, reason: "InternalServerError" });
    const id = tell();
    expect(await phone.delivery(id, 5_000)).toEqual({ channel: "push", push: "failed", bridges: true });
    expect(daemon.store.push.tokens()[0]!.last_error).toBe("500 InternalServerError");
  });

  test("an expired signing token is made afresh and the push sent again", async () => {
    let first = true;
    answer = () => (first ? ((first = false), { status: 403, reason: "ExpiredProviderToken" }) : { status: 200 });
    const id = tell();
    expect((await phone.delivery(id, 5_000)).push).toBe("sent");
    expect(sent).toHaveLength(2);
  });

  test("a token from a build for the other environment is pushed there, and remembered", async () => {
    answer = (s) => (s.env === "production" ? { status: 400, reason: "BadDeviceToken" } : { status: 200 });
    const id = tell();
    expect((await phone.delivery(id, 5_000)).push).toBe("sent");
    expect(sent.map((s) => s.env)).toEqual(["production", "development"]);
    expect(daemon.store.push.tokens()[0]!.environment).toBe("development");
    // Put back for the tests after.
    await phone.registerPush({ token: TOKEN, environment: "production" });
  });

  test("\"telegram\" pushes nothing", async () => {
    await host.updateSettings({ alerts: "telegram" });
    const id = tell();
    expect(await phone.delivery(id, 1_000)).toEqual({ channel: "telegram", push: "none", bridges: true });
    expect(sent).toHaveLength(0);
  });
});

describe("dead and gone phones", () => {
  test("a token Apple says is gone is dropped, and Telegram takes over", async () => {
    await host.updateSettings({ alerts: "push" });
    answer = () => ({ status: 410, reason: "Unregistered" });
    const first = tell();
    expect(await phone.delivery(first, 5_000)).toMatchObject({ push: "failed", bridges: true });
    expect((await host.status()).push?.phones).toBe(0);
    const next = tell();
    expect(await phone.delivery(next, 1_000)).toEqual({ channel: "push", push: "none", bridges: true });
  });

  test("a revoked pairing's phone gets nothing, and a phone can unregister", async () => {
    await phone.registerPush({ token: TOKEN, environment: "production" });
    await phone.unregisterPush(TOKEN);
    expect((await host.status()).push?.phones).toBe(0);
    const err = await phone.unregisterPush(TOKEN).catch((e) => e);
    expect((err as MidnaError).status).toBe(404);

    await phone.registerPush({ token: TOKEN, environment: "production" });
    await host.revokeDevice(phoneId);
    expect((await host.status()).push?.phones).toBe(0);
    const id = tell();
    expect((await host.delivery(id, 1_000)).push).toBe("none");
    expect(sent).toHaveLength(0);
  });
});

describe("payload", () => {
  const item = (more: Partial<OutboxItem> = {}): OutboxItem => ({
    id: 7,
    seq: 7,
    kind: "notification",
    conversationId: MAIN,
    text: "Hi",
    priority: "normal",
    options: null,
    createdAt: 0,
    deliverAfter: 0,
    attachments: [],
    ...more,
  });

  test("urgent is marked and time-sensitive; normal is not", () => {
    const urgent = payload(item({ priority: "urgent" }), "midna") as { aps: Record<string, any> };
    expect(urgent.aps.alert.body).toBe("❗ Hi");
    expect(urgent.aps["interruption-level"]).toBe("time-sensitive");
    expect((payload(item(), "midna") as { aps: Record<string, any> }).aps["interruption-level"]).toBe("active");
    expect((payload(item({ kind: "message" }), "midna") as { aps: Record<string, any> }).aps["interruption-level"]).toBe("time-sensitive");
  });

  test("a badge only when there is something to count", () => {
    expect((payload(item(), "midna", 3) as any).aps.badge).toBe(3);
    expect("badge" in (payload(item(), "midna", 0) as any).aps).toBe(false);
  });

  test("which items go to the phones", () => {
    const last = (client: string | null) => () => client;
    expect(wantsPush(item(), last(null))).toBe(true);
    expect(wantsPush(item({ priority: "fyi" }), last("mobile"))).toBe(false);
    expect(wantsPush(item({ kind: "message" }), last("mobile"))).toBe(true);
    expect(wantsPush(item({ kind: "message" }), last("desktop"))).toBe(false);
    expect(wantsPush(item({ kind: "message", priority: "fyi" }), last("mobile"))).toBe(false);
    expect(wantsPush(item({ kind: "message", conversationId: null }), last("mobile"))).toBe(false);
  });

  test("the notification says the words, not the markdown", () => {
    const md = "**Nova** is `live`:\n\n- see [the demo](https://nova.example)\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    expect((payload(item({ text: md, kind: "question", options: ["**Yes**", "Not *yet*"] }), "midna") as any).aps.alert.body).toBe(
      "Nova is live:\n\n• see the demo\n\na · b\n1 · 2\nYes · Not yet",
    );
  });

  test("files are named, and a long text is cut to fit Apple's limit", () => {
    const a = { id: "att_1", name: "plan.pdf", mime: "application/pdf", size: 1, kind: "file" as const, caption: null };
    expect((payload(item({ attachments: [a] }), "midna") as any).aps.alert.body).toBe("Hi\n📎 plan.pdf");
    expect((payload(item({ text: "", attachments: [a, { ...a, id: "att_2" }] }), "midna") as any).aps.alert.body).toBe("📎 2 files");
    const long = (payload(item({ text: "x".repeat(5_000) }), "midna") as any).aps.alert.body as string;
    expect(long.length).toBe(1_200);
    expect(long.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(payload(item({ text: "가".repeat(5_000) }), "midna")))).toBeLessThan(4_096);
  });
});

describe("asking the phone where it is", () => {
  let tools: Client;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await tools.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    const text = r.content[0]!.text;
    return { text, error: !!r.isError, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  const HERE = { lat: 37.33182, lon: -122.03118 };

  beforeAll(async () => {
    // A phone of its own: the one above was unpaired.
    phone = new MidnaClient(daemon.url, (await new MidnaClient(daemon.url).pair({ code: (await host.pairingCode()).code, deviceName: "Justin's iPhone", kind: "mobile" })).token);
    await phone.registerPush({ token: TOKEN, environment: "production" });
    await phone.send({ text: "hi" });
    const m = await until("a brain run", () => mcp);
    tools = new Client({ name: "fake-brain", version: "0" });
    await tools.connect(new StreamableHTTPClientTransport(new URL(m.url), { requestInit: { headers: { authorization: `Bearer ${m.token}` } } }));
  });
  afterAll(() => tools.close().catch(() => {}));

  test("location_now fresh=true sends a silent background push (nothing shown, gone in a minute) and waits for the phone's answer", async () => {
    await phone.reportLocation({ fixes: [{ ...HERE, at: Date.now() - 3 * 3_600_000, accuracy: 65, source: "precise" }] });
    // The phone answers the push with a fix a moment later.
    answer = (s) => {
      if (s.body.midna === "locate") setTimeout(() => void phone.reportLocation({ fixes: [{ lat: 37.4, lon: -122.1, at: Date.now(), accuracy: 5, source: "requested" }] }), 300);
      return { status: 200 };
    };
    const now = (await call("location_now", { fresh: true })).json;
    expect(now).toMatchObject({ fresh: true, reported: "when midna asked", accuracy_m: 5, where: "37.40000,-122.10000" });
    expect(now.fix_age).toMatch(/^\d+ s ago$/);
    const s = sent.find((x) => x.body.midna === "locate")!;
    expect(s.body).toEqual(locatePayload());
    expect(locatePayload()).toEqual({ aps: { "content-available": 1 }, midna: "locate" });
    expect(s.headers).toMatchObject({ "apns-push-type": "background", "apns-priority": "5", "apns-topic": "sh.midna.mobile" });
    expect(Number(s.headers["apns-expiration"]) - Date.now() / 1000).toBeLessThanOrEqual(61);
  });

  test("a place saved without coordinates is where the phone is now", async () => {
    answer = (s) => {
      if (s.body.midna === "locate") setTimeout(() => void phone.reportLocation({ fixes: [{ lat: 37.5, lon: -122.2, at: Date.now(), accuracy: 8, source: "requested" }] }), 100);
      return { status: 200 };
    };
    const saved = (await call("place_save", { name: "Cafe" })).json;
    expect(saved).toMatchObject({ name: "Cafe", at: "37.50000,-122.20000", from_fix: { fresh: true, accuracy_m: 8 } });
  });

  test("when Apple won't take the ask, location_now says so at once and gives the last fix", async () => {
    answer = () => ({ status: 500, reason: "InternalServerError" });
    const started = Date.now();
    const now = (await call("location_now", { fresh: true })).json;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(now.fresh).toBe(false);
    expect(now.note).toContain("couldn't ask the phone (500 InternalServerError)");
    expect(now.where).toBe("37.50000,-122.20000");
  });
});

describe("Screen Time: midna holds the rules, the phone carries them out", () => {
  let tools: Client;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await tools.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    const text = r.content[0]!.text;
    return { text, error: !!r.isError, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  const report = (minutes: number, day = "2026-11-18") => ({ days: [{ day, minutes, hits: 4 }], authorized: true, shielded: true, apps: 3, categories: 0, sites: 1 });

  beforeAll(async () => {
    await phone.registerPush({ token: TOKEN, environment: "production" });
    if (!mcp) await phone.send({ text: "hi" });
    const m = await until("a brain run", () => mcp);
    tools = new Client({ name: "fake-brain", version: "0" });
    await tools.connect(new StreamableHTTPClientTransport(new URL(m.url), { requestInit: { headers: { authorization: `Bearer ${m.token}` } } }));
  });
  afterAll(() => tools.close().catch(() => {}));

  test("before the phone has reported, screen_time says it isn't set up", async () => {
    expect((await call("screen_time")).text).toStartWith("Screen Time isn't set up on the phone yet");
  });

  test("the phone reports with its location-only token, and a later report of a day replaces the earlier", async () => {
    const reporter = new MidnaClient(daemon.url, (await phone.locationToken()).token);
    await reporter.reportFocus(report(30));
    await reporter.reportFocus(report(45));
    const s = await host.focus();
    expect(s.days).toEqual([{ day: "2026-11-18", minutes: 45, hits: 4, reportedAt: expect.any(Number) }]);
    expect(s.phone).toMatchObject({ authorized: true, apps: 3 });
    // It still opens nothing else.
    expect(((await reporter.focus().catch((e) => e)) as MidnaError).status).toBe(403);
  });

  test("midna puts the shield up with no reason needed, and the rules ride a silent push to the phone", async () => {
    sent.length = 0;
    const r = (await call("screen_time_rules", { held: true, until: "+2h", windows: [{ start: "21:00", end: "23:30" }], offer: { title: "Justice", url: "https://books.apple.com/justice" } })).json;
    expect(r.rules).toMatchObject({ held: expect.stringMatching(/^until /), windows: ["21:00–23:30"], offer: { title: "Justice" } });
    const s = await until("the rules' push", () => sent.find((x) => x.body.midna === "focus"));
    expect(s.headers["apns-push-type"]).toBe("background");
    expect(s.body.aps).toEqual({ "content-available": 1 });
    expect(s.body.rules).toMatchObject({ held: true, windows: [{ start: 1260, end: 1410 }], offer: { title: "Justice" } });
  });

  test("letting go of a hold is a lift: it needs a reason, and is kept with it", async () => {
    const refused = (await host.setFocusRules({ held: false }).catch((e) => e)) as MidnaError;
    expect(refused.status).toBe(409);
    const r = (await call("screen_time_lift", { minutes: 15, reason: "Replying to Sam's DM about Friday", end_hold: true })).json;
    expect(r.rules).toMatchObject({ held: false, latest_lift: { minutes: 15, by: "midna", reason: "Replying to Sam's DM about Friday" } });
    expect((await call("screen_time_lift", { minutes: 15, reason: "" })).error).toBe(true);
  });

  test("the phone lifts with a reason; only the phone does", async () => {
    const rules = await phone.liftFocus({ minutes: 5, reason: "Checking the event time" });
    expect(rules.lift).toMatchObject({ minutes: 5, by: "phone", reason: "Checking the event time" });
    expect(((await host.liftFocus({ minutes: 5, reason: "because" }).catch((e) => e)) as MidnaError).status).toBe(403);
  });

  test("screen_time fresh asks the phone and waits for its numbers", async () => {
    answer = (s) => {
      if (s.body.midna === "focus") setTimeout(() => void phone.reportFocus(report(60)), 200);
      return { status: 200 };
    };
    const s = (await call("screen_time", { fresh: true })).json;
    expect(s.note).toBeUndefined();
    expect(s.days.at(-1)).toEqual({ day: "2026-11-18", minutes_in_held_apps: 60, shields_met: 4 });
    expect(s.lifts.map((l: { by: string }) => l.by)).toEqual(["midna", "phone"]);
  });
});
