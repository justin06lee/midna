import { describe, expect, test } from "bun:test";
import { brainModels } from "../src/models.ts";

const brain = (id: string, installed = true) => ({ id, label: id, installed, loginCommand: "", installHint: `install ${id}` });
const brains = () => [brain("claude"), brain("alpha"), brain("beta", false)];

describe("what a brain offers", () => {
  test("Claude's list is an account's, asked once and kept", async () => {
    const asked: string[] = [];
    const list = async (id: string, account?: string) => {
      asked.push(`${id}@${account}`);
      return [{ id: "opus", name: `Opus (${account})` }];
    };
    expect(await brainModels("claude", "personal", { list, brains })).toEqual([{ id: "opus", name: "Opus (personal)" }]);
    expect(await brainModels("claude", "personal", { list, brains })).toEqual([{ id: "opus", name: "Opus (personal)" }]);
    expect(await brainModels("claude", "work", { list, brains })).toEqual([{ id: "opus", name: "Opus (work)" }]);
    expect(await brainModels("claude", undefined, { list, brains })).toEqual([{ id: "opus", name: "Opus (work)" }]);
    expect(asked).toEqual(["claude@personal", "claude@work"]);
  });

  test("a failed ask isn't kept", async () => {
    let n = 0;
    const list = async () => {
      if (n++ === 0) throw new Error("timed out");
      return [{ id: "x", name: "X" }];
    };
    await expect(brainModels("alpha", undefined, { list, brains })).rejects.toThrow("timed out");
    expect(await brainModels("alpha", undefined, { list, brains })).toEqual([{ id: "x", name: "X" }]);
    expect(n).toBe(2);
  });

  test("an unknown or missing provider is refused, and Hermes has no models to pick", async () => {
    await expect(brainModels("nope", undefined, { brains })).rejects.toThrow('unknown provider "nope"');
    await expect(brainModels("beta", undefined, { brains })).rejects.toThrow("isn't installed on this machine (install beta)");
    expect(await brainModels("hermes", undefined, { brains })).toEqual([]);
  });
});
