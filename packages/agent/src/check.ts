import { AuthRequiredError, ProviderNotInstalledError, Yagami } from "@justin06lee/yagami";
import { checkModel } from "./brain.ts";

export type BrainCheck =
  | { ok: true; model: string }
  | { ok: false; model: string; reason: "not_installed" | "signed_out" | "unusable"; message: string; loginCommand?: string; installHint?: string };

/** "claude (then /login)" → "run `claude` there and type /login". */
export function howToSignIn(loginCommand: string): string {
  const [cmd = "claude"] = loginCommand.split(" ");
  const then = /\(then ([^)]+)\)/.exec(loginCommand)?.[1];
  return `run \`${cmd}\` there${then ? ` and type ${then}` : ""}`;
}

/** yagami's sign-in and missing-CLI failures, as their messages read once wrapped in an ApiError or a BrainError. */
const SIGNED_OUT = /: not logged in\b[\s\S]*\. Run: ([^\n]+?)\s*$/;
const NOT_INSTALLED = /: CLI not found\b(?: \([\s\S]*?\))?\. ([^\n]+?)\s*$/;

/** What's wrong with the brain, when an error says it's signed out or missing rather than just failing. */
export function brainProblem(err: unknown): { reason: "signed_out"; loginCommand: string } | { reason: "not_installed"; installHint: string } | null {
  // A session or a BrainError carries yagami's typed failure itself, or as its `cause`. The codes
  // match even when two copies of yagami end up in a bundle and instanceof can't.
  type Failure = { cause?: unknown; code?: string; loginCommand?: string; installHint?: string; message?: string };
  for (let e = err as Failure | undefined, depth = 0; e && depth < 3; e = e.cause as Failure | undefined, depth++) {
    if (e instanceof AuthRequiredError || e.code === "auth_required") return { reason: "signed_out", loginCommand: e.loginCommand ?? "claude (then /login)" };
    if (e instanceof ProviderNotInstalledError || e.code === "provider_not_installed") return { reason: "not_installed", installHint: e.installHint ?? "" };
  }
  // yagami's API (`new Yagami().messages`) turns those failures into an ApiError that keeps only
  // the message, whose shape is fixed: "codex: not logged in (…). Run: codex login".
  for (let e = err as Failure | undefined, depth = 0; e && depth < 3; e = e.cause as Failure | undefined, depth++) {
    const text = e.message ?? "";
    const login = SIGNED_OUT.exec(text)?.[1];
    if (login) return { reason: "signed_out", loginCommand: login };
    const hint = NOT_INSTALLED.exec(text)?.[1];
    if (hint) return { reason: "not_installed", installHint: hint };
  }
  // A Claude Code session reports a signed-out CLI as its own result text, not as a yagami error.
  if (/Not logged in · Please run \/login/i.test((err as Error | undefined)?.message ?? "")) return { reason: "signed_out", loginCommand: "claude (then /login)" };
  return null;
}

/**
 * One tiny real turn through the brain the user picked: the only way to know
 * the CLI is not just installed but signed in. Costs a few tokens.
 */
export async function checkBrainLive(model: string): Promise<BrainCheck> {
  const problem = checkModel(model);
  if (problem) return { ok: false, model, reason: "unusable", message: problem };
  try {
    await new Yagami().messages.create({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word: ok" }] });
    return { ok: true, model };
  } catch (err) {
    const p = brainProblem(err);
    const message = (err as Error).message;
    if (p?.reason === "signed_out") return { ok: false, model, reason: "signed_out", message, loginCommand: p.loginCommand };
    if (p?.reason === "not_installed") return { ok: false, model, reason: "not_installed", message, installHint: p.installHint };
    return { ok: false, model, reason: "unusable", message };
  }
}
