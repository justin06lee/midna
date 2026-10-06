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

/** What's wrong with the brain, when an error says it's signed out or missing rather than just failing. */
export function brainProblem(err: unknown): { reason: "signed_out"; loginCommand: string } | { reason: "not_installed"; installHint: string } | null {
  // yagami rejects with an ApiError whose `cause` is the typed failure. The codes
  // match even when two copies of yagami end up in a bundle and instanceof can't.
  type Failure = { cause?: unknown; code?: string; loginCommand?: string; installHint?: string };
  for (let e = err as Failure | undefined, depth = 0; e && depth < 3; e = e.cause as Failure | undefined, depth++) {
    if (e instanceof AuthRequiredError || e.code === "auth_required") return { reason: "signed_out", loginCommand: e.loginCommand ?? "claude (then /login)" };
    if (e instanceof ProviderNotInstalledError || e.code === "provider_not_installed") return { reason: "not_installed", installHint: e.installHint ?? "" };
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
