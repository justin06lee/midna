import {
  AgentSession,
  PROVIDER_PRESETS,
  createProvider,
  detectProviders,
  isSessionProvider,
  loadHostEngineConfig,
  parseModelRef,
  type PermissionHandler,
  type SessionPermissionHandler,
} from "@justin06lee/yagami";

/**
 * The brain is whichever agent harness the user picked, reached through
 * yagami. Claude runs as a full Claude Code session (AgentSession); every
 * other harness — Codex, Gemini, OpenCode, any ACP agent — runs through
 * yagami's provider-neutral session. Both get midna's tools over MCP and
 * both get the run of the host.
 */

export interface BrainRun {
  prompt: string;
  systemPrompt: string;
  /** yagami model ref: "claude:opus", "opus", "codex:gpt-5.6-sol", "gemini", … */
  model: string;
  /** Provider session to continue. */
  resume?: string;
  cwd: string;
  mcp: { url: string; token: string };
  /** "autonomous" lets every tool run; "ask" lets only read-only and midna's own tools run. */
  mode: "autonomous" | "ask";
  /** A tool call starting, with a few words on what it is for ("Bash", "npm run build"). */
  onActivity?: (tool: string, detail?: string) => void;
  /**
   * Interrupts the turn, as Esc does in the terminal: what its tools already
   * did stays in the session's transcript for the next turn to resume.
   */
  signal?: AbortSignal;
}

export interface BrainResult {
  /** The final reply: what the model said after its last tool call. */
  text: string;
  sessionId?: string;
  /**
   * What the session has cost so far, as the harness reports it: Claude Code
   * and ACP agents carry a running total across resumed turns, so this is not
   * the turn's own cost — Core works that out.
   */
  sessionCostUsd?: number;
  /** The tokens this turn used, when the harness says. */
  usage?: TurnUsage;
}

/** One turn's tokens, in the Messages API's terms. */
export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Only the counts: a result's usage carries much else (iterations, tiers). */
function turnUsage(u: TurnUsage | undefined): TurnUsage | undefined {
  if (!u) return undefined;
  return { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0 };
}

export type Brain = (run: BrainRun) => Promise<BrainResult>;

