import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@justin06lee/yagami";
import { QUEUE_PREFIX, saysStop } from "../src/assistant.ts";
import { Inbox, Steering, sendTagged, toolDetail } from "../src/brain.ts";
import { systemPrompt } from "../src/prompt.ts";

describe("QUEUE_PREFIX", () => {
  test("/queue, as typed or picked from a bot's command menu", () => {
    for (const t of ["/queue then the slides", "/QUEUE then", "/queue@midna_bot then", "/queue"]) expect(QUEUE_PREFIX.test(t)).toBe(true);
    expect("/queue@midna_bot  then the slides".replace(QUEUE_PREFIX, "")).toBe("then the slides");
  });
  test("anything else doesn't wait", () => {
    for (const t of ["queue this", "/queued", "/queueing it", "please /queue it", " /queue it"]) expect(QUEUE_PREFIX.test(t)).toBe(false);
  });
});

describe("toolDetail", () => {
  test("a few words on what a tool call is doing", () => {
    expect(toolDetail({ command: "npm run build", description: "Build the deck" })).toBe("Build the deck");
    expect(toolDetail({ file_path: "/home/midna/notes.md" })).toBe("/home/midna/notes.md");
    expect(toolDetail({ command: "a\n  b" })).toBe("a b");
    expect(toolDetail({ command: "x".repeat(300) })!.length).toBe(100);
    expect(toolDetail({ limit: 3 })).toBeUndefined();
    expect(toolDetail(null)).toBeUndefined();
  });
});

describe("saysStop", () => {
  test("a message that says to stop, cancel or hold on", () => {
    for (const t of [
      "stop", "Stop!", "STOP", "stop it", "stop that", "stop everything", "stop what you're doing", "stop what you’re doing",
      "stop — the meeting moved to Friday", "no stop", "please stop", "ok stop, do the other one", "cancel", "cancel that", "Cancel that, wrong file",
      "abort", "kill it", "hold on", "Hold on, what about the budget?", "hold up", "hang on a sec", "wait", "wait!", "wait, use the other account",
      "wait wait", "never mind", "nevermind", "nvm", "scratch that", "forget it", "/stop", "/stop@midna_bot", "/STOP and do this instead",
    ]) expect(saysStop(t)).toBe(true);
  });
  test("a request that only starts with the word reaches the turn", () => {
    for (const t of [
      "cancel my 3pm meeting", "cancel the subscription", "stop by the store tomorrow", "stop the build", "wait until tomorrow to send it",
      "waiting on you", "don't stop", "the meeting got cancelled", "what's the weather", "add the Q3 numbers too", "/stopwatch", "please /stop", "holdings report",
    ]) expect(saysStop(t)).toBe(false);
  });
});

describe("Inbox", () => {
  test("takes messages only while the brain has it open, and keeps what the model saw", () => {
    const inbox = new Inbox();
    expect(inbox.give({ id: 1, text: "early" })).toBe(false);
    const got: number[] = [];
    inbox.open((m) => got.push(m.id));
    expect(inbox.give({ id: 2, text: "now" })).toBe(true);
    inbox.saw(2);
    inbox.close();
    expect(inbox.give({ id: 3, text: "late" })).toBe(false);
    expect(got).toEqual([2]);
    expect(inbox.seen).toEqual([2]);
  });
});

describe("Steering", () => {
  test("a message folded into the turn is seen by its result", () => {
    const inbox = new Inbox();
    const s = new Steering(inbox);
    s.given("u-2", 2);
    expect(s.result(["u-1", "u-2"])).toBe(false);
    expect(inbox.seen).toEqual([2]);
  });
  test("one sent too late to fold in waits for the turn after, which takes it", () => {
    const inbox = new Inbox();
    const s = new Steering(inbox);
    s.given("u-2", 2);
    s.given("u-3", 3);
    expect(s.result(["u-1", "u-2"])).toBe(true);
    expect(inbox.seen).toEqual([2]);
    expect(s.result(["u-3"])).toBe(false);
    expect(inbox.seen).toEqual([2, 3]);
    expect(s.tracked).toBe(true);
  });
  test("a Claude Code that doesn't say what a turn took leaves the messages unseen", () => {
    const inbox = new Inbox();
    const s = new Steering(inbox);
    s.given("u-2", 2);
    expect(s.result(undefined)).toBe(true);
    expect(s.tracked).toBe(false);
    expect(inbox.seen).toEqual([]);
  });
});

describe("sendTagged", () => {
  test("writes a user message with its uuid to the session's input", () => {
    const pushed: unknown[] = [];
    const session = { sessionId: "s-1", input: { push: (m: unknown) => pushed.push(m) } } as unknown as AgentSession;
    expect(sendTagged(session, "hello", "u-1")).toBe(true);
    expect(pushed).toEqual([{ type: "user", message: { role: "user", content: "hello" }, parent_tool_use_id: null, session_id: "s-1", uuid: "u-1" }]);
  });
  test("sends nothing when the session has no input queue to write to", () => {
    expect(sendTagged({} as unknown as AgentSession, "hello", "u-1")).toBe(false);
  });
});

describe("the system prompt on the user's messages mid-turn", () => {
  const settings = { name: "midna", mode: "autonomous", timezone: "UTC" } as Parameters<typeof systemPrompt>[0];
  const env = { hostName: "tenet", platform: "linux", workspace: "/w", home: "/h" };
  test("a brain that takes them mid-turn hears it isn't stopped, and how to answer", () => {
    const p = systemPrompt(settings, env, { midTurn: true });
    expect(p).toContain("When the user writes while you're working on a chat turn, nothing is stopped");
    expect(p).toContain("acknowledge it in one line with message_user");
    expect(p).toContain("/stop");
    expect(p).not.toContain("A new message from the user interrupts your chat turn");
  });
  test("one that can't hears it is interrupted for them", () => {
    const p = systemPrompt(settings, env, { midTurn: false });
    expect(p).toContain("A new message from the user interrupts your chat turn");
    expect(p).not.toContain("nothing is stopped");
  });
});
