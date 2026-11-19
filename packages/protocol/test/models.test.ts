import { describe, expect, test } from "bun:test";
import { accountChoices, capTime, modelGroups, modelName, modelRef, parseModel, thinkingWith, type BrainInfo, type BrainModel } from "../src/index.ts";

const brain = (id: string, installed = true): BrainInfo => ({ id, label: `${id} CLI`, installed, loginCommand: "", installHint: "" });
const BRAINS = [brain("claude"), brain("codex"), brain("opencode"), brain("gemini", false), brain("hermes")];
const CLAUDE: BrainModel[] = [
  { id: "opus", name: "Opus 5.5", description: "For complex work" },
  { id: "claude-fable-5-2", name: "Fable 5.2" },
  { id: "sonnet", name: "Sonnet 5.5" },
  { id: "haiku", name: "Haiku 5.5" },
  { id: "fable", name: "Fable 5.1" },
  { id: "claude-opus-4-8", name: "Opus 4.8" },
];
const ZEN: BrainModel[] = [
  { id: "ollama/bonsai-2:27b", name: "ollama/bonsai-2:27b" },
  { id: "opencode/big-pickle", name: "opencode/Big Pickle" },
  { id: "opencode/deepseek-v4.1-flash-free", name: "opencode/DeepSeek V4.1 Flash Free" },
  { id: "opencode/tidepool-alpha-free", name: "opencode/Tidepool Alpha Free", default: true },
  { id: "opencode/iceman-free", name: "opencode/Iceman Free" },
  { id: "opencode/beam-free", name: "opencode/Beam Free" },
];
const ids = BRAINS.map((b) => b.id);