export class BrainError extends Error {
  /** `cause` keeps yagami's typed failure, so a signed-out or missing CLI can still be told apart. */
  constructor(message: string, readonly sessionId?: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * The provider's usage limit is reached (Claude's 5-hour or weekly cap, the ChatGPT plan's): it can
 * think again from `until` (epoch ms), when the provider says. The message has a fixed shape —
 * "claude usage limit reached until 2026-10-26T23:00:00.000Z" — so a wakeup's stored error still
 * reads as a cap after a restart (brainProblem).
 */
export class BrainCappedError extends BrainError {
  /** midna's tools the turn called before it was cut off: a rerun must check before redoing them. */
  tools: string[] = [];
  constructor(readonly provider: string, readonly until: number | undefined, sessionId?: string, readonly toolCalls = 0, options?: { cause?: unknown }) {
    super(`${provider} usage limit reached${until ? ` until ${new Date(until).toISOString()}` : ""}`, sessionId, options);
  }
}

/** A reset time as Claude Code or Codex gives it — epoch seconds or ms — in ms; nothing for nonsense. */
export function resetTime(at: unknown): number | undefined {
  const n = typeof at === "string" && /^\d+$/.test(at) ? Number(at) : at;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  if (typeof at === "string") {
    const t = Date.parse(at);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/** Tools allowed in "ask" mode without the user: they only read, or only touch midna's own state. */
const ASK_MODE_SAFE = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "LS", "NotebookRead"]);
const ASK_MODE_DENIAL =
  "midna is in ask mode: this action needs the user's approval. Describe exactly what you want to do with ask_user, and do it in a later turn once they approve.";
/**
 * How long Claude Code waits on one MCP tool call: a device command can wait for the user's yes
 * (2 min) and then run for up to its cap (a shell command, 10 min).
 */
const MCP_TOOL_TIMEOUT = 15 * 60_000;
/** How Claude Code words a reached usage limit ("Claude AI usage limit reached|…", "You've hit your limit · resets 4pm"). */
export const USAGE_LIMIT_TEXT = /\busage limit reached\b|\bhit your (?:usage )?limit\b/i;
/** How long an interrupted harness may take to wind down before its process is closed. */
const INTERRUPT_GRACE = 10_000;
/** After a background-task notice's empty turn, how long to wait for the prompt's own turn to start. */
const NOTICE_GRACE = 30_000;

/** A few words from a tool call's input on what it is doing: a command's description, a path, a URL. */
export function toolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  const v = [i.description, i.command, i.file_path, i.path, i.url, i.pattern, i.query, i.question, i.text].find((x) => typeof x === "string" && x.trim());
  if (typeof v !== "string") return undefined;
  const line = v.trim().replace(/\s+/g, " ");
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

export function resolveModel(model: string): { provider: string; model?: string } {
  const ref = parseModelRef(model, PROVIDER_PRESETS.map((p) => p.id));
  return { provider: ref.providerId ?? "claude", ...(ref.model ? { model: ref.model } : {}) };
}

/** Harnesses installed on this machine that can run midna's brain. */
export function installedBrains(): Array<{ id: string; label: string; installed: boolean; loginCommand: string; installHint: string }> {
  return detectProviders(loadHostEngineConfig().providerConfig ?? {}).map(({ id, label, installed, loginCommand, installHint }) => ({ id, label, installed, loginCommand, installHint }));
}

/** Why `model` can't run here, or null when it can. */
export function checkModel(model: string): string | null {
  const brains = installedBrains();
  const prefix = model.includes(":") ? model.slice(0, model.indexOf(":")) : null;
  // yagami reads an unknown prefix as a bare Claude model id; here it is nearly always a typo.
  if (prefix !== null && !brains.some((b) => b.id === prefix)) {
    return `unknown provider "${prefix}" — use "<provider>:<model>" with one of: ${brains.filter((b) => b.installed).map((b) => b.id).join(", ")}`;
  }
  const { provider } = resolveModel(model);
  const found = brains.find((p) => p.id === provider);
  if (!found) return `unknown provider "${provider}" — use "<provider>:<model>", e.g. "claude:opus" or "codex:gpt-5.6-sol"`;
  if (!found.installed) return `${found.label} isn't installed on this machine (${found.installHint})`;
  return null;
}

export const yagamiBrain: Brain = async (run) => {
  const { provider, model } = resolveModel(run.model);
  return provider === "claude" ? runClaude(run, model) : runHarness(run, provider, model);
};

async function runClaude(run: BrainRun, model: string | undefined): Promise<BrainResult> {
  if (run.signal?.aborted) throw new BrainError("claude turn interrupted before it started");
  // midna's own tools pass in ask mode: they touch midna's state, or — the device_* tools —
  // are gated by the daemon itself, which knows each device's toggles and what counts as acting.
  const askPolicy: PermissionHandler = async (req) =>
    ASK_MODE_SAFE.has(req.toolName) || req.toolName.startsWith("mcp__midna__")
      ? { behavior: "allow" }
      : { behavior: "deny", message: ASK_MODE_DENIAL };
  const session = new AgentSession({
    cwd: run.cwd,
    parity: "isolated",
    appName: "midna",
    ...(model ? { model } : {}),
    ...(run.mode === "ask" ? { onPermission: askPolicy } : {}),
    options: {
      systemPrompt: run.systemPrompt,
      ...(run.resume ? { resume: run.resume } : {}),
      // alwaysLoad: midna's tools are its core abilities — never defer them behind tool search.
      mcpServers: { midna: { type: "http", url: run.mcp.url, headers: { authorization: `Bearer ${run.mcp.token}` }, alwaysLoad: true } as never },
      env: { MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT) },
      ...(run.mode === "autonomous" ? { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } : {}),
    },
  });
  // Claude Code writes the transcript as it goes and closes an interrupted tool call with
  // "[Request interrupted by user for tool use]", so a resumed session sees the partial turn.
  let forced: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    void session.interrupt().catch(() => {});
    forced = setTimeout(() => session.close(), INTERRUPT_GRACE);
  };
  run.signal?.addEventListener("abort", onAbort, { once: true });
  let sessionId: string | undefined;
  // Resuming a session whose last process died with background jobs running, Claude Code first runs
  // their "didn't finish before the previous session ended" notices as a turn of their own — no model
  // call, an empty result — and only then the prompt. That result is not the reply: wait for the next.
  let notice: { sessionCostUsd: number } | null = null;
  let waiting: ReturnType<typeof setTimeout> | undefined;
  // Claude Code says it's capped in typed form: a rate_limit_event "rejected" (with when it resets)
  // and an assistant message whose error is "rate_limit". No message text is read for it.
  let capped: { until?: number } | null = null;
  let resetsAt: number | undefined;
  let toolCalls = 0;
  try {
    session.send(run.prompt);
    for await (const msg of session) {
      if ("session_id" in msg && msg.session_id) sessionId = msg.session_id;
      if (msg.type === "rate_limit_event") {
        const info = msg.rate_limit_info;
        resetsAt = resetTime(info.resetsAt) ?? resetsAt;
        if (info.status === "rejected") capped = { until: resetsAt };
      }
      if (msg.type === "assistant" && msg.error === "rate_limit") capped = { until: resetsAt };
      if (waiting && (msg.type === "assistant" || (msg.type === "system" && msg.subtype === "init"))) {
        clearTimeout(waiting);
        waiting = undefined;
      }
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            toolCalls++;
            run.onActivity?.(block.name.replace(/^mcp__midna__/, ""), toolDetail(block.input));
          }
        }
      }
      if (msg.type === "result") {
        if (msg.subtype === "success" && !msg.is_error && msg.num_turns === 0 && !msg.result.trim() && !run.signal?.aborted) {
          notice = { sessionCostUsd: msg.total_cost_usd };
          waiting = setTimeout(() => session.close(), NOTICE_GRACE);
          continue;
        }
        // A turn that finished just as the interrupt landed still counts: its reply is whole.
        if (msg.subtype === "success" && !msg.is_error) {
          return { text: msg.result, sessionId, sessionCostUsd: msg.total_cost_usd, usage: turnUsage(msg.usage) };
        }
        if (run.signal?.aborted) throw new BrainError("claude turn interrupted", sessionId);
        if (capped) throw new BrainCappedError("claude", capped.until ?? resetsAt, sessionId, toolCalls);
        const why = msg.subtype === "success" ? msg.result : msg.subtype;
        // Last resort, should the typed signals ever go missing: the limit's own wording.
        if (USAGE_LIMIT_TEXT.test(why)) throw new BrainCappedError("claude", resetsAt, sessionId, toolCalls);
        throw new BrainError(`claude turn failed: ${why}`, sessionId);
      }
    }
    if (run.signal?.aborted) throw new BrainError("claude turn interrupted", sessionId);
    if (capped) throw new BrainCappedError("claude", capped.until ?? resetsAt, sessionId, toolCalls);
    // The prompt's turn never came: say nothing, and let the caller ask again.
    if (notice) return { text: "", sessionId, sessionCostUsd: notice.sessionCostUsd };
    throw new BrainError("claude session ended without a result", sessionId);
  } catch (err) {
    if (run.signal?.aborted && !(err instanceof BrainError)) throw new BrainError("claude turn interrupted", sessionId, { cause: err });
    if (capped && !(err instanceof BrainError)) throw new BrainCappedError("claude", capped.until ?? resetsAt, sessionId, toolCalls, { cause: err });
    if (notice && !(err instanceof BrainError)) return { text: "", sessionId, sessionCostUsd: notice.sessionCostUsd };
    throw err;
  } finally {
    clearTimeout(forced);
    clearTimeout(waiting);
    run.signal?.removeEventListener("abort", onAbort);
    session.close();
  }
}

