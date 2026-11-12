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
import { randomUUID } from "node:crypto";
import type { Account } from "@midna/protocol";
import { claudeEnv } from "./accounts.ts";
import { HERMES, hermesBrain, hermesProblem, isHermes, type TurnFile } from "./hermes.ts";

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
  /** The Claude account Claude Code runs as; other harnesses have none. Work when left out. */
  account?: Account;
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
  /** The user's messages that arrive while the turn runs, for a brain that can hand them to the model mid-turn (Claude). */
  inbox?: Inbox;
  /** What the user sent with the turn, for a brain that can't open midna's files itself (Hermes). */
  files?: TurnFile[];
  /** The brain asks the user's OK for something it is about to do (Hermes's approvals); the answer is "once" or "deny". */
  onApproval?: (req: { summary: string; tool?: string }) => Promise<"once" | "deny">;
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

/** Two turns' tokens together. */
function addUsage(a: TurnUsage | undefined, b: TurnUsage | undefined): TurnUsage | undefined {
  if (!a || !b) return a ?? b;
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
}

export type Brain = (run: BrainRun) => Promise<BrainResult>;

/** A message from the user for a turn already running: its id in the log, and the words the model reads. */
export interface InboxMessage {
  id: number;
  text: string;
}

/**
 * The user's messages that come while a chat turn runs. A brain that can put
 * them in front of the model mid-turn opens it once its session can take
 * them; while it isn't open, the assistant interrupts the turn instead. A
 * message counts as answered only once the brain says the model saw it:
 * one it never saw waits for the next turn.
 */
export class Inbox {
  private take: ((m: InboxMessage) => void) | null = null;
  private readonly seenIds = new Set<number>();

  /** The brain is ready: each message goes to `take`. */
  open(take: (m: InboxMessage) => void): void {
    this.take = take;
  }

  close(): void {
    this.take = null;
  }

  /** Hand the running turn a message; false when it can't take one now. */
  give(m: InboxMessage): boolean {
    if (!this.take) return false;
    this.take(m);
    return true;
  }

  /** The model has read this message. */
  saw(id: number): void {
    this.seenIds.add(id);
  }

  /** The messages the model has read. */
  get seen(): number[] {
    return [...this.seenIds];
  }
}

/**
 * Which of the messages handed to a Claude Code session mid-turn its turns
 * have taken. Each send carries a uuid, and every result lists the uuids its
 * turn consumed (user_message_uuids): the ones it started with, and any it
 * folded in between tool calls. One sent too late to fold in runs as a turn
 * of its own after it, with a result of its own.
 */
export class Steering {
  private readonly pending = new Map<string, number>();
  /** False once a result came without user_message_uuids: this Claude Code can't say what it took. */
  tracked = true;

  constructor(private readonly inbox: Inbox) {}

  given(uuid: string, id: number): void {
    this.pending.set(uuid, id);
  }

  /** A result came: mark what it took as seen. True while some message is still to be taken, by a turn yet to come. */
  result(uuids: string[] | undefined): boolean {
    if (!uuids) this.tracked = false;
    for (const u of uuids ?? []) {
      const id = this.pending.get(u);
      if (id === undefined) continue;
      this.inbox.saw(id);
      this.pending.delete(u);
    }
    return this.pending.size > 0;
  }
}

/**
 * yagami's AgentSession.send(), with the client uuid Claude Code echoes back
 * in a result's user_message_uuids — what ties a mid-turn message to the
 * turn that read it. send() takes no uuid, so this writes to the session's
 * input queue itself; false (nothing sent) should yagami's insides change.
 */
export function sendTagged(session: AgentSession, text: string, uuid: string): boolean {
  const input = (session as unknown as { input?: { push?: unknown } }).input;
  if (typeof input?.push !== "function") return false;
  (input.push as (m: unknown) => void).call(input, { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: session.sessionId ?? "", uuid });
  return true;
}

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
  /** For Claude, the account whose limit it is: "claude usage limit reached on the personal account until …". */
  account?: Account;
  constructor(readonly provider: string, readonly until: number | undefined, sessionId?: string, readonly toolCalls = 0, options?: { cause?: unknown; account?: Account }) {
    super(`${provider} usage limit reached${options?.account ? ` on the ${options.account} account` : ""}${until ? ` until ${new Date(until).toISOString()}` : ""}`, sessionId, options);
    if (options?.account) this.account = options.account;
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
/** How long one midna tool call may run under Codex: a device action can wait
 *  on the user's approval, which Codex's 60 s default would cut off. */
const TOOL_TIMEOUT_SEC = 15 * 60;
/** How long an interrupted harness may take to wind down before its process is closed. */
const INTERRUPT_GRACE = 10_000;
/** After a background-task notice's empty turn, how long to wait for the prompt's own turn to start. */
const NOTICE_GRACE = 30_000;
/** After a turn that left a mid-turn message untaken, how long to wait for the turn that takes it to start. */
const STEER_GRACE = 120_000;

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
  if (isHermes(model)) return { provider: HERMES };
  const ref = parseModelRef(model, PROVIDER_PRESETS.map((p) => p.id));
  return { provider: ref.providerId ?? "claude", ...(ref.model ? { model: ref.model } : {}) };
}

