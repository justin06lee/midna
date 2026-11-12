import { AuthRequiredError, ProviderNotInstalledError, Yagami } from "@justin06lee/yagami";
import { BrainCappedError, USAGE_LIMIT_TEXT, checkModel } from "./brain.ts";
import { checkHermes, isHermes } from "./hermes.ts";

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
/** BrainCappedError's message, as a wakeup's stored error keeps it: "claude usage limit reached until <ISO>". */
const CAPPED = /(?:^|: )([a-z][\w-]*) usage limit reached(?: until (\d{4}-\d\d-\d\dT[\d:.]+Z))?/;

export type BrainProblem =
  | { reason: "signed_out"; loginCommand: string }
  | { reason: "not_installed"; installHint: string }
  /** The provider's usage limit: it thinks again from `until` (epoch ms), when known. */
  | { reason: "capped"; provider: string; until?: number };

/** What's wrong with the brain, when an error says it's signed out, missing or capped rather than just failing. */
export function brainProblem(err: unknown): BrainProblem | null {
  if (err instanceof BrainCappedError) return { reason: "capped", provider: err.provider, ...(err.until ? { until: err.until } : {}) };
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
    const cap = CAPPED.exec(text);
    if (cap) return { reason: "capped", provider: cap[1]!, ...(cap[2] ? { until: Date.parse(cap[2]) } : {}) };
    // Before 0.12 a cap was stored as a plain failure: "claude turn failed: Claude AI usage limit reached|…".
    const old = /^([a-z][\w-]*) turn failed: /.exec(text)?.[1];
    if (old && USAGE_LIMIT_TEXT.test(text)) return { reason: "capped", provider: old };
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
  if (isHermes(model)) {
    const down = await checkHermes();
    return down ? { ok: false, model, reason: "unusable", message: down } : { ok: true, model };
  }
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
