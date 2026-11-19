import { describe, expect, test } from "bun:test";
import { accountChoices, capTime, modelGroups, modelName, modelRef, parseModel, providersInUse, thinkingWith, type BrainInfo, type BrainModel } from "../src/index.ts";

const brain = (id: string, installed = true): BrainInfo => ({ id, label: `${id} CLI`, installed, loginCommand: "", installHint: "" });
const BRAINS = [brain("claude"), brain("codex"), brain("opencode"), brain("gemini", false), brain("hermes")];
/** As Claude Code lists them (2026-11): its current models first, "fable" still standing for 5.1. */
const CLAUDE: BrainModel[] = [
  { id: "opus", name: "Opus 5.5", description: "For complex work", resolved: "claude-opus-5-5" },
  { id: "claude-fable-5-2", name: "Fable 5.2", resolved: "claude-fable-5-2" },
  { id: "sonnet", name: "Sonnet 5.5", resolved: "claude-sonnet-5-5" },
  { id: "haiku", name: "Haiku 5.5", resolved: "claude-haiku-5-5" },
  { id: "fable", name: "Fable 5.1", resolved: "claude-fable-5-1" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", resolved: "claude-haiku-4-5-20251001" },
  { id: "claude-opus-4-8", name: "Opus 4.8", resolved: "claude-opus-4-8" },
];
const ZEN: BrainModel[] = [
  { id: "ollama/bonsai-2:27b", name: "ollama/bonsai-2:27b" },
  { id: "ollama/bonsai-2:latest", name: "ollama/bonsai-2:latest" },
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

  test("a model's name is the brain's own; with no list it is the id as written, never a guess", () => {
    expect(modelName("claude:opus", BRAINS, { claude: CLAUDE })).toBe("Opus 5.5");
    expect(modelName("claude:fable", BRAINS, { claude: CLAUDE })).toBe("Fable 5.1");
    expect(modelName("claude:claude-fable-5-2", BRAINS, { claude: CLAUDE })).toBe("Fable 5.2");
    // A full id the list has only as an alias takes the alias's name.
    expect(modelName("claude:claude-opus-5-5", BRAINS, { claude: CLAUDE })).toBe("Opus 5.5");
    expect(modelName("claude:opus", BRAINS)).toBe("opus");
    expect(modelName("claude:claude-fable-5-2")).toBe("claude-fable-5-2");
    expect(modelName("opencode:opencode/deepseek-v4.1-flash-free", BRAINS, { opencode: ZEN })).toBe("DeepSeek V4.1 Flash Free");
    expect(modelName("opencode:opencode/deepseek-v4.1-flash-free", BRAINS)).toBe("deepseek-v4.1-flash-free");
    expect(modelName("codex", BRAINS)).toBe("Codex");
  });
});

