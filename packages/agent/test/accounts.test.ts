import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountEmails, capKey, claudeEnv, usableAccount } from "../src/accounts.ts";

const home = mkdtempSync(join(tmpdir(), "midna-accounts-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("Claude accounts", () => {
  test("work is Claude Code's default config, with CLAUDE_CONFIG_DIR unset; personal has a folder of its own", () => {
    expect(claudeEnv("work", home)).toEqual({ CLAUDE_CONFIG_DIR: undefined });
    expect(claudeEnv("personal", home)).toEqual({ CLAUDE_CONFIG_DIR: join(home, ".claude-personal") });
  });

  test("who each is signed in as, read from its config as claude-as reads it", () => {
    expect(accountEmails(home)).toEqual({ work: null, personal: null });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@work.example" } }));
    mkdirSync(join(home, ".claude-personal"));
    writeFileSync(join(home, ".claude-personal", ".claude.json"), "{ not json");
    expect(accountEmails(home)).toEqual({ work: "me@work.example", personal: null });
  });

  test("a capped account gives way to the other only with fallback, and only to one that isn't capped", () => {
    const work = { [capKey("claude", "work")]: 1 };
    expect(capKey("claude", "work")).toBe("claude@work");
    expect(capKey("codex", "work")).toBe("codex");
    expect(usableAccount("work", {}, false)).toBe("work");
    expect(usableAccount("work", work, false)).toBeNull();
    expect(usableAccount("work", work, true)).toBe("personal");
    expect(usableAccount("work", { ...work, "claude@personal": 1 }, true)).toBeNull();
  });
});
