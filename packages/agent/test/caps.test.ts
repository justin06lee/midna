import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN, Store } from "@midna/core";
import { Assistant } from "../src/assistant.ts";
import { BrainCappedError, BrainError, type Brain, type BrainRun } from "../src/brain.ts";
import { brainProblem } from "../src/check.ts";

const HOUR = 3_600_000;
let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "midna-caps-"));
  store = Store.open(join(dir, "midna.db"));
  store.updateSettings({ timezone: "UTC" });
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A brain whose provider is capped while `capped` says so: it records every run. */
function brainFor(capped: (run: BrainRun) => BrainCappedError | null) {
  const runs: BrainRun[] = [];
  const brain: Brain = async (run) => {
    runs.push(run);
    const cap = capped(run);
    if (cap) throw cap;
    return { text: "done" };
  };
  return { runs, brain };
}

const assistant = (brain: Brain) => new Assistant({ store, brain, env: { hostName: "jetson", platform: "linux", workspace: dir, home: dir }, mcp: { url: () => "http://127.0.0.1:1/mcp", token: "t" }, coalesceMs: 1 });
const said = (client?: string) =>
  (store.db.query("SELECT text, client, conversation_id AS conv FROM messages WHERE role = 'midna' ORDER BY id").all() as Array<{ text: string; client: string; conv: string }>).filter((m) => !client || m.client === client);
const followups = () => store.schedule.pending().filter((w) => w.kind === "followup");

