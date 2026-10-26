import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MAX_ATTACHMENT_BYTES } from "@midna/protocol";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCHIVE_BELOW, DAY, HOUR, Store, afterQuietHours, contextSections, fmt, logTail, nearlySame, parseWhen, pinnedFacts, renderContext, strength } from "../src/index.ts";
import { MIGRATIONS } from "../src/db.ts";

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

  test("the working context has the same sections every turn; pinned facts stay out of it, for the system prompt", () => {
    const s = fresh();
    const titles = contextSections(s).map((x) => x.title);
    expect(titles).toEqual(["The user's objectives", "Calendar, next 48 hours", "Open tasks", "Open commitments", "Your own scheduled wakeups, next 24 hours", "Decisions due for review", "People overdue for contact", "What you know about the user (strongest memories)"]);
    expect(pinnedFacts(s)).toBe("");
    const low = s.memory.remember({ content: "Likes oat milk", kind: "preference", importance: 3, pinned: true });
    const high = s.memory.remember({ content: "Allergic to penicillin", kind: "identity", importance: 9, pinned: true });
    s.memory.remember({ content: "Works from cafes on Fridays", kind: "pattern", importance: 5 });
    s.planning.saveTask({ title: "Renew the passport" });
    expect(pinnedFacts(s)).toBe(`- #${high.id} (identity) Allergic to penicillin\n- #${low.id} (preference) Likes oat milk`);
    const sections = contextSections(s);
    expect(sections.map((x) => x.title)).toEqual(titles);
    const facts = sections.at(-1)!.body;
    expect(facts).toContain("Works from cafes on Fridays");
    expect(facts).not.toContain("penicillin");
    expect(sections[2]!.body).toContain("Renew the passport");
    expect(sections[1]!.body).toBe("");
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

  test("pairing again with the old token retires the old device; a stale one retires nothing", () => {
    const s = fresh();
    const first = s.devices.pair(s.devices.pairingCode().code, "Mac (desktop)", "desktop")!;
    const bridge = s.devices.create("Telegram bridge", "bridge");
    const again = s.devices.pair(s.devices.pairingCode().code, "Mac (desktop)", "desktop", Date.now(), first.token)!;
    expect(again.replaced).toBe(first.device.id);
    expect(s.devices.authenticate(first.token)).toBeNull();
    expect(s.devices.list().map((d) => d.id).sort()).toEqual([bridge.device.id, again.device.id].sort());
    // The old token again (now revoked), or one that never existed: still pairs.
    for (const stale of [first.token, "mdn_nothing"]) {
      const p = s.devices.pair(s.devices.pairingCode().code, "Mac (desktop)", "desktop", Date.now(), stale)!;
      expect(p.replaced).toBeUndefined();
      expect(s.devices.authenticate(p.token)!.id).toBe(p.device.id);
    }
    expect(s.devices.authenticate(again.token)!.id).toBe(again.device.id);
    expect(s.devices.authenticate(bridge.token)!.id).toBe(bridge.device.id);
  });
});

