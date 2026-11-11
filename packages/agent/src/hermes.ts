import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { BrainError, type BrainResult, type BrainRun } from "./brain.ts";

/**
 * The Hermes brain (`midna model hermes`): midna's chat turns go to the Hermes
 * agent's api_server on this machine, which has midna's persona, memory and
 * tools (the Mac's hands through the midna-body MCP, the chat archive) and is
 * the one assistant the user talks to on Telegram too. midna stays the body:
 * pairing, the outbox and push, approvals and attachments.
 *
 * A turn is a Hermes run (`POST /v1/runs`) whose events stream back over SSE:
 * tool calls show as activity, an approval it asks for goes to the user like a
 * device approval, and an interrupt stops the run. The session id is Hermes's
 * session, so a resumed midna session is the same Hermes conversation.
 */

export const HERMES = "hermes";
const DEFAULT_URL = "http://127.0.0.1:8642";
/** How long one run may take, end to end, before midna gives up on it. */
const RUN_LIMIT = 30 * 60_000;
/** After the event stream drops, how often the run's status is polled instead. */
const POLL_EVERY = 2_000;
/** Text files at most this big go into the turn as text; Hermes can't open midna's files itself. */
const INLINE_TEXT_BYTES = 64 * 1024;
/** Images at most this big go into the turn as images. */
const INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

/** "hermes", or "hermes:<anything>" (the part after the colon is ignored: Hermes picks its own model). */
export function isHermes(model: string): boolean {
  return model === HERMES || model.startsWith(`${HERMES}:`);
}

function midnaHome(): string {
  if (process.env.MIDNA_HOME) return process.env.MIDNA_HOME;
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "midna");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "midna");
}

/** Where the api_server key is kept: midna's secrets, written by the Hermes installer. */
export function hermesKeyFile(): string {
  return process.env.MIDNA_HERMES_KEY_FILE ?? join(midnaHome(), "secrets", "hermes_api_server_key");
}

export function hermesEndpoint(): { url: string; key: string | null } {
  const url = (process.env.MIDNA_HERMES_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  const file = hermesKeyFile();
  const key = process.env.MIDNA_HERMES_KEY ?? (existsSync(file) ? readFileSync(file, "utf8").trim() || null : null);
  return { url, key };
}

/** Why Hermes can't be the brain here, or null when it can (the key is there; whether it answers is checkHermes). */
export function hermesProblem(): string | null {
  return hermesEndpoint().key ? null : `Hermes's api_server key isn't in ${hermesKeyFile()} — run \`midna hermes setup\` first`;
}

/** Whether the api_server answers, without spending a model turn. */
export async function checkHermes(signal?: AbortSignal): Promise<string | null> {
  const { url, key } = hermesEndpoint();
  if (!key) return hermesProblem();
  try {
    const r = await fetch(`${url}/v1/capabilities`, { headers: { authorization: `Bearer ${key}` }, signal: signal ?? AbortSignal.timeout(10_000) });
    if (r.status === 401 || r.status === 403) return `Hermes's api_server refused midna's key (HTTP ${r.status}) — run \`midna hermes setup\` again`;
    if (!r.ok) return `Hermes's api_server answered HTTP ${r.status}`;
    return null;
  } catch (err) {
    return `Hermes's api_server at ${url} can't be reached: ${(err as Error).message}`;
  }
}

/** A file the user sent with the turn, as midna keeps it. */
export interface TurnFile {
  name: string;
  mime: string;
  kind: "image" | "file";
  path: string | null;
}

/** What one run's event says; only the fields midna reads. */
interface RunEvent {
  event?: string;
  delta?: string;
  output?: string;
  error?: string;
  tool?: string;
  preview?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number };
  turn_exit_reason?: string;
  command?: string;
  description?: string;
  choices?: string[];
  [k: string]: unknown;
}

const TERMINAL = new Set(["run.completed", "run.failed", "run.cancelled", "run.interrupted"]);
const TERMINAL_STATUS = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** The turn's input: the prompt, then what came with it that Hermes can't open from midna's disk. */
export function hermesInput(prompt: string, files: TurnFile[] = []): string | Array<{ role: "user"; content: Array<Record<string, string>> }> {
  if (!files.length) return prompt;
  const content: Array<Record<string, string>> = [];
  const notes: string[] = [];
  for (const f of files) {
    const bytes = f.path && existsSync(f.path) ? statSync(f.path).size : -1;
    if (bytes < 0) notes.push(`"${f.name}": midna couldn't read it.`);
    else if (f.kind === "image" && /^image\/(png|jpe?g|gif|webp)$/i.test(f.mime) && bytes <= INLINE_IMAGE_BYTES) {
      content.push({ type: "input_image", image_url: `data:${f.mime.toLowerCase()};base64,${readFileSync(f.path!).toString("base64")}` });
      notes.push(`"${f.name}": attached as an image.`);
    } else if (bytes <= INLINE_TEXT_BYTES && isText(f.path!)) {
      notes.push(`"${f.name}" (its text):\n<<<\n${readFileSync(f.path!, "utf8")}\n>>>`);
    } else {
      notes.push(`"${f.name}" (${f.mime}, ${bytes} bytes): kept on midna's side only — you can't open it. Ask the user if you need what's in it.`);
    }
  }
  const text = `${prompt}\n\n[midna] The paths above are on midna's side and aren't readable from Hermes. What came with the message:\n${notes.join("\n")}`;
  return [{ role: "user", content: [{ type: "input_text", text }, ...content] }];
}

function isText(path: string): boolean {
  const buf = readFileSync(path);
  return !buf.includes(0) && !buf.toString("utf8").includes("�");
}