describe("a brain at its usage limit", () => {
  test("a wakeup waits for the reset instead of failing, and the user hears once", async () => {
    const until = Date.now() + 2 * HOUR;
    const { brain, runs } = brainFor(() => new BrainCappedError("claude", until));
    const a = assistant(brain);
    const w = store.schedule.get(store.schedule.add({ dueAt: Date.now(), reason: "check the build", kind: "followup", createdBy: "test", tz: "UTC" }).id)!;
    expect(await a.wakeup(w)).toEqual({ retryAt: until });
    expect(a.brainHealth).toMatchObject({ ok: false, reason: "capped", until });
    // Held: the next one doesn't run the brain at all.
    expect(await a.wakeup(w)).toEqual({ retryAt: until });
    expect(runs.length).toBe(1);
    expect(said("system").map((m) => m.text)).toEqual([expect.stringMatching(/^Claude's usage limit is reached until (?:\w{3} )?\d+:\d\d [ap]m; I'll pick up what's waiting then\.$/)]);
  });

  test("a cap that doesn't say when holds a while, not forever", async () => {
    const { brain } = brainFor(() => new BrainCappedError("claude", undefined));
    const a = assistant(brain);
    const w = store.schedule.get(store.schedule.add({ dueAt: Date.now(), reason: "x", kind: "followup", createdBy: "test", tz: "UTC" }).id)!;
    const r = (await a.wakeup(w)) as { retryAt: number };
    expect(r.retryAt - Date.now()).toBeGreaterThan(10 * 60_000);
    expect(r.retryAt - Date.now()).toBeLessThan(20 * 60_000);
  });

  test("a chat message gets told when, is marked seen, and comes back as a followup", async () => {
    const until = Date.now() + HOUR;
    const { brain } = brainFor(() => new BrainCappedError("claude", until));
    const a = assistant(brain);
    a.receive({ text: "what's on today?", client: "test" });
    await a.idle();
    const replies = said().filter((m) => m.conv === MAIN);
    expect(replies.map((m) => m.text)).toEqual([expect.stringMatching(/^Claude's usage limit is reached until .+\. I'll answer you then\.$/)]);
    expect(store.log.unseen(MAIN).filter((m) => m.role === "user")).toEqual([]);
    const f = followups();
    expect(f.length).toBe(1);
    expect(f[0]!.due_at).toBe(until + 60_000);
    expect(f[0]!.reason).toContain("what's on today?");
  });

  test("with a fallback, the same turn runs again on it at once; back on the model after the reset", async () => {
    store.updateSettings({ model: "claude:opus", fallback: ["codex:gpt-5.5"] });
    let until = Date.now() + HOUR;
    const { brain, runs } = brainFor((run) => (run.model.startsWith("claude") && Date.now() < until ? new BrainCappedError("claude", until, "s1", 2) : null));
    const a = assistant(brain);
    a.receive({ text: "send me the report", client: "test" });
    await a.idle();
    expect(runs.map((r) => r.model)).toEqual(["claude:opus", "codex:gpt-5.5"]);
    expect(runs[1]!.resume).toBeUndefined();
    expect(runs[1]!.prompt).toContain("hit its usage limit partway through this turn, after 2 tool calls");
    expect(said("chat").map((m) => m.text)).toEqual(["done"]);
    expect(said("system").map((m) => m.text)).toEqual([expect.stringMatching(/^Claude's usage limit is reached until .+; I'm thinking with codex:gpt-5\.5 till then\.$/)]);
    const episodes = store.db.query("SELECT model, error FROM episodes ORDER BY id").all() as Array<{ model: string; error: string | null }>;
    expect(episodes.map((e) => e.model)).toEqual(["claude:opus", "codex:gpt-5.5"]);
    expect(a.activeModel()).toBe("codex:gpt-5.5");

    // Another message while capped goes straight to the fallback, and says nothing new.
    a.receive({ text: "and the slides", client: "test" });
    await a.idle();
    expect(runs.at(-1)!.model).toBe("codex:gpt-5.5");
    expect(said("system").length).toBe(1);

    // The reset passes: the model thinks again, in a fresh session.
    until = Date.now() - 1;
    store.setState("brainCaps", { claude: until });
    expect(a.activeModel()).toBe("claude:opus");
    a.receive({ text: "thanks", client: "test" });
    await a.idle();
    expect(runs.at(-1)!.model).toBe("claude:opus");
    expect(runs.at(-1)!.resume).toBeUndefined();
  });

  test("a wakeup carries on with the fallback too", async () => {
    store.updateSettings({ fallback: ["codex"] });
    const { brain, runs } = brainFor((run) => (run.model === "claude:opus" ? new BrainCappedError("claude", Date.now() + HOUR) : null));
    const a = assistant(brain);
    const w = store.schedule.get(store.schedule.add({ dueAt: Date.now(), reason: "x", kind: "followup", createdBy: "test", tz: "UTC" }).id)!;
    expect(await a.wakeup(w)).toBe("done");
    expect(runs.map((r) => r.model)).toEqual(["claude:opus", "codex"]);
    // No tools ran before the cap: nothing to warn the fallback about.
    expect(runs[1]!.prompt).not.toContain("usage limit");
  });

  test("every model capped: a chat names them and waits for the first reset", async () => {
    store.updateSettings({ fallback: ["codex"] });
    const soon = Date.now() + HOUR;
    const { brain } = brainFor((run) => new BrainCappedError(run.model === "codex" ? "codex" : "claude", run.model === "codex" ? soon : soon + HOUR));
    const a = assistant(brain);
    a.receive({ text: "hi", client: "test" });
    await a.idle();
    expect(said("error").map((m) => m.text)).toEqual([expect.stringMatching(/^Codex and Claude are both at their usage limits; the first resets at .+\. I'll answer you then\.$/)]);
    expect(followups()[0]!.due_at).toBe(soon + 60_000);
  });

  test("other brain failures are not caps", async () => {
    const a = assistant(async () => {
      throw new BrainError("claude turn failed: something broke");
    });
    const w = store.schedule.get(store.schedule.add({ dueAt: Date.now(), reason: "x", kind: "followup", createdBy: "test", tz: "UTC" }).id)!;
    expect(await a.wakeup(w)).toBe("failed");
    expect(a.activeModel()).toBe("claude:opus");
  });
});

describe("brainProblem on a cap", () => {
  test("the error, and its message as a wakeup keeps it", () => {
    const until = Date.parse("2026-10-26T23:00:00.000Z");
    const err = new BrainCappedError("claude", until);
    expect(brainProblem(err)).toEqual({ reason: "capped", provider: "claude", until });
    expect(brainProblem(new Error(err.message))).toEqual({ reason: "capped", provider: "claude", until });
    expect(brainProblem(new Error("codex usage limit reached"))).toEqual({ reason: "capped", provider: "codex" });
  });
  test("a cap stored before midna knew one", () => {
    expect(brainProblem(new Error("claude turn failed: Claude AI usage limit reached|1761519600"))).toEqual({ reason: "capped", provider: "claude" });
    expect(brainProblem(new Error("claude turn failed: something else"))).toBeNull();
  });
});
