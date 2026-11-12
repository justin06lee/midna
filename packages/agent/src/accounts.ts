import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account } from "@midna/protocol";

/**
 * Two Claude accounts, as the user's `claude-as` helper has them: "work" is
 * Claude Code's own config (~/.claude, with ~/.claude.json beside it), and
 * "personal" lives in ~/.claude-personal, picked with CLAUDE_CONFIG_DIR.
 * Each is signed in on its own; nothing here copies credentials between them.
 */

export const ACCOUNTS: readonly Account[] = ["work", "personal"];

export const otherAccount = (a: Account): Account => (a === "work" ? "personal" : "work");

/** The CLAUDE_CONFIG_DIR an account runs with; none for work, which is Claude Code's default. */
export function claudeConfigDir(account: Account, home = homedir()): string | undefined {
  return account === "personal" ? join(home, ".claude-personal") : undefined;
}

/**
 * The environment a Claude Code process needs to run as `account`. Work
 * unsets CLAUDE_CONFIG_DIR rather than pointing it at ~/.claude: set, Claude
 * Code reads its config from inside that folder, not ~/.claude.json, and
 * would find no one signed in.
 */
export function claudeEnv(account: Account, home = homedir()): { CLAUDE_CONFIG_DIR: string | undefined } {
  return { CLAUDE_CONFIG_DIR: claudeConfigDir(account, home) };
}

/** The email an account is signed in as on this machine, read from its config without starting Claude Code; null when none. */
export function accountEmail(account: Account, home = homedir()): string | null {
  const dir = claudeConfigDir(account, home);
  const file = dir ? join(dir, ".claude.json") : join(home, ".claude.json");
  if (!existsSync(file)) return null;
  try {
    const email = (JSON.parse(readFileSync(file, "utf8")) as { oauthAccount?: { emailAddress?: unknown } }).oauthAccount?.emailAddress;
    return typeof email === "string" && email ? email : null;
  } catch {
    return null;
  }
}

export function accountEmails(home = homedir()): Record<Account, string | null> {
  return { work: accountEmail("work", home), personal: accountEmail("personal", home) };
}

/**
 * What a cap is kept under: the provider, and for Claude the account too
 * ("claude@personal"), since each account has a usage limit of its own.
 */
export function capKey(provider: string, account?: Account): string {
  return provider === "claude" && account ? `claude@${account}` : provider;
}

/** The account to run on: `want`, or while it's capped the other one if fallback allows and it isn't capped too; null when neither will do. */
export function usableAccount(want: Account, caps: Record<string, number>, fallback: boolean): Account | null {
  if (!caps[capKey("claude", want)]) return want;
  const other = otherAccount(want);
  return fallback && !caps[capKey("claude", other)] ? other : null;
}