/** Harnesses installed on this machine that can run midna's brain. */
export function installedBrains(): Array<{ id: string; label: string; installed: boolean; loginCommand: string; installHint: string }> {
  const hermes = { id: HERMES, label: "Hermes (its api_server on this machine)", installed: !hermesProblem(), loginCommand: "midna hermes setup", installHint: "run `midna hermes setup`" };
  return [...detectProviders(loadHostEngineConfig().providerConfig ?? {}).map(({ id, label, installed, loginCommand, installHint }) => ({ id, label, installed, loginCommand, installHint })), hermes];
}

/** Why `model` can't run here, or null when it can. */
export function checkModel(model: string): string | null {
  if (isHermes(model)) return hermesProblem();
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
  if (isHermes(run.model)) return hermesBrain(run);
  const { provider, model } = resolveModel(run.model);
  return provider === "claude" ? runClaude(run, model) : runHarness(run, provider, model);
};

async function runClaude(run: BrainRun, model: string | undefined): Promise<BrainResult> {
  if (run.signal?.aborted) throw new BrainError("claude turn interrupted before it started");
  const account = run.account ?? "work";
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
      // The account: CLAUDE_CONFIG_DIR set for personal, unset (whatever midna was started with) for work.
      env: { MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT), ...claudeEnv(account) },
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
  // A message the user sends meanwhile goes to the model mid-turn, as typing while Claude Code works does:
  // it is folded in between tool calls, or — sent too late for that — runs as a turn of its own after.
  // Each turn's reply counts, so the reply is all of them.
  const steering = run.inbox ? new Steering(run.inbox) : null;
  const replies: string[] = [];
  let finished = 0;
  let sessionCostUsd: number | undefined;
  let usage: TurnUsage | undefined;
  const reply = (): BrainResult => ({ text: replies.join("\n\n"), sessionId, ...(sessionCostUsd !== undefined ? { sessionCostUsd } : {}), ...(usage ? { usage } : {}) });
  try {
    const tagged = sendTagged(session, run.prompt, randomUUID());
    if (!tagged) session.send(run.prompt);
    // Untagged, nothing could say which turn read what: the assistant interrupts instead, as before.
    if (tagged && steering) {
      run.inbox!.open((m) => {
        const uuid = randomUUID();
        if (sendTagged(session, m.text, uuid)) steering.given(uuid, m.id);
      });
    }
    for await (const msg of session) {
      if ("session_id" in msg && msg.session_id) sessionId = msg.session_id;
      if (msg.type === "rate_limit_event") {
        const info = msg.rate_limit_info;
        resetsAt = resetTime(info.resetsAt) ?? resetsAt;
        if (info.status === "rejected") capped = { until: resetsAt };
      }
      if (msg.type === "assistant" && msg.error === "rate_limit") capped = { until: resetsAt };
      if (waiting && (msg.type === "assistant" || msg.type === "stream_event" || (msg.type === "system" && msg.subtype === "init"))) {
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
          finished++;
          if (msg.result.trim()) replies.push(msg.result.trim());
          sessionCostUsd = msg.total_cost_usd;
          usage = addUsage(usage, turnUsage(msg.usage));
          // A message it hasn't taken yet: Claude Code runs it next. Wait for that turn too.
          if (steering?.result(msg.user_message_uuids) && !run.signal?.aborted) {
            // This Claude Code doesn't say what a turn took: take no more mid-turn.
            if (!steering.tracked) run.inbox!.close();
            clearTimeout(waiting);
            waiting = setTimeout(() => session.close(), STEER_GRACE);
            continue;
          }
          return reply();
        }
        if (run.signal?.aborted) throw new BrainError("claude turn interrupted", sessionId);
        // A turn after the first, for a message sent mid-turn, failed: what came before still goes; the message waits.
        if (finished) return reply();
        if (capped) throw new BrainCappedError("claude", capped.until ?? resetsAt, sessionId, toolCalls, { account });
        const why = msg.subtype === "success" ? msg.result : msg.subtype;
        // Last resort, should the typed signals ever go missing: the limit's own wording.
        if (USAGE_LIMIT_TEXT.test(why)) throw new BrainCappedError("claude", resetsAt, sessionId, toolCalls, { account });
        throw new BrainError(`claude turn failed: ${why}`, sessionId);
      }
    }
    if (run.signal?.aborted) throw new BrainError("claude turn interrupted", sessionId);
    // The turn for a message sent mid-turn never came: the reply so far goes, and the message waits for the next turn.
    if (finished) return reply();
    if (capped) throw new BrainCappedError("claude", capped.until ?? resetsAt, sessionId, toolCalls, { account });
    // The prompt's turn never came: say nothing, and let the caller ask again.
    if (notice) return { text: "", sessionId, sessionCostUsd: notice.sessionCostUsd };
    throw new BrainError("claude session ended without a result", sessionId);
  } catch (err) {
    if (run.signal?.aborted && !(err instanceof BrainError)) throw new BrainError("claude turn interrupted", sessionId, { cause: err });
    if (finished && !(err instanceof BrainError)) return reply();
    if (capped && !(err instanceof BrainError)) throw new BrainCappedError("claude", capped.until ?? resetsAt, sessionId, toolCalls, { cause: err, account });
    if (notice && !(err instanceof BrainError)) return { text: "", sessionId, sessionCostUsd: notice.sessionCostUsd };
    throw err;
  } finally {
    run.inbox?.close();
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
    // device_* and job tools can outlast Codex's 60 s default per tool call
    mcpServers: { midna: { url: run.mcp.url, headers: { authorization: `Bearer ${run.mcp.token}` }, toolTimeoutSec: TOOL_TIMEOUT_SEC } },
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
