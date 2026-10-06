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
  onActivity?: (tool: string) => void;
  signal?: AbortSignal;
}

export interface BrainResult {
  /** The final reply: what the model said after its last tool call. */
  text: string;
  sessionId?: string;
  costUsd?: number;
}

export type Brain = (run: BrainRun) => Promise<BrainResult>;

export class BrainError extends Error {
  constructor(message: string, readonly sessionId?: string) {
    super(message);
  }
}

/** Tools allowed in "ask" mode without the user: they only read, or only touch midna's own state. */
const ASK_MODE_SAFE = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "LS", "NotebookRead"]);
const ASK_MODE_DENIAL =
  "midna is in ask mode: this action needs the user's approval. Describe exactly what you want to do with ask_user, and do it in a later turn once they approve.";

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
      ...(run.mode === "autonomous" ? { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } : {}),
    },
  });
  const onAbort = () => void session.interrupt().catch(() => {});
  run.signal?.addEventListener("abort", onAbort, { once: true });
  let sessionId: string | undefined;
  try {
    session.send(run.prompt);
    for await (const msg of session) {
      if ("session_id" in msg && msg.session_id) sessionId = msg.session_id;
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") run.onActivity?.(block.name.replace(/^mcp__midna__/, ""));
        }
      }
      if (msg.type === "result") {
        if (msg.subtype === "success" && !msg.is_error) {
          return { text: msg.result, sessionId, costUsd: msg.total_cost_usd };
        }
        const why = msg.subtype === "success" ? msg.result : msg.subtype;
        throw new BrainError(`claude turn failed: ${why}`, sessionId);
      }
    }
    throw new BrainError("claude session ended without a result", sessionId);
  } finally {
    run.signal?.removeEventListener("abort", onAbort);
    session.close();
  }
}

async function runHarness(run: BrainRun, providerId: string, model: string | undefined): Promise<BrainResult> {
  const host = loadHostEngineConfig();
  const provider = createProvider(providerId, host.providerConfig?.[providerId] ?? {}, { appName: "midna" });
  if (!isSessionProvider(provider)) throw new BrainError(`${providerId} can't host an agent session`);
  const permissions: SessionPermissionHandler = {
    decide: async (req) => {
      if (run.mode === "autonomous") return "allow";
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
  let costUsd: number | undefined;
  try {
    for await (const ev of session.send(run.prompt)) {
      if (ev.type === "text" && !ev.thread) reply += ev.text;
      else if (ev.type === "tool_call" && !ev.thread && ev.status === "started") {
        run.onActivity?.(ev.name.replace(/^(mcp__midna__|midna[.:/])/, ""));
        reply = ""; // the reply is what comes after the last tool call
      } else if (ev.type === "done") costUsd = ev.costUsd;
    }
    return { text: reply.trim(), sessionId: session.id, costUsd };
  } catch (err) {
    throw new BrainError(`${providerId} turn failed: ${(err as Error).message}`, session.id);
  } finally {
    run.signal?.removeEventListener("abort", onAbort);
    await session.close().catch(() => {});
  }
}
