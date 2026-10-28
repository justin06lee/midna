import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN } from "@midna/core";
import { MidnaClient, MidnaError, type OutboxItem } from "@midna/protocol";
import type { Brain } from "@midna/agent";
import { startDaemon, type RunningDaemon } from "../src/index.ts";
import { payload, type ApnsResponse } from "../src/push.ts";

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
const brain: Brain = async () => ({ text: "ok", sessionId: "s", sessionCostUsd: 0 });

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

  test("a chat reply and anything fyi are not pushed", async () => {
    tell({ kind: "message" });
    tell({ priority: "fyi" });
    const id = tell({ text: "the one that counts" });
    await until("the alert's push", () => sent.find((s) => s.body.outboxId === id));
    expect(sent).toHaveLength(1);
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