export const hermesBrain = async (run: BrainRun): Promise<BrainResult> => {
  const { url, key } = hermesEndpoint();
  if (!key) throw new BrainError(`hermes: ${hermesProblem()}`);
  if (run.signal?.aborted) throw new BrainError("hermes turn interrupted before it started", run.resume);
  const session = run.resume ?? `midna-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown, signal?: AbortSignal) => {
    const r = await fetch(`${url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: signal ?? AbortSignal.timeout(30_000) });
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {}
    return { status: r.status, json, text };
  };

  let created: Awaited<ReturnType<typeof call>>;
  try {
    created = await call("POST", "/v1/runs", {
      input: hermesInput(run.prompt, run.files),
      session_id: session,
      ...(run.systemPrompt ? { instructions: run.systemPrompt } : {}),
    });
  } catch (err) {
    throw new BrainError(`hermes turn failed: the api_server at ${url} can't be reached (${(err as Error).message})`, run.resume, { cause: err });
  }
  const runId = typeof created.json.run_id === "string" ? created.json.run_id : null;
  if (!runId) {
    const why = (created.json.error as { message?: string } | undefined)?.message ?? created.text.slice(0, 300);
    throw new BrainError(`hermes turn failed: HTTP ${created.status}: ${why}`, run.resume);
  }

  const done = new AbortController();
  const limit = setTimeout(() => done.abort(), RUN_LIMIT);
  const onAbort = () => {
    void call("POST", `/v1/runs/${runId}/stop`, {}).catch(() => {});
  };
  run.signal?.addEventListener("abort", onAbort, { once: true });
  let reply = "";
  let end: RunEvent | null = null;
  const answering = new Set<string>();

  const approve = async (e: RunEvent) => {
    const what = String(e.description || e.command || e.tool || "do something that needs your OK").slice(0, 300);
    const choice = run.onApproval ? await run.onApproval({ summary: what, tool: typeof e.tool === "string" ? e.tool : undefined }).catch(() => "deny" as const) : "deny";
    // The exact prompt and generation the run waits on, as its status shows them.
    const st = await call("GET", `/v1/runs/${runId}`);
    const pending = (st.json.pending_controls as Array<{ prompt_id?: string; kind?: string }> | undefined) ?? [];
    const generation = st.json.execution_generation;
    const asks = pending.filter((p) => p.kind === "approval" && p.prompt_id && !answering.has(p.prompt_id));
    if (asks.length && typeof generation === "number") {
      for (const p of asks) {
        answering.add(p.prompt_id!);
        await call("POST", `/v1/runs/${runId}/approval`, { request_id: p.prompt_id, execution_generation: generation, choice });
      }
    } else {
      await call("POST", `/v1/runs/${runId}/approval`, { choice });
    }
  };

  const onEvent = (e: RunEvent) => {
    switch (e.event) {
      case "message.delta":
        reply += e.delta ?? "";
        break;
      case "tool.started":
        run.onActivity?.(String(e.tool ?? "tool").replace(/^mcp_midna[-_]body_/, ""), typeof e.preview === "string" && e.preview.trim() ? e.preview.trim().slice(0, 100) : undefined);
        reply = ""; // the reply is what comes after the last tool call
        break;
      case "approval.request":
        void approve(e).catch((err) => console.error(`[midna] hermes: answering an approval failed:`, (err as Error).message));
        break;
      default:
        if (e.event && TERMINAL.has(e.event)) end = e;
    }
  };

  try {
    try {
      const r = await fetch(`${url}/v1/runs/${runId}/events`, { headers: { authorization: `Bearer ${key}`, accept: "text/event-stream" }, signal: done.signal });
      if (r.ok && r.body) {
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          for (let i: number; (i = buf.indexOf("\n\n")) >= 0; ) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (!data) continue;
            try {
              onEvent(JSON.parse(data) as RunEvent);
            } catch {}
          }
          if (end) break;
        }
      }
    } catch (err) {
      if (!done.signal.aborted) console.error(`[midna] hermes: event stream for ${runId} dropped (${(err as Error).message}); polling instead`);
    }
    // The stream dropped (or never opened): the run's status says how it ended.
    while (!end && !done.signal.aborted) {
      const st = await call("GET", `/v1/runs/${runId}`).catch(() => null);
      const status = typeof st?.json.status === "string" ? st.json.status : "";
      if (TERMINAL_STATUS.has(status)) {
        end = { event: `run.${status}`, output: typeof st!.json.output === "string" ? st!.json.output : reply, usage: st!.json.usage as RunEvent["usage"] };
        break;
      }
      if (st?.status === 404) throw new BrainError(`hermes turn failed: run ${runId} is gone`, session);
      await Bun.sleep(POLL_EVERY);
    }
    const ended = end as RunEvent | null;
    if (!ended) throw new BrainError(run.signal?.aborted ? "hermes turn interrupted" : `hermes turn failed: no answer within ${RUN_LIMIT / 60_000} min`, session);
    const text = (typeof ended.output === "string" && ended.output.trim() ? ended.output : reply).trim();
    if (ended.event === "run.cancelled" || ended.event === "run.interrupted" || run.signal?.aborted) {
      throw new BrainError("hermes turn interrupted", session);
    }
    // A run that ran out of steps still answers with what it found: that is a reply.
    if (ended.event === "run.failed" && !(text && ended.turn_exit_reason)) {
      throw new BrainError(`hermes turn failed: ${ended.error ?? (text || "no reason given")}`, session);
    }
    const u = ended.usage;
    return {
      text,
      sessionId: session,
      ...(u && typeof u.input_tokens === "number"
        ? { usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_tokens ?? 0, cache_creation_input_tokens: u.cache_write_tokens ?? 0 } }
        : {}),
    };
  } finally {
    clearTimeout(limit);
    done.abort();
    run.signal?.removeEventListener("abort", onAbort);
  }
};