describe("attachments", () => {
  const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

  test("a file is kept with what it is, judged by its bytes over its name", () => {
    const s = fresh();
    const a = s.attachments.add({ data: PNG, name: "../../etc/shot.jpg", mime: "application/octet-stream" });
    // A PNG called .jpg is renamed to match what it is.
    expect(a).toMatchObject({ kind: "image", name: "shot.png", mime: "image/png", size: PNG.byteLength, caption: null });
    expect(a.id).toMatch(/^att_/);
    expect(s.attachments.read(a.id)!.data).toEqual(PNG);
    const doc = s.attachments.add({ data: new TextEncoder().encode("hello"), name: "notes.txt" });
    expect(doc).toMatchObject({ kind: "file", mime: "text/plain" });
    expect(() => s.attachments.add({ data: new Uint8Array(0), name: "empty.png" })).toThrow(/empty/);
    expect(() => s.attachments.add({ data: new Uint8Array(MAX_ATTACHMENT_BYTES + 1), name: "huge.bin" })).toThrow(/100 MB/);
  });

  test("any type is kept, named and typed by what it is", () => {
    const s = fresh();
    const bytes = (head: string, n = 64) => Uint8Array.from({ length: n }, (_, i) => head.charCodeAt(i) || 0);
    const kept = (data: Uint8Array, name: string, mime?: string) => {
      const a = s.attachments.add({ data, name, mime });
      return [a.name, a.mime, a.kind];
    };
    // A .docx is a zip inside: its name says more than its bytes.
    expect(kept(bytes("PK\u0003\u0004"), "Q4 plan.docx")).toEqual(["Q4 plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "file"]);
    expect(kept(bytes("PK\u0003\u0004"), "results")).toEqual(["results.zip", "application/zip", "file"]);
    expect(kept(bytes("%PDF-1.7"), "")).toEqual(["file.pdf", "application/pdf", "file"]);
    expect(kept(bytes("\u001f\u008b"), "logs.tar.gz")).toEqual(["logs.tar.gz", "application/gzip", "file"]);
    expect(kept(bytes("OggS"), "voice", "audio/ogg")).toEqual(["voice.ogg", "audio/ogg", "file"]);
    expect(kept(new TextEncoder().encode("all: build"), "Makefile")).toEqual(["Makefile", "application/octet-stream", "file"]);
    expect(kept(new TextEncoder().encode("# hi"), "README", "text/plain")).toEqual(["README", "text/plain", "file"]);
    expect(kept(bytes("MZ"), "setup.exe")).toEqual(["setup.exe", "application/vnd.microsoft.portable-executable", "file"]);
  });

  test("the sender chooses a caption, and to send an image as a file", () => {
    const s = fresh();
    expect(s.attachments.add({ data: PNG, name: "chart.png", caption: "  week 42 ", as: "file" })).toMatchObject({ kind: "file", mime: "image/png", caption: "week 42" });
    expect(s.attachments.add({ data: PNG, name: "chart.png", as: "image" }).kind).toBe("image");
    expect(s.attachments.add({ data: new TextEncoder().encode("x"), name: "a.txt", as: "image" }).kind).toBe("file");
  });

  test("attachments keep the order they were listed in, not the order they were made", () => {
    const s = fresh();
    const emitted: Array<{ type: string; item?: { attachments: Array<{ id: string }> } }> = [];
    s.bus.on((e) => emitted.push(e as never));
    const [a, b, c] = ["a.png", "b.pdf", "c.zip"].map((name) => s.attachments.add({ data: PNG, name }));
    const ids = (list: Array<{ id: string }> | undefined) => (list ?? []).map((x) => x.id);
    const item = s.say({ kind: "message", text: "three", attachments: [c!.id, a!.id, b!.id] }, { client: "chat", seenByBrain: true });
    const want = [c!.id, a!.id, b!.id];
    expect(ids(item.attachments)).toEqual(want);
    expect(ids(emitted.find((e) => e.type === "outbox")!.item!.attachments)).toEqual(want);
    expect(ids(s.outbox.since(0)[0]!.attachments)).toEqual(want);
    expect(ids(s.log.history("main")[0]!.attachments)).toEqual(want);

    const [d, e] = ["d.txt", "e.txt"].map((name) => s.attachments.add({ data: PNG, name }));
    const msg = s.log.addMessage({ conversationId: "main", role: "user", text: "", client: "desktop", seen: false });
    s.attachments.link([e!.id, d!.id], { messageId: msg.id });
    expect(ids(s.attachments.forMessages([msg.id]).get(msg.id))).toEqual([e!.id, d!.id]);
    expect(ids(s.log.history("main")[1]!.attachments)).toEqual([e!.id, d!.id]);
  });

  test("what midna says carries its attachments, on the stream and in history", () => {
    const s = fresh();
    const emitted: unknown[] = [];
    s.bus.on((e) => emitted.push(e));
    const shot = s.attachments.add({ data: PNG, name: "shot.png" });
    const item = s.say({ kind: "message", text: "Here it is", attachments: [shot.id] }, { client: "chat", seenByBrain: true });
    expect(item.attachments).toEqual([shot]);
    expect(emitted).toContainEqual({ type: "outbox", item: expect.objectContaining({ attachments: [shot] }) });
    expect(s.outbox.since(0)[0]!.attachments).toEqual([shot]);
    const [line] = s.log.history("main");
    expect(line).toMatchObject({ text: "Here it is", attachments: [shot] });
    // The brain reads back what it sent.
    expect(s.log.recent("main", 1)[0]!.text).toBe("Here it is\n[sent with it: shot.png]");
  });

  test("an attachment goes with one message only", () => {
    const s = fresh();
    const photo = s.attachments.add({ data: PNG, name: "photo.png" });
    const msg = s.log.addMessage({ conversationId: "main", role: "user", text: "", client: "telegram", seen: false });
    expect(s.attachments.link([photo.id, "att_nope"], { messageId: msg.id })).toEqual([photo]);
    expect(s.attachments.link([photo.id], { outboxId: 1 })).toEqual([]);
    expect(s.attachments.forMessages([msg.id]).get(msg.id)).toEqual([photo]);
    expect(s.log.history("main")[0]!.attachments).toEqual([photo]);
  });

  test("unsent uploads can be taken back, and are swept away after a while", () => {
    const s = fresh();
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const removed = s.attachments.add({ data: PNG, name: "oops.png" }, now);
    const old = s.attachments.add({ data: PNG, name: "forgotten.png" }, now - 2 * day);
    const recent = s.attachments.add({ data: PNG, name: "draft.png" }, now - 60_000);
    const sent = s.attachments.add({ data: PNG, name: "sent.png" }, now - 2 * day);
    s.say({ kind: "message", text: "", attachments: [sent.id] }, { client: "chat", seenByBrain: true });
    expect(s.attachments.remove(removed.id)).toBe("removed");
    expect(s.attachments.remove(removed.id)).toBe("missing");
    expect(s.attachments.remove(sent.id)).toBe("sent");
    expect(s.attachments.sweep(now - day)).toBe(1);
    expect(s.attachments.get(old.id)).toBeNull();
    expect(s.attachments.get(recent.id)).not.toBeNull();
    expect(s.attachments.get(sent.id)).not.toBeNull();
  });

  test("a chat episode stages files for the reply it is still writing", () => {
    const s = fresh();
    const episode = s.log.startEpisode({ kind: "chat", conversationId: "main", model: "test" });
    const a = s.attachments.add({ data: PNG, name: "a.png", episodeId: episode });
    const b = s.attachments.add({ data: PNG, name: "b.png", episodeId: episode });
    expect(s.attachments.staged(episode)).toEqual([a.id, b.id]);
    s.say({ kind: "message", text: "", attachments: s.attachments.staged(episode) }, { client: "chat", seenByBrain: true });
    expect(s.attachments.staged(episode)).toEqual([]);
  });

  test("one already kept goes on as a copy, named and captioned anew, in the order it was attached", () => {
    const s = fresh();
    const shot = s.attachments.add({ data: PNG, name: "screenshot-1.png", source: "upload from MacBook Air" });
    const episode = s.log.startEpisode({ kind: "chat", conversationId: "main", model: "test" });
    const first = s.attachments.add({ data: PNG, name: "chart.png", episodeId: episode });
    const copy = s.attachments.copy(shot.id, { episodeId: episode, name: "desk", caption: " your desktop " });
    expect(copy).toMatchObject({ kind: "image", name: "desk.png", mime: "image/png", caption: "your desktop" });
    expect(copy.id).not.toBe(shot.id);
    expect(s.attachments.read(copy.id)!.data).toEqual(PNG);
    // Made after chart.png, so it follows it, though the screenshot itself is older.
    expect(s.attachments.staged(episode)).toEqual([first.id, copy.id]);
    // Once sent, the original can still go again, as a file this time.
    s.say({ kind: "message", text: "", attachments: [shot.id] }, { client: "chat", seenByBrain: true });
    expect(s.attachments.copy(shot.id, { as: "file" })).toMatchObject({ kind: "file", name: "screenshot-1.png" });
    expect(() => s.attachments.copy("att_nope")).toThrow(/no attachment/);
  });
});

describe("device hands", () => {
  const hello = {
    protocol: 1 as const,
    app: { version: "0.8.0" },
    os: { family: "macos" as const, version: "26.0", arch: "arm64", hostname: "air" },
    displays: [{ id: "1", name: "Built-in", primary: true, x: 0, y: 0, width: 1470, height: 956, scale: 2 }],
    offers: { screen: "on" as const },
    permissions: { screen_recording: "not_asked" as const },
    state: "ready" as const,
    nonce: "a-fresh-nonce-0001",
  };

  test("a device's last hello is kept without its nonce, with changes folded in, until it is unpaired", () => {
    const s = fresh();
    const { device } = s.devices.create("MacBook Air", "desktop", 1000);
    s.hands.saveHello(device.id, hello, 2000);
    expect(s.hands.get(device.id)).toMatchObject({ name: "MacBook Air", lastSeenAt: 2000, hello: { state: "ready", offers: { screen: "on" } } });
    expect(s.hands.get(device.id)!.hello).not.toHaveProperty("nonce");
    s.hands.update(device.id, { state: "locked", permissions: { screen_recording: "granted" }, offers: { screen: "on", open: "on" } }, 3000);
    expect(s.hands.get(device.id)).toMatchObject({ lastSeenAt: 3000, hello: { state: "locked", permissions: { screen_recording: "granted" }, offers: { open: "on" } } });
    s.devices.revoke(device.id);
    expect(s.hands.list()).toEqual([]);
  });

  test("every command is in the audit log: decided, then ended once, newest first", () => {
    const s = fresh();
    const { device } = s.devices.create("MacBook Air", "desktop");
    s.hands.saveHello(device.id, hello);
    s.hands.record({ id: "cmd_1", deviceId: device.id, episodeId: null, op: "screenshot", args: {}, decision: "allowed", decidedBy: "policy" }, 1000);
    s.hands.record({ id: "cmd_2", deviceId: device.id, episodeId: null, op: "open", args: { url: "https://x" }, decision: "refused", reason: "MacBook Air is offline" }, 2000);
    expect(s.hands.finish("cmd_1", { outcome: "ok", summary: "x".repeat(10_000), attachments: ["att_a"] }, 1500)).toBe(true);
    expect(s.hands.finish("cmd_1", { outcome: "timeout" }, 1600)).toBe(false);
    const [refused, done] = s.hands.commands(device.id);
    expect(refused).toMatchObject({ id: "cmd_2", decision: "refused", reason: "MacBook Air is offline", endedAt: 2000, outcome: null, args: { url: "https://x" } });
    expect(done).toMatchObject({ id: "cmd_1", decision: "allowed", decidedBy: "policy", outcome: "ok", endedAt: 1500, attachments: ["att_a"] });
    expect(done!.summary!.length).toBe(4096);
  });

  test("the first answer wins, allow for 10 min is a grant while it's fresh, and old records are pruned", () => {
    const s = fresh();
    const { device } = s.devices.create("MacBook Air", "desktop");
    const ask = (id: string, at: number) =>
      s.hands.requestApproval({ id, deviceId: device.id, capability: "shell", op: "shell", summary: "run `ls` on MacBook Air", commandId: `cmd_${id}`, episodeId: null, outboxId: null, expiresAt: at + 120_000 }, at);
    expect(ask("apr_1", 1000)).toMatchObject({ deviceName: "MacBook Air", state: "pending", answer: null });
    expect(s.hands.answerApproval("apr_1", { answer: "allow_10_min", by: "Telegram bridge", via: "telegram" }, 2000)).toMatchObject({ state: "allowed", answeredAt: 2000 });
    expect(s.hands.answerApproval("apr_1", { answer: "deny", by: "MacBook Air", via: "device" }, 2500)).toBeNull();
    expect(s.hands.grant(device.id, "shell", 600_000, 2000 + 599_999)?.id).toBe("apr_1");
    expect(s.hands.grant(device.id, "shell", 600_000, 2000 + 600_000)).toBeNull();
    expect(s.hands.grant(device.id, "input", 600_000, 3000)).toBeNull();
    ask("apr_2", 5000);
    expect(s.hands.closeApproval("apr_2", "expired", 125_000)).toMatchObject({ state: "expired" });
    expect(s.hands.pendingApprovals()).toEqual([]);
    s.hands.record({ id: "cmd_old", deviceId: device.id, episodeId: null, op: "shell", args: {}, decision: "refused", reason: "offline" }, 1000);
    s.hands.record({ id: "cmd_cut", deviceId: device.id, episodeId: null, op: "shell", args: {}, decision: "allowed" }, 1000);
    s.hands.record({ id: "cmd_new", deviceId: device.id, episodeId: null, op: "shell", args: {}, decision: "refused", reason: "offline" }, 200_000);
    expect(s.hands.prune(100_000)).toBe(3);
    expect(s.hands.commands(device.id).map((c) => c.id)).toEqual(["cmd_new"]);
    expect(s.hands.approval("apr_2")).toMatchObject({ state: "expired" });
  });
});

describe("inbound events", () => {
  test("one wakeup per subject per window, merged while it waits; ids dedup until pruned", () => {
    const s = fresh();
    const now = Date.UTC(2026, 9, 19, 12);
    const add = (extId: string, subject: string, at: number) => s.inbound.add({ source: "ruri", title: `${subject} idle`, extId, subject, windowMs: 120_000, tz: TZ }, at);
    const a = add("a", "umi", now);
    expect(a).toMatchObject({ status: "queued", dueAt: now });
    expect(add("b", "umi", now + 1_000)).toMatchObject({ status: "merged", wakeupId: a.wakeupId });
    expect(s.inbound.forWakeup(a.wakeupId).map((e) => e.ext_id)).toEqual(["a", "b"]);
    expect(s.schedule.get(a.wakeupId)).toMatchObject({ kind: "followup", created_by: "event:ruri", reason: 'ruri: 2 events, the latest "umi idle"' });
    s.schedule.claimDue(now + 2_000);
    const c = add("c", "umi", now + 3_000);
    expect(c).toMatchObject({ status: "queued", dueAt: now + 2_000 + 120_000 });
    expect(add("a", "umi", now + 4_000)).toEqual({ status: "duplicate", eventId: a.eventId, wakeupId: a.wakeupId });
    // Only events whose wakeup is over are forgotten.
    s.schedule.finish(a.wakeupId, true, TZ);
    expect(s.inbound.prune(now + 10 * DAY)).toBe(2);
    // Sent again after that, "a" is new: it joins the subject's wakeup still waiting.
    expect(add("a", "umi", now + 11 * DAY)).toMatchObject({ status: "merged", wakeupId: c.wakeupId });
    expect(s.inbound.forWakeup(c.wakeupId).map((e) => e.ext_id)).toEqual(["c", "a"]);
  });
});

describe("jobs", () => {
  const job = (s: Store, label = "render", now = 1_000) =>
    s.jobs.add({ label, command: "make", cwd: "/tmp", dir: `/tmp/jobs/${label}`, logPath: `/tmp/jobs/${label}/log`, timeoutMs: 60_000 }, now);

  test("the first ending counts, and wakes midna unless it stopped the job itself", () => {
    const s = fresh();
    const a = job(s, "a");
    expect(s.jobs.running().map((j) => j.id)).toEqual([a.id]);
    const ended = s.jobs.end(a.id, { status: "failed", exitCode: 2, tz: TZ }, 5_000)!;
    expect(ended).toMatchObject({ status: "failed", exit_code: 2, ended_at: 5_000 });
    // A stop racing the exit changes nothing.
    expect(s.jobs.end(a.id, { status: "stopped", tz: TZ })).toBeNull();
    const w = s.schedule.pending(10).find((w) => w.id === ended.wakeup_id)!;
    expect(w).toMatchObject({ kind: "followup", created_by: `job:${a.id}`, due_at: 5_000 });
    expect(s.jobs.forWakeup(w.id)!.id).toBe(a.id);

    const b = job(s, "b");
    expect(s.jobs.end(b.id, { status: "stopped", tz: TZ })!.wakeup_id).toBeNull();
    const c = job(s, "c");
    expect(s.jobs.end(c.id, { status: "failed", reason: "it couldn't start", quiet: true, tz: TZ })!.wakeup_id).toBeNull();
    expect(s.jobs.running()).toEqual([]);
    expect(s.jobs.recent(2).map((j) => j.label)).toEqual(["c", "b"]);
  });

  test("ended jobs are pruned with their folders named; running ones never", () => {
    const s = fresh();
    const old = job(s, "old");
    s.jobs.end(old.id, { status: "done", exitCode: 0, tz: TZ }, 2_000);
    const live = job(s, "live");
    expect(s.jobs.prune(3_000)).toEqual(["/tmp/jobs/old"]);
    expect(s.jobs.get(old.id)).toBeNull();
    expect(s.jobs.get(live.id)!.status).toBe("running");
  });

  test("a log's tail is its last lines, whole ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "midna-tail-"));
    try {
      const file = join(dir, "log");
      expect(logTail(file)).toBeNull();
      writeFileSync(file, "");
      expect(logTail(file)).toEqual({ text: "", cut: false });
      writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n");
      const t = logTail(file, 60, 40)!;
      expect(t.cut).toBe(true);
      expect(t.text.split("\n").at(-1)).toBe("line 99");
      expect(t.text.split("\n")[0]).toMatch(/^line \d+$/);
      expect(logTail(file, 100_000, 3)).toEqual({ text: "line 97\nline 98\nline 99", cut: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spend", () => {
  const ep = (s: Store, kind: "chat" | "wakeup", at: number, wakeupId?: number) => s.log.startEpisode({ kind, model: "claude:opus", ...(wakeupId ? { wakeupId } : {}) }, at);
  const row = (s: Store, id: number) =>
    s.db.query("SELECT cost_usd, session_cost_usd, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens FROM episodes WHERE id = $id").get({ id }) as Record<string, number | null>;

  test("a turn costs what its session's running total climbed since the session's last turn", () => {
    const s = fresh();
    const a = ep(s, "chat", 1_000);
    s.log.endEpisode(a, { session: "s1", sessionCostUsd: 0.5, tokens: { input: 3, cacheRead: 10_000, cacheWrite: 2_000, output: 40 } });
    const b = ep(s, "chat", 2_000);
    s.log.endEpisode(b, { session: "s1", sessionCostUsd: 0.8 });
    // Interrupted: no total, so the next turn's climb carries what it cost.
    const c = ep(s, "chat", 3_000);
    s.log.endEpisode(c, { session: "s1", error: "interrupted by a message from the user" });
    const d = ep(s, "chat", 4_000);
    s.log.endEpisode(d, { session: "s1", sessionCostUsd: 1.5 });
    // Another session's turns in between change nothing.
    const other = ep(s, "wakeup", 2_500);
    s.log.endEpisode(other, { session: "s2", sessionCostUsd: 0.25 });
    // A total that went down started counting afresh.
    const e = ep(s, "chat", 5_000);
    s.log.endEpisode(e, { session: "s1", sessionCostUsd: 0.1 });
    // No session to compare with: the total is the turn's.
    const f = ep(s, "wakeup", 6_000);
    s.log.endEpisode(f, { sessionCostUsd: 0.07 });

    expect(row(s, a)).toEqual({ cost_usd: 0.5, session_cost_usd: 0.5, input_tokens: 3, cache_read_tokens: 10_000, cache_write_tokens: 2_000, output_tokens: 40 });
    expect(row(s, b).cost_usd).toBeCloseTo(0.3);
    expect(row(s, c)).toMatchObject({ cost_usd: null, session_cost_usd: null, input_tokens: null });
    expect(row(s, d).cost_usd).toBeCloseTo(0.7);
    expect(row(s, other).cost_usd).toBe(0.25);
    expect(row(s, e).cost_usd).toBe(0.1);
    expect(row(s, f).cost_usd).toBe(0.07);
    expect(s.log.spend(0)).toBeCloseTo(0.5 + 0.3 + 0.7 + 0.25 + 0.1 + 0.07);
  });

  test("migration 10 turns the running totals already recorded into each turn's own cost", () => {
    const dir = mkdtempSync(join(tmpdir(), "midna-mig-"));
    try {
      const path = join(dir, "midna.db");
      const old = new Database(path, { create: true, strict: true });
      for (const [v, sql] of MIGRATIONS.slice(0, 9).entries()) {
        old.exec(sql);
        old.exec(`PRAGMA user_version = ${v + 1}`);
      }
      const add = old.query("INSERT INTO episodes (kind, model, brain_session, started_at, cost_usd) VALUES ($k, 'claude:opus', $s, $at, $c)");
      for (const [k, sess, at, c] of [
        ["chat", "s1", 1, 0.56],
        ["chat", "s1", 2, 0.68],
        ["wakeup", "w1", 3, 0.3],
        ["chat", "s1", 4, null],
        ["chat", "s1", 5, 2.92],
        ["chat", "s1", 6, 0.2],
        ["wakeup", null, 7, 0.4],
      ] as const) add.run({ k, s: sess, at, c });
      old.close();

      const s = Store.open(path);
      const costs = (s.db.query("SELECT cost_usd AS c, session_cost_usd AS t FROM episodes ORDER BY id").all() as Array<{ c: number | null; t: number | null }>).map((r) => [r.c === null ? null : Math.round(r.c * 100) / 100, r.t]);
      expect(costs).toEqual([
        [0.56, 0.56],
        [0.12, 0.68],
        [0.3, 0.3],
        [null, null],
        [2.24, 2.92],
        [0.2, 0.2],
        [0.4, 0.4],
      ]);
      expect((s.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("each local day's spend, today first, by what started each turn", () => {
    const s = fresh();
    const now = Date.parse("2026-10-22T20:00:00Z"); // 13:00 in Los Angeles
    const yesterday = now - DAY;
    const turn = (kind: "chat" | "wakeup", at: number, usd: number, wakeupId?: number) => s.log.endEpisode(ep(s, kind, at, wakeupId), { sessionCostUsd: usd });
    const w = (by: string, kind: "followup" | "ritual" = "followup") => s.schedule.add({ dueAt: now, reason: by, kind, createdBy: by, tz: TZ }).id;
    turn("chat", now - HOUR, 0.2);
    turn("chat", now - 2 * HOUR, 0.1);
    turn("wakeup", now - HOUR, 0.3, w("midna"));
    turn("wakeup", now - HOUR, 0.05, w("event:ruri"));
    turn("wakeup", now - HOUR, 0.04, w("job:7"));
    turn("wakeup", now - HOUR, 0.5, w("system", "ritual"));
    turn("wakeup", yesterday, 1, w("midna"));
    // Before local midnight, so yesterday's, though the same UTC date as today.
    turn("chat", Date.parse("2026-10-22T06:30:00Z"), 0.01);
    // Older than the days asked for.
    turn("chat", now - 9 * DAY, 9);

    const days = s.log.spendByDay(3, TZ, now);
    expect(days.map((d) => d.date)).toEqual(["2026-10-22", "2026-10-21", "2026-10-20"]);
    expect(days[0]).toEqual({
      date: "2026-10-22",
      usd: 1.19,
      turns: 6,
      byKind: { chat: { usd: 0.3, turns: 2 }, followup: { usd: 0.3, turns: 1 }, event: { usd: 0.05, turns: 1 }, job: { usd: 0.04, turns: 1 }, ritual: { usd: 0.5, turns: 1 } },
    });
    expect(days[1]).toEqual({ date: "2026-10-21", usd: 1.01, turns: 2, byKind: { followup: { usd: 1, turns: 1 }, chat: { usd: 0.01, turns: 1 } } });
    expect(days[2]).toEqual({ date: "2026-10-20", usd: 0, turns: 0, byKind: {} });
  });

  test("a turn that finished with no price is counted as unpriced, not as free", () => {
    const s = fresh();
    const now = Date.parse("2026-10-22T20:00:00Z");
    s.log.endEpisode(ep(s, "chat", now - HOUR), { sessionCostUsd: 0.2 });
    // Codex on a ChatGPT plan: tokens, no price.
    s.log.endEpisode(ep(s, "chat", now - HOUR), { tokens: { input: 900, cacheRead: 0, cacheWrite: 0, output: 40 } });
    // Cut off: no price because it failed, not because the plan has none.
    s.log.endEpisode(ep(s, "chat", now - HOUR), { error: "interrupted by a message from the user" });
    // Still running.
    ep(s, "chat", now - HOUR);
    const [today] = s.log.spendByDay(1, TZ, now);
    expect(today).toMatchObject({ usd: 0.2, turns: 4, unpriced: 1 });
  });
});

describe("wakeup guardrails", () => {
  const MIN = 60_000;
  test("due follow-ups run as one turn, taking along those due within minutes; rituals and reminders run alone", () => {
    const s = fresh();
    const now = 10 * DAY;
    const add = (reason: string, dueAt: number, kind: "followup" | "ritual" | "reminder" = "followup", createdBy = "midna") => s.schedule.add({ dueAt, reason, kind, createdBy, tz: TZ }).id;
    const a = add("check mira", now - MIN);
    const b = add("ruri: cobalt is idle", now, "followup", "event:ruri");
    const c = add("look at the build", now + 4 * MIN);
    const late = add("much later", now + 6 * MIN);
    const ritual = add("morning brief", now - MIN, "ritual", "system");
    const reminder = add("drink water", now, "reminder");
    const turns = s.schedule.claimTurns(now, 5 * MIN, 8).map((t) => t.map((w) => w.id));
    expect(turns).toEqual([[ritual], [reminder], [a, b, c]]);
    expect(s.schedule.get(c)).toMatchObject({ status: "running", fired_at: now });
    expect(s.schedule.get(late)!.status).toBe("pending");
    // Nothing due: nothing is taken early.
    expect(s.schedule.claimTurns(now + MIN, 5 * MIN, 8)).toEqual([]);
    expect(s.schedule.get(late)!.status).toBe("pending");
  });

  test("at most `max` to a turn: the last turn alone takes along what's due soon, as far as it has room", () => {
    const s = fresh();
    const now = 10 * DAY;
    const ids = [0, 1, 2, 3, 4].map((i) => s.schedule.add({ dueAt: now - 5 + i, reason: `due ${i}`, tz: TZ }).id);
    const soon = [1, 2].map((i) => s.schedule.add({ dueAt: now + i * 60_000, reason: `soon ${i}`, tz: TZ }).id);
    const turns = s.schedule.claimTurns(now, 5 * 60_000, 3).map((t) => t.map((w) => w.id));
    expect(turns).toEqual([[ids[0]!, ids[1]!, ids[2]!], [ids[3]!, ids[4]!, soon[0]!]]);
    expect(s.schedule.get(soon[1]!)!.status).toBe("pending");
    s.schedule.joined(ids[3]!, [ids[4]!, soon[0]!]);
    expect(s.schedule.get(soon[0]!)!.joined_to).toBe(ids[3]!);
  });

  test("a follow-up that says nearly what a pending one says, around the same time, is its twin", () => {
    const s = fresh();
    const now = 10 * DAY;
    const w = s.schedule.add({ dueAt: now, reason: "Check whether the mira Lead finished the TLS fix and tell Justin.", tz: TZ });
    const daily = s.schedule.add({ cron: "30 8 * * *", reason: "Daily 8:30 digest for Justin", tz: TZ }, now);
    expect(s.schedule.twin("check whether the mira lead finished the TLS fix, and tell Justin", { dueAt: now + 30 * 60_000 })!.id).toBe(w.id);
    // Too far apart in time, or saying something else: not a twin.
    expect(s.schedule.twin("Check whether the mira Lead finished the TLS fix and tell Justin.", { dueAt: now + 3 * 60 * 60_000 })).toBeNull();
    expect(s.schedule.twin("Check whether the cobalt Lead finished the deploy and tell Justin.", { dueAt: now })).toBeNull();
    // A recurring one is matched against recurring ones, whenever they're due.
    expect(s.schedule.twin("daily 8:30 digest for Justin", { cron: "30 8 * * 1-5" })!.id).toBe(daily.id);
    expect(nearlySame("ruri: mira is idle", "ruri: cobalt is idle")).toBe(false);
  });

  test("today's wakeup turns and their cost, from local midnight", () => {
    const s = fresh();
    const now = Date.parse("2026-10-22T20:00:00Z");
    for (const [kind, at, usd] of [["wakeup", now - 60_000, 0.3], ["wakeup", now - 2 * 60_000, 0.2], ["chat", now, 1], ["wakeup", now - DAY, 5]] as const) {
      s.log.endEpisode(s.log.startEpisode({ kind, model: "claude:opus" }, at), { sessionCostUsd: usd });
    }
    expect(s.log.wakeupsToday(TZ, now)).toEqual({ turns: 2, usd: 0.5 });
    // a wakeupBudget stored by 0.11.0/0.11.1 is neither read nor reported
    s.db.query("INSERT INTO settings (key, value) VALUES ('wakeupBudget', '{\"turns\":1,\"usd\":1}')").run();
    expect(s.settings()).not.toHaveProperty("wakeupBudget");
  });
});