async function runHarness(run: BrainRun, providerId: string, model: string | undefined): Promise<BrainResult> {
  if (run.signal?.aborted) throw new BrainError(`${providerId} turn interrupted before it started`);
  const host = loadHostEngineConfig();
  const provider = createProvider(providerId, host.providerConfig?.[providerId] ?? {}, { appName: "midna" });
  if (!isSessionProvider(provider)) throw new BrainError(`${providerId} can't host an agent session`);
  const permissions: SessionPermissionHandler = {
    decide: async (req) => {
      if (run.mode === "autonomous") return "allow";
      // As for Claude: the daemon gates midna's device tools itself.
      if (req.server === "midna" || req.kind === "read" || req.kind === "search" || req.kind === "fetch") return "allow";
      return "deny";
    },
  };
  const session = provider.openSession({
    cwd: run.cwd,
    ...(model ? { model } : {}),
    ...(run.resume ? { resume: run.resume } : {}),
    systemPrompt: run.systemPrompt,
    parity: "isolated",
    appName: "midna",
    permissions,
    mcpServers: { midna: { url: run.mcp.url, headers: { authorization: `Bearer ${run.mcp.token}` } } },
    ...(providerId === "codex" && run.mode === "autonomous"
      ? { native: { sandbox: "danger-full-access", approvalPolicy: "never" } }
      : {}),
  });
  const onAbort = () => void session.interrupt().catch(() => {});
  run.signal?.addEventListener("abort", onAbort, { once: true });
  let reply = "";
  let sessionCostUsd: number | undefined;
  let usage: TurnUsage | undefined;
  let toolCalls = 0;
  try {
    for await (const ev of session.send(run.prompt)) {
      if (ev.type === "text" && !ev.thread) reply += ev.text;
      else if (ev.type === "tool_call" && !ev.thread && ev.status === "started") {
        toolCalls++;
        run.onActivity?.(ev.name.replace(/^(mcp__midna__|midna[.:/])/, ""), ev.title ?? toolDetail(ev.input));
        reply = ""; // the reply is what comes after the last tool call
      } else if (ev.type === "done") {
        sessionCostUsd = ev.costUsd;
        usage = turnUsage(ev.usage);
      }
    }
    // Not every harness says a turn was cut short (ACP reports "end_turn"): an interrupted one is never a whole reply.
    if (run.signal?.aborted) throw new BrainError(`${providerId} turn interrupted`, session.id);
    return { text: reply.trim(), sessionId: session.id, ...(sessionCostUsd !== undefined ? { sessionCostUsd } : {}), ...(usage ? { usage } : {}) };
  } catch (err) {
    if (err instanceof BrainError) throw err;
    // yagami's typed UsageLimitError; the code matches even where two copies of yagami defeat instanceof.
    const limit = err as { code?: string; resetsAt?: unknown };
    if (!run.signal?.aborted && limit?.code === "usage_limit") throw new BrainCappedError(providerId, resetTime(limit.resetsAt), session.id, toolCalls, { cause: err });
    throw new BrainError(`${providerId} turn ${run.signal?.aborted ? "interrupted" : `failed: ${(err as Error).message}`}`, session.id, { cause: err });
  } finally {
    run.signal?.removeEventListener("abort", onAbort);
    await session.close().catch(() => {});
  }
}