describe("what a picker lists", () => {
  const status = { model: "claude:opus", fallback: ["opencode:opencode/deepseek-v4.1-flash-free"] };

  test("Claude leads with the start of its own list, so the current Fable is the one offered, not the alias's older one", () => {
    const groups = modelGroups(status, BRAINS, { claude: CLAUDE, opencode: ZEN });
    expect(groups[0]!.choices.map((c) => [c.ref, c.name, c.selected])).toEqual([
      ["claude:opus", "Opus 5.5", true],
      ["claude:claude-fable-5-2", "Fable 5.2", false],
      ["claude:sonnet", "Sonnet 5.5", false],
      ["claude:haiku", "Haiku 5.5", false],
    ]);
    expect(groups[0]!.choices[0]!.detail).toBe("For complex work · opus is claude-opus-5-5");
    expect(groups[0]!.more.map((c) => [c.ref, c.name])).toEqual([
      ["claude:fable", "Fable 5.1"],
      ["claude:claude-haiku-4-5-20251001", "Haiku 4.5"],
      ["claude:claude-opus-4-8", "Opus 4.8"],
    ]);
    expect(groups[0]!.more[0]!.detail).toBe("fable is claude-fable-5-1");
  });

  test("a list in no such order leads with nothing: what is set or a fallback, the default, and the rest behind More", () => {
    const groups = modelGroups(status, BRAINS, { claude: CLAUDE, opencode: ZEN });
    // "Default" says which model the brain runs when none is named, when its list marks one.
    expect(groups[2]!.choices.map((c) => [c.name, c.note])).toEqual([["DeepSeek V4.1 Flash Free", "Zen"], ["Default (Tidepool Alpha Free)", undefined]]);
    expect(groups[2]!.choices[1]!.detail).toBe("Whatever OpenCode is set to use on the host: Tidepool Alpha Free now");
    expect(modelName("opencode", BRAINS, { opencode: ZEN })).toBe("Tidepool Alpha Free");
    expect(groups[2]!.more.map((c) => [c.name, c.note])).toContainEqual(["bonsai-2:27b", "Ollama"]);
    expect(groups[2]!.more).toHaveLength(6);
  });

  test("what is set joins the leading entries when it isn't one, and a full id marks the alias that stands for it", () => {
    const older = modelGroups({ model: "fable", fallback: [] }, BRAINS, { claude: CLAUDE });
    expect(older[0]!.choices.map((c) => [c.name, c.selected])).toEqual([["Opus 5.5", false], ["Fable 5.2", false], ["Sonnet 5.5", false], ["Haiku 5.5", false], ["Fable 5.1", true]]);
    const full = modelGroups({ model: "claude:claude-sonnet-5-5", fallback: [] }, BRAINS, { claude: CLAUDE });
    expect(full[0]!.choices.filter((c) => c.selected).map((c) => c.ref)).toEqual(["claude:sonnet"]);
    expect(full[0]!.choices).toHaveLength(4);
  });

  test("with no list from a brain, only what the host names is offered, by its id, and the group says it isn't listed", () => {
    const groups = modelGroups(status, BRAINS);
    expect(groups.map((g) => [g.provider, g.listed])).toEqual([["claude", false], ["codex", false], ["opencode", false], ["hermes", true]]);
    expect(groups[0]!.choices.map((c) => [c.ref, c.name, c.selected])).toEqual([["claude:opus", "opus", true]]);
    expect(groups[1]!.choices.map((c) => [c.ref, c.name])).toEqual([["codex", "Default"]]);
    expect(groups[2]!.choices.map((c) => [c.ref, c.name, c.note])).toEqual([
      ["opencode:opencode/deepseek-v4.1-flash-free", "deepseek-v4.1-flash-free", "Zen"],
      ["opencode", "Default", undefined],
    ]);
    expect(groups[3]!.choices.map((c) => c.name)).toEqual(["Hermes"]);
    expect(groups.every((g) => g.more.length === 0)).toBe(true);
    // Claude with nothing of its own set: nothing to offer until the brain lists its models.
    expect(modelGroups({ model: "codex", fallback: [] }, BRAINS)[0]!.choices).toEqual([]);
  });

  test("a short list shows whole", () => {
    const groups = modelGroups({ model: "claude:opus", fallback: [] }, BRAINS, { opencode: ZEN.slice(2, 5) });
    expect(groups[2]!.choices.map((c) => c.ref)).toEqual(["opencode", "opencode:opencode/big-pickle", "opencode:opencode/deepseek-v4.1-flash-free", "opencode:opencode/tidepool-alpha-free"]);
    expect(groups[2]!.more).toEqual([]);
  });

  test("a brain that isn't installed is listed only while it is the one set", () => {
    expect(modelGroups({ model: "gemini", fallback: [] }, BRAINS).map((g) => g.provider)).toContain("gemini");
    expect(modelGroups(status, BRAINS).map((g) => g.provider)).not.toContain("gemini");
  });

  test("the lists needed to name what the host is set to: the model's, the stand-in's and each fallback's", () => {
    expect(providersInUse({ model: "claude:opus", activeModel: "codex", fallback: ["opencode:opencode/big-pickle", "claude:sonnet"] }, BRAINS)).toEqual(["claude", "codex", "opencode"]);
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

  test("the set model thinking says only its name; a stand-in says what it stands in for, both in the brains' own names", () => {
    expect(thinkingWith({ model: "claude:opus", activeModel: "claude:opus", account: "personal", activeAccount: "personal" }, BRAINS, { claude: CLAUDE })).toEqual({ name: "Opus 5.5", account: "personal" });
    const t = thinkingWith({ model: "claude:opus", activeModel: "opencode:opencode/deepseek-v4.1-flash-free", account: "work", caps: { "claude@work": later } }, BRAINS, { claude: CLAUDE, opencode: ZEN }, now);
    expect(t.name).toBe("DeepSeek V4.1 Flash Free");
    expect(t.standIn).toBe(`Opus 5.5 on work is out of usage until ${capTime(later, now)}`);
    expect(thinkingWith({ model: "claude:opus" }, BRAINS).name).toBe("opus");
  });

  test("a cap ending today says the time, another day says the day too", () => {
    expect(capTime(new Date(2026, 10, 20, 16, 0).getTime(), now, "en-US")).toBe("4:00 PM");
    expect(capTime(later, now, "en-US")).toBe("Sat 1:00 AM");
  });
});
