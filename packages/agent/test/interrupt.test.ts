import { describe, expect, test } from "bun:test";
import { QUEUE_PREFIX } from "../src/assistant.ts";
import { toolDetail } from "../src/brain.ts";

describe("QUEUE_PREFIX", () => {
  test("/queue, as typed or picked from a bot's command menu", () => {
    for (const t of ["/queue then the slides", "/QUEUE then", "/queue@midna_bot then", "/queue"]) expect(QUEUE_PREFIX.test(t)).toBe(true);
    expect("/queue@midna_bot  then the slides".replace(QUEUE_PREFIX, "")).toBe("then the slides");
  });
  test("anything else interrupts", () => {
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
