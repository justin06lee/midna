import { describe, expect, test } from "bun:test";
import { stateNote, systemPrompt } from "../src/prompt.ts";

const env = { hostName: "jetson", platform: "linux", workspace: "/w", home: "/h" };
const settings = { name: "midna", mode: "autonomous", timezone: "UTC" } as Parameters<typeof systemPrompt>[0];
const clock = "## Now\n2026-10-22 Thu 21:00 (UTC)";

describe("stateNote", () => {
  const sections = [
    { title: "Open tasks", body: "- #1 P2 Renew the passport → NO GOAL" },
    { title: "Your own scheduled wakeups, next 24 hours", body: "" },
    { title: "The user's computers", body: "- MacBook Air: online; screen" },
  ];

  test("a new session hears the clock and every section with something in it", () => {
    expect(stateNote(clock, sections)).toBe(
      `[midna] The current state, from your database; it replaces any state given earlier. Use the tools for anything not shown.\n\n${clock}\n\n## Open tasks\n- #1 P2 Renew the passport → NO GOAL\n\n## The user's computers\n- MacBook Air: online; screen`,
    );
  });

  test("a session carrying on hears only what changed, and a section that emptied says so", () => {
    const before = new Map([
      ["Open tasks", "- #1 P2 Renew the passport → NO GOAL"],
      ["Your own scheduled wakeups, next 24 hours", ""],
      ["The user's computers", "- MacBook Air: offline; screen"],
    ]);
    const now = [{ ...sections[0]!, body: "" }, { ...sections[1]! }, sections[2]!];
    expect(stateNote(clock, now, before)).toBe(
      `[midna] The current state: the sections that changed since your last turn in this session. The others are as they were then.\n\n${clock}\n\n## Open tasks\n(none now)\n\n## The user's computers\n- MacBook Air: online; screen`,
    );
    expect(stateNote(clock, sections, new Map(sections.map((x) => [x.title, x.body])))).toBe(
      `[midna] The current state: as it was at your last turn in this session, apart from the time.\n\n${clock}`,
    );
  });
});

describe("systemPrompt", () => {
  test("holds nothing that changes turn by turn", () => {
    const a = systemPrompt(settings, env, { pinned: "- #3 (identity) Allergic to penicillin", hands: true });
    expect(a).toBe(systemPrompt(settings, env, { pinned: "- #3 (identity) Allergic to penicillin", hands: true }));
    expect(a).toContain("# Pinned memories\nWhat you pinned because it must never fade:\n- #3 (identity) Allergic to penicillin\n\n# Current state\n");
    expect(a).toContain("# The user's computers\n");
    expect(a.endsWith("Use the tools for anything not shown.")).toBe(true);
    const bare = systemPrompt(settings, env);
    expect(bare).not.toContain("# Pinned memories");
    expect(bare).not.toContain("# The user's computers");
  });
});
