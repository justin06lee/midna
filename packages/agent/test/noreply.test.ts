import { describe, expect, test } from "bun:test";
import { isNoReply } from "../src/assistant.ts";

describe("isNoReply", () => {
  test("what a model writes when it took the turn for an automated event", () => {
    for (const t of ["", "  ", "No response requested.", "no response needed", "*No reply needed.*", "Nothing to add.", "No response required!"]) expect(isNoReply(t)).toBe(true);
  });
  test("any real reply", () => {
    for (const t of ["Noted.", "No — the meeting moved to 7.", "No response requested from Bob yet; I'll chase him.", "ok"]) expect(isNoReply(t)).toBe(false);
  });
});