describe("model refs", () => {
  test("a bare word is a provider when one has that id, else one of Claude's models", () => {
    expect(parseModel("opus", ids)).toEqual({ provider: "claude", model: "opus" });
    expect(parseModel("codex", ids)).toEqual({ provider: "codex", model: null });
    expect(parseModel("codex", [])).toEqual({ provider: "codex", model: null });
    expect(parseModel("opencode:opencode/deepseek-v4.1-flash-free", ids)).toEqual({ provider: "opencode", model: "opencode/deepseek-v4.1-flash-free" });
    expect(parseModel("ollama:qwen3:8b", ids)).toEqual({ provider: "ollama", model: "qwen3:8b" });
    expect(modelRef(parseModel("opus", ids))).toBe("claude:opus");
    expect(modelRef(parseModel("hermes", ids))).toBe("hermes");
  });

  test("a model is named by the host's list, else by its id", () => {
    expect(modelName("claude:opus", BRAINS, { claude: CLAUDE })).toBe("Opus 5.5");
    expect(modelName("claude:opus", BRAINS)).toBe("Opus");
    expect(modelName("claude:claude-fable-5-2")).toBe("Fable 5.2");
    expect(modelName("claude:claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelName("opencode:opencode/deepseek-v4.1-flash-free", BRAINS, { opencode: ZEN })).toBe("DeepSeek V4.1 Flash Free");
    expect(modelName("opencode:opencode/deepseek-v4.1-flash-free", BRAINS)).toBe("Deepseek V4.1 Flash Free");
    expect(modelName("codex", BRAINS)).toBe("Codex");
    expect(modelName("codex:gpt-5.6-sol", BRAINS)).toBe("Gpt 5.6 Sol");
  });
});

describe("what a picker lists", () => {
  const status = { model: "claude:opus", fallback: ["opencode:opencode/deepseek-v4.1-flash-free"] };

  test("with nothing from the host but its brains: Claude's aliases, each other brain's default and the fallback", () => {
    const groups = modelGroups(status, BRAINS);
    expect(groups.map((g) => g.provider)).toEqual(["claude", "codex", "opencode", "hermes"]);
    expect(groups[0]!.choices.map((c) => [c.ref, c.name, c.selected])).toEqual([
      ["claude:opus", "Opus", true],
      ["claude:fable", "Fable", false],
      ["claude:sonnet", "Sonnet", false],
      ["claude:haiku", "Haiku", false],
    ]);
    expect(groups[1]!.choices.map((c) => [c.ref, c.name])).toEqual([["codex", "Default"]]);
    expect(groups[2]!.choices.map((c) => [c.ref, c.name, c.note])).toEqual([
      ["opencode:opencode/deepseek-v4.1-flash-free", "Deepseek V4.1 Flash Free", "Zen"],
      ["opencode", "Default", undefined],
    ]);
    expect(groups[3]!.choices.map((c) => c.name)).toEqual(["Hermes"]);
    expect(groups.every((g) => g.more.length === 0)).toBe(true);
  });

  test("with the host's lists: its names, the aliases first, and the rest behind More", () => {
    const groups = modelGroups(status, BRAINS, { claude: CLAUDE, opencode: ZEN });
    expect(groups[0]!.choices.map((c) => c.name)).toEqual(["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
    expect(groups[0]!.choices[0]!.note).toBe("For complex work");
    expect(groups[0]!.more.map((c) => c.ref)).toEqual(["claude:claude-fable-5-2", "claude:claude-opus-4-8"]);
    expect(groups[2]!.choices.map((c) => c.name)).toEqual(["DeepSeek V4.1 Flash Free", "Default"]);
    expect(groups[2]!.more.map((c) => [c.name, c.note])).toContainEqual(["bonsai-2:27b", "Ollama"]);
    expect(groups[2]!.more).toHaveLength(5);
  });

  test("a short list shows whole, and a model that is set but isn't an alias is listed and marked", () => {
    const groups = modelGroups({ model: "claude-fable-5-2", fallback: [] }, BRAINS, { claude: CLAUDE.slice(0, 5), opencode: ZEN.slice(0, 3) });
    expect(groups[0]!.choices.find((c) => c.selected)?.name).toBe("Fable 5.2");
    expect(groups[0]!.more).toEqual([]);
    expect(groups[2]!.choices.map((c) => c.ref)).toEqual(["opencode", "opencode:ollama/bonsai-2:27b", "opencode:opencode/big-pickle", "opencode:opencode/deepseek-v4.1-flash-free"]);
  });

  test("a brain that isn't installed is listed only while it is the one set", () => {
    expect(modelGroups({ model: "gemini", fallback: [] }, BRAINS).map((g) => g.provider)).toContain("gemini");
  });
});

describe("accounts and what is thinking", () => {
  const now = new Date(2026, 10, 20, 9, 0).getTime();
  const later = new Date(2026, 10, 21, 1, 0).getTime();

  test("the two accounts: who each is signed in as, or when its usage is back", () => {
    const a = accountChoices({ account: "personal", accounts: { work: "w@example.com", personal: null }, caps: { "claude@work": later } }, now);
    expect(a.map((x) => [x.account, x.selected, x.signedIn])).toEqual([["personal", true, false], ["work", false, true]]);
    expect(a[0]!.note).toBe("Not signed in");
    expect(a[1]!.note).toBe(`Out of usage until ${capTime(later, now)}`);
    expect(accountChoices({})).toEqual([]);
  });

  test("a cap that has passed is not a cap", () => {
    expect(accountChoices({ account: "work", accounts: { work: "w@example.com", personal: null }, caps: { "claude@work": now - 1 } }, now)[1]!.note).toBe("w@example.com");
  });

  test("the set model thinking says only its name; a stand-in says what it stands in for", () => {
    expect(thinkingWith({ model: "claude:opus", activeModel: "claude:opus", account: "personal", activeAccount: "personal" }, BRAINS, { claude: CLAUDE })).toEqual({ name: "Opus 5.5", account: "personal" });
    const t = thinkingWith({ model: "claude:opus", activeModel: "opencode:opencode/deepseek-v4.1-flash-free", account: "work", caps: { "claude@work": later } }, BRAINS, { claude: CLAUDE, opencode: ZEN }, now);
    expect(t.name).toBe("DeepSeek V4.1 Flash Free");
    expect(t.standIn).toBe(`Opus 5.5 on work is out of usage until ${capTime(later, now)}`);
    expect(thinkingWith({ model: "claude:opus" }, BRAINS).name).toBe("Opus");
  });

  test("a cap ending today says the time, another day says the day too", () => {
    expect(capTime(new Date(2026, 10, 20, 16, 0).getTime(), now, "en-US")).toBe("4:00 PM");
    expect(capTime(later, now, "en-US")).toBe("Sat 1:00 AM");
  });
});
