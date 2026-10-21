import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN } from "@midna/core";
import { MidnaClient, MidnaError, type StreamEvent } from "@midna/protocol";
import type { Brain, BrainRun } from "@midna/agent";
import { startDaemon, type RunningDaemon } from "../src/index.ts";

/**
 * Native replies (Telegram's "reply"): the user's message names an earlier
 * line — by its message id, or one of midna's by its outbox id, or, for a
 * line the client can't name, what it knew of it — and midna's turn reads
 * which line that was before the user's words.
 */

let home: string;
let daemon: RunningDaemon;
let client: MidnaClient;
const runs: BrainRun[] = [];
const events: StreamEvent[] = [];
const abort = new AbortController();
const brain: Brain = async (run) => {
  runs.push(run);
  return { text: "ok", sessionId: `s-${runs.length}`, costUsd: 0 };
};

async function until<T>(what: string, fn: () => T | undefined | null | false, ms = 5_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** The line of a turn's prompt that carries the user's message `text`. */
const lineOf = async (text: string) => {
  const run = await until(`a turn with "${text}"`, () => runs.find((r) => r.prompt.split("\n").some((l) => l.endsWith(`: ${text}`) || l.endsWith(` ${text}`))));
  return run.prompt.split("\n").find((l) => l.includes("User:") && l.endsWith(text))!;
};
const historyOf = async (messageId: number) => (await client.history({ limit: 200 })).find((h) => h.id === messageId)!;
const say = (text: string, more: { options?: string[]; attachments?: string[] } = {}) =>
  daemon.store.say({ kind: more.options ? "question" : "notification", text, priority: "normal", conversationId: MAIN, ...more }, { client: "test", seenByBrain: true });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "midna-replies-"));
  daemon = await startDaemon({ home, port: 17000 + Math.floor(Math.random() * 20000), brain, tickMs: 50, introDelayMs: -1, coalesceMs: 50 });
  daemon.store.updateSettings({ quietHours: null });
  client = new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim());
  void (async () => {
    try {
      for await (const e of client.events(0, abort.signal)) events.push(e);
    } catch {
      /* aborted */
    }
  })();
});

afterAll(async () => {
  abort.abort();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("native replies", () => {
  test("to midna's question by its outbox id, with the part the user highlighted", async () => {
    const q = say("Tea or coffee this afternoon?", { options: ["Tea", "Coffee"] });
    const sent = await client.send({ text: "this one", client: "telegram", inReplyTo: { outboxId: q.id, quote: "Tea" } });
    expect(sent.conversationId).toBe(MAIN);
    expect(sent.messageId).toBeNumber();
    expect(await lineOf("this one")).toMatch(/User: \[Replying to your message from .+?, the part: "Tea" — you asked this, with options Tea \/ Coffee\] this one$/);
    const asked = (await client.history({ limit: 200 })).find((h) => h.outbox?.id === q.id)!;
    expect((await historyOf(sent.messageId!)).inReplyTo).toEqual({ messageId: asked.id, quote: "Tea", fallback: null });
    const event = await until("the user_message event", () => events.find((e) => e.type === "user_message" && e.id === sent.messageId));
    expect(event).toMatchObject({ inReplyTo: { messageId: asked.id, quote: "Tea", fallback: null } });
  });

  test("to one of midna's lines with files, and to the user's own line by its message id", async () => {
    const png = daemon.store.attachments.add({ data: new Uint8Array([137, 80, 78, 71]), name: "week.png" });
    const note = say("Here's the week.", { attachments: [png.id] });
    await client.send({ text: "looks good", client: "telegram", inReplyTo: { outboxId: note.id } });
    expect(await lineOf("looks good")).toMatch(/\[Replying to your message from .+?: "Here's the week\." — with week\.png\] looks good$/);
    const first = await client.send({ text: "remember the dentist", client: "telegram" });
    await client.send({ text: "on Friday, I mean", client: "telegram", inReplyTo: { messageId: first.messageId! } });
    expect(await lineOf("on Friday, I mean")).toMatch(/\[Replying to their own message from .+?: "remember the dentist"\] on Friday, I mean$/);
  });

  test("a line the client can't name comes from its fallback; with no fallback the message stands alone", async () => {
    const at = Date.now() - 3_600_000;
    const fb = { from: "midna" as const, at, text: "an old line", files: ["plan.pdf"] };
    const sent = await client.send({ text: "about that", client: "telegram", inReplyTo: { messageId: 999_999, fallback: fb } });
    expect(await lineOf("about that")).toMatch(/\[Replying to your message from .+?: "an old line" — with plan\.pdf\] about that$/);
    expect((await historyOf(sent.messageId!)).inReplyTo).toEqual({ messageId: null, quote: null, fallback: fb });

    const alone = await client.send({ text: "hm", client: "telegram", inReplyTo: { outboxId: 999_999 } });
    expect((await historyOf(alone.messageId!)).inReplyTo).toBeNull();
    expect(await lineOf("hm")).toMatch(/User: hm$/);
  });

  test("answering a question it also replies to says it once; a reply that names nothing is refused", async () => {
    const q = say("Walk at six?", { options: ["Yes", "No"] });
    await client.send({ text: "Yes", client: "telegram", replyTo: q.id, inReplyTo: { outboxId: q.id } });
    const line = await lineOf("Yes");
    expect(line).toMatch(/User: \(answering your question: "Walk at six\?"\) Yes$/);
    expect(line).not.toContain("[Replying");
    await expect(client.send({ text: "x", client: "telegram", inReplyTo: {} })).rejects.toBeInstanceOf(MidnaError);
  });
});
