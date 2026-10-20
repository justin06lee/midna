import { describe, expect, test } from "bun:test";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_OPTIONS, AnswerApproval, HANDS_POLICY, HandsCommand, HandsHello, HandsResult, OPS, OP_ARGS, canonicalJson, type Approval, type HandsStreamEvent } from "../src/index.ts";

/**
 * The fixture the desktop app's Rust tests read too (packages/protocol/fixtures/hands.json):
 * a test-only key, a hello, a signed command and a tampered one, and results. Regenerate
 * with HANDS_FIXTURE=write bun test packages/protocol.
 */

const FIXTURE = join(import.meta.dir, "../fixtures/hands.json");
const seed = Buffer.alloc(32, 7); // test only — never a real key
const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const raw = Buffer.from(createPublicKey(key).export({ format: "jwk" }).x!, "base64url");

function build() {
  const hello = HandsHello.parse({
    protocol: 1,
    app: { version: "0.8.0" },
    os: { family: "macos", version: "26.0", arch: "arm64", hostname: "Justins-MacBook-Air", session: "quartz" },
    displays: [{ id: "1", name: "Built-in Retina Display", primary: true, x: 0, y: 0, width: 1470, height: 956, scale: 2 }],
    offers: { screen: "on", open: "on", notify: "on", input: "ask" },
    permissions: { screen_recording: "granted", accessibility: "not_asked", notifications: "granted" },
    state: "ready",
    nonce: "n0nce-7f3a9c2e5b1d4f60",
  });
  const command = HandsCommand.parse({ id: "cmd_fixture1", nonce: hello.nonce, seq: 1, op: "screenshot", args: { display: "1" }, timeoutMs: 10_000, episodeId: 42, issuedAt: 1_792_447_200_000 });
  const signed = canonicalJson(command);
  const sig = sign(null, Buffer.from(signed), key).toString("base64url");
  const tampered = signed.replace('"display":"1"', '"display":"2"');
  const approval: Approval = {
    id: "apr_fixture1",
    deviceId: "dev_fixture",
    deviceName: "MacBook Air",
    capability: "shell",
    op: "shell",
    summary: "run `brew upgrade` on MacBook Air",
    commandId: "cmd_fixture3",
    episodeId: 42,
    outboxId: 7,
    requestedAt: 1_792_447_200_000,
    expiresAt: 1_792_447_320_000,
    state: "pending",
    answer: null,
    answeredBy: null,
    answeredVia: null,
    answeredAt: null,
  };
  const events: Record<"command" | "tampered" | "cancel" | "bye" | "approval", HandsStreamEvent> = {
    command: { type: "command", signed, sig },
    tampered: { type: "command", signed: tampered, sig },
    cancel: { type: "cancel", id: command.id },
    bye: { type: "bye", reason: "replaced" },
    approval: { type: "approval", approval },
  };
  const results = [
    HandsResult.parse({ id: command.id, ok: true, data: { width: 1470, height: 956, display: "1", scale: 2, cursor: { x: 700, y: 400 } }, attachments: ["att_fixturepng"], ms: 412 }),
    HandsResult.parse({ id: "cmd_fixture2", ok: false, ms: 3, error: { code: "permission", message: "Screen Recording isn't granted", permission: "screen_recording" } }),
  ];
  const fingerprint = createHash("sha256").update(raw).digest("hex").slice(0, 32).match(/.{4}/g)!.join(" ");
  return { note: "Test vectors for device hands. The key is test-only.", seedHex: seed.toString("hex"), daemonKey: raw.toString("base64url"), fingerprint, hello, command, events, results };
}

describe("hands fixture", () => {
  const built = build();
  if (process.env.HANDS_FIXTURE === "write") writeFileSync(FIXTURE, JSON.stringify(built, null, 2) + "\n");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as ReturnType<typeof build>;

  test("is what the shapes produce today", () => {
    expect(fixture).toEqual(JSON.parse(JSON.stringify(built)));
  });

  test("its command verifies over the bytes as sent, and the tampered one doesn't", () => {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: fixture.daemonKey }, format: "jwk" });
    const ok = (e: HandsStreamEvent) => e.type === "command" && verify(null, Buffer.from(e.signed), pub, Buffer.from(e.sig, "base64url"));
    expect(ok(fixture.events.command)).toBe(true);
    expect(ok(fixture.events.tampered)).toBe(false);
    expect(HandsCommand.parse(JSON.parse((fixture.events.command as { signed: string }).signed))).toEqual(fixture.command);
  });
});

describe("canonical JSON", () => {
  test("sorted keys at every depth, no whitespace, undefined left out", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: true, y: null }], c: "x" }, e: undefined })).toBe('{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}');
  });
});

describe("the policy table", () => {
  test("names only real operations, and every capability has a default", () => {
    for (const op of HANDS_POLICY.observe) expect(OPS).toHaveProperty(op);
    expect(Object.keys(HANDS_POLICY.defaults).sort()).toEqual([...new Set(Object.values(OPS))].sort());
  });

  test("is Justin's fork 2: everything starts On, and only looking (and notify) runs in ask mode without a yes", () => {
    expect(new Set(Object.values(HANDS_POLICY.defaults))).toEqual(new Set(["on"]));
    expect([...HANDS_POLICY.observe].sort()).toEqual(["clipboard_read", "file_list", "file_read", "notify", "screenshot"]);
  });
});

describe("operations", () => {
  test("every one has its arguments' shape", () => {
    expect(Object.keys(OP_ARGS).sort()).toEqual(Object.keys(OPS).sort());
    expect(OP_ARGS.click.parse({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
    expect(OP_ARGS.scroll.parse({ dy: 300 })).toEqual({ dx: 0, dy: 300 });
    expect(OP_ARGS.script.parse({ source: "beep" })).toEqual({ source: "beep", language: "applescript" });
    expect(OP_ARGS.file_write.parse({ path: "~/a.txt", text: "hi" })).toEqual({ path: "~/a.txt", text: "hi", mode: "create" });
    expect(OP_ARGS.file_write.safeParse({ path: "~/a.txt", text: "hi", attachmentId: "att_x" }).success).toBe(false);
    expect(OP_ARGS.clipboard_write.safeParse({}).success).toBe(false);
    expect(OP_ARGS.drag.safeParse({ path: [{ x: 1, y: 1 }] }).success).toBe(false);
  });
});

describe("approvals", () => {
  test("offer allow, allow for 10 min and deny, and an answer says where it came from", () => {
    expect(APPROVAL_OPTIONS.map((o) => o.answer)).toEqual(["allow", "allow_10_min", "deny"]);
    expect(AnswerApproval.parse({ answer: "allow_10_min", client: "telegram" })).toEqual({ answer: "allow_10_min", client: "telegram" });
    expect(AnswerApproval.parse({ answer: "deny" })).toEqual({ answer: "deny", client: "unknown" });
    expect(AnswerApproval.safeParse({ answer: "maybe" }).success).toBe(false);
  });
});
