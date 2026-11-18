import { z } from "zod";

/**
 * Asking midna's permission: a program the user runs (ghostly's broker, say)
 * has something it won't do on its own word, and asks midna to approve or
 * deny it. midna decides in the background, or asks the user; the asker
 * waits for the answer. Nothing secret goes through here: an ask carries
 * names and reasons, never a password (docs/permissions.md).
 */

/** The kind a program pairs as to ask (POST /v1/pair): it may send events and ask permission, and nothing else. */
export const SERVICE_KIND = "service";

export const PERMISSION_TIMEOUT_MS = 2 * 60_000;
export const PERMISSION_TIMEOUT_MAX_MS = 5 * 60_000;
/** The longest "approved for N minutes" lasts. */
export const PERMISSION_GRANT_MAX_MIN = 60;
export const MAX_PERMISSION_DATA_BYTES = 16 * 1024;

/** POST /v1/permissions. */
export const PermissionAsk = z.object({
  /** What kind of thing is asked ("vault.use"). */
  kind: z.string().trim().min(1).max(100),
  /**
   * What would be allowed, as one plain sentence: who, what, how. Shown to
   * midna, and to the user word for word if midna asks them:
   * `the agent "codex" on mini-m4 (not registered) uses the login "GitHub" (password) to run "gh auth login"`.
   */
  summary: z.string().trim().min(1).max(500),
  /**
   * What an approval "for N minutes" covers: another ask from the same
   * asker with the same scope passes without anyone being asked until it
   * runs out. For ghostly: the agent and the login, "codex@mini-m4/login:1234".
   */
  scope: z.string().trim().min(1).max(200),
  /** Why, in the words of whoever wants it. midna weighs it as a claim. */
  reason: z.string().trim().max(1_000).optional(),
  /** The details as JSON, up to MAX_PERMISSION_DATA_BYTES, for midna to read. No secret values. */
  data: z.unknown().optional(),
  /** How long the asker waits. No decision by then is "expired", which is no. */
  timeoutMs: z.number().int().min(1_000).max(PERMISSION_TIMEOUT_MAX_MS).optional(),
});
export type PermissionAsk = z.input<typeof PermissionAsk>;

/** An ask and what became of it: POST /v1/permissions and GET /v1/permissions/:id. Anything but "approved" is no. */
export interface AskedPermission {
  /** "perm_…" */
  id: string;
  kind: string;
  summary: string;
  scope: string;
  status: "pending" | "approved" | "denied" | "expired";
  /** Who decided: midna itself, the user (asked by midna, or when midna didn't decide in time), or an approval still running for this scope. */
  decidedBy: "midna" | "user" | "grant" | null;
  /** A short why, for the asker to pass on. */
  reason: string | null;
  /** Approved for a while: asks with this scope pass until then (ms). Null for this once. */
  approvedUntil: number | null;
  requestedAt: number;
  expiresAt: number;
  decidedAt: number | null;
}
