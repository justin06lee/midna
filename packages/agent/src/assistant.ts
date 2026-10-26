import { existsSync, readFileSync, statSync } from "node:fs";
import { MAIN, HOUR, contextSections, fmt, logTail, pinnedFacts, renderNow, type ContextSection, type Message, type Store, type Wakeup } from "@midna/core";
import { EVENT_WINDOW_MS, type Attachment, type BrainHealth, type EventReceipt, type InReplyTo, type ReplyFallback, type ReplyRef } from "@midna/protocol";
import { liftLocalImages, workspaceCopy } from "./attachments.ts";
import { BrainCappedError, BrainError, resolveModel, yagamiBrain, type Brain } from "./brain.ts";
import { brainProblem, checkBrainLive, howToSignIn, type BrainProblem } from "./check.ts";
import type { HandsHandle } from "./hands.ts";
import { INTRODUCTION, devicesSection, eventsTask, jobTask, ownTask, replyNote, stateNote, systemPrompt, took, wakeupPrompt, wakeupsPrompt, type Environment } from "./prompt.ts";

export interface AssistantOptions {
  store: Store;
  env: Environment;
  /** The MCP endpoint for an episode, and the token that opens it. */
  mcp: { url: (episodeId: number) => string; token: string };
  brain?: Brain;
  /** How many model sessions may run at once (subscriptions have rate limits). */
  concurrency?: number;
  /** Messages this close together make one interrupt; tests make it short. */
  coalesceMs?: number;
  /** The user's computers that offer their hands, for the prompt to name. */
  hands?: HandsHandle;
}

/** How long to wait before retrying work the brain couldn't do, and how often to say so. */
const BRAIN_RETRY = 15 * 60_000;
const BRAIN_ALERT_EVERY = 6 * HOUR;
/** A chat brain session is started over after this long idle, or this many turns. */
const SESSION_IDLE = 4 * HOUR;
const SESSION_TURNS = 40;
const HISTORY_ON_FRESH = 20;
/** When a chat turn ends without a word to the user even after asking again, a follow-up answers it this soon. */
const NO_REPLY_FOLLOWUP = 60_000;
/** Messages this close together are one interrupt: the turn after it waits until the user has paused this long. */
const COALESCE = 3_000;
/** A wakeup set aside for the user's message carries on this soon after. */
const WAKEUP_RESUME = 60_000;
/** After a restart, what the user wrote this recently and never got a reply to is answered. */
const LEFTOVER_WINDOW = 6 * HOUR;
/** How many brain sessions' last-seen state is kept, so their next turn gets only what changed. */
const STATE_SESSIONS_KEPT = 200;

/** "/queue …" waits for the turn in progress instead of interrupting it. */
export const QUEUE_PREFIX = /^\/queue(?:@\w+)?(?:\s+|$)/i;

/** A model session in flight, and what it is doing, so the user's next message can interrupt it. */
interface Turn {
  abort: AbortController;
  startedAt: number;
  /** Whether the brain got going at all, rather than waiting for a slot. */
  ran: boolean;
  /** The tool call it is in the middle of, in a few words. */
  doing: string | null;
  tools: number;
  /** For a wakeup: why it runs. */
  reason?: string;
}

/** What a conversation's next turn hears about work that was cut short for it. */
type Interruption =
  | { by: "user"; ms: number; doing: string | null; tools: number; /** its session was kept, to carry on in */ kept: boolean }
  | { by: "wakeup"; reason: string; doing: string | null }
  | { by: "restart" };

/**
 * A reply that says nothing: empty, or what a model writes when it took the
 * turn for an automated event ("No response requested.").
 */
export function isNoReply(text: string): boolean {
  const t = text.trim().replace(/^[*_`"']+|[*_`"'.!]+$/g, "").trim();
  return !t || /^(no (response|reply) (is )?(requested|needed|required)|nothing to (say|reply|add)|no reply)$/i.test(t);
}

/**
 * The orchestrator. It turns user messages into chat turns and due wakeups
 * into episodes, keeps one brain session warm per conversation, and makes
 * sure the chat brain hears about anything midna said on its own.
 */
export class Assistant {
  private readonly store: Store;
  private readonly brain: Brain;
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private slots: number;
  private readonly waiting: Array<() => void> = [];
  private readonly aborts = new Set<AbortController>();
  /** The chat turn running in each conversation, and the wakeups running, for the user's next message to interrupt. */
  private readonly turns = new Map<string, Turn>();
  private readonly wakeups = new Map<number, Turn>();
  /** What each conversation's next turn should hear about work cut short for it. */
  private readonly interruptions = new Map<string, Interruption[]>();
  /** Wakeups set aside for the user, with the session that holds how far they got. */
  private readonly paused = new Map<number, { session?: string; doing: string | null }>();
  /** The working context each brain session last saw, section by section, as of its last finished turn. */
  private readonly stateSeen = new Map<string, Map<string, string>>();
  private readonly lastUserAt = new Map<string, number>();
  private readonly coalesce: number;
  private stopping = false;
  /** Can midna think right now, as of the last thing that tried? */
  private health: BrainHealth = { ok: null, checkedAt: null };
  /** Wakeups put off because the brain couldn't be reached; they run as soon as it can. */
  private readonly blocked = new Set<number>();

  constructor(private readonly opts: AssistantOptions) {
    this.store = opts.store;
    this.brain = opts.brain ?? yagamiBrain;
    this.slots = opts.concurrency ?? 2;
    this.coalesce = opts.coalesceMs ?? COALESCE;
  }

  get busy(): boolean {
    return this.running.size > 0;
  }

  /**
   * A message from the user, from any client, with the ids of anything they
   * uploaded to go with it. It interrupts whatever midna is doing — the turn
   * in progress in its conversation, and any wakeup — to be answered at
   * once; one that starts with /queue waits for the turn in progress.
   */
  receive(m: { text: string; client: string; conversationId?: string; replyTo?: number; attachments?: string[]; inReplyTo?: InReplyTo }): { conversationId: string; messageId: number } {
    const conv = m.conversationId ?? MAIN;
    const queued = QUEUE_PREFIX.test(m.text);
    const text = queued ? m.text.replace(QUEUE_PREFIX, "") : m.text;
    const question = m.replyTo ? this.store.outbox.get(m.replyTo) : null;
    if (question) this.store.outbox.answered(question.id);
    const inReplyTo = m.inReplyTo ? this.replyRef(conv, m.inReplyTo) : null;
    const msg = this.store.log.addMessage({ conversationId: conv, role: "user", text, client: m.client, seen: false, ...(question ? { replyTo: question.id } : {}), inReplyTo });
    const attachments = m.attachments?.length ? this.store.attachments.link(m.attachments, { messageId: msg.id }) : [];
    this.store.bus.emit({ type: "user_message", id: msg.id, conversationId: conv, text, client: m.client, createdAt: msg.created_at, replyTo: question?.id ?? null, attachments, inReplyTo });
    this.lastUserAt.set(conv, Date.now());
    if (!queued) this.interrupt(conv);
    this.kick(conv);
    return { conversationId: conv, messageId: msg.id };
  }

  /** A native reply as kept: the line it names in this conversation, else what the client knew of it, else nothing. */
  private replyRef(conv: string, r: InReplyTo): ReplyRef | null {
    const messageId = this.store.log.resolveReply(conv, { ...(r.messageId !== undefined ? { messageId: r.messageId } : {}), ...(r.outboxId !== undefined ? { outboxId: r.outboxId } : {}) });
    if (messageId === null && !r.fallback) return null;
    return { messageId, quote: r.quote?.trim() || null, fallback: messageId === null ? (r.fallback ?? null) : null };
  }

  /** The note before a user's words saying which earlier line they replied to; none when it isn't a reply, or it only repeats the question it answers. */
  private replied(m: Message, tz: string): string | undefined {
    const { store } = this;
    if (m.role !== "user") return undefined;
    if (m.in_reply_to !== null) {
      const t = store.log.get(m.in_reply_to);
      if (!t) return undefined;
      // A reply to the very question it answers is said once, as "answering your question".
      if (m.reply_to !== null && t.outbox_id === m.reply_to) return undefined;
      const item = t.outbox_id ? store.outbox.get(t.outbox_id) : null;
      const files = (t.outbox_id ? store.attachments.forOutbox([t.outbox_id]).get(t.outbox_id) : store.attachments.forMessages([t.id]).get(t.id)) ?? [];
      return replyNote({
        from: t.role,
        at: fmt(t.created_at, tz),
        text: item?.text ?? t.text,
        quote: m.reply_quote,
        files: files.map((f) => f.name),
        options: item?.kind === "question" ? (item.options ?? []) : null,
      });
    }
    if (!m.reply_fallback) return undefined;
    const f = JSON.parse(m.reply_fallback) as ReplyFallback;
    return replyNote({ from: f.from, at: f.at ? fmt(f.at, tz) : null, text: f.text, quote: m.reply_quote, files: f.files ?? [], options: null });
  }

  /**
   * An event from another program — ruri saying a project went idle, say —
   * for midna to hear in the background. It is delivered by a wakeup, never
   * as user input, so it interrupts nothing. The same id counts once, and a
   * source gets at most one wakeup per subject (data.project) in each
   * window: what comes meanwhile is merged into the wakeup still waiting.
   */
  hear(e: { source: string; title: string; id?: string; data?: unknown }): EventReceipt {
    const data = e.data as { id?: unknown; kind?: unknown; project?: { id?: unknown; path?: unknown; name?: unknown } } | null | undefined;
    const word = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
    const extId = e.id ?? word(data?.id);
    const subject = word(data?.project?.id) ?? word(data?.project?.path) ?? word(data?.project?.name);
    const kind = word(data?.kind);
    const r = this.store.inbound.add({
      source: e.source,
      title: e.title,
      windowMs: EVENT_WINDOW_MS,
      tz: this.store.settings().timezone,
      ...(extId ? { extId } : {}),
      ...(subject ? { subject } : {}),
      ...(kind ? { kind } : {}),
      ...(e.data !== undefined ? { data: JSON.stringify(e.data) } : {}),
    });
    console.log(`[midna] event from ${e.source}${subject ? ` about ${subject}` : ""}: ${e.title.slice(0, 80)} — ${r.status}`);
    return r;
  }

  /**
   * The user wrote: stop what midna is doing so their message is answered
   * now. Only the user interrupts — a wakeup or notification never cuts a
   * chat turn short.
   */
  private interrupt(conv: string): void {
    this.turns.get(conv)?.abort.abort();
    for (const w of this.wakeups.values()) {
      if (w.abort.signal.aborted) continue;
      w.abort.abort();
      // Said now: the turn that answers the user starts before the wakeup has wound down.
      if (w.ran) this.note(conv, { by: "wakeup", reason: w.reason!, doing: w.doing });
    }
  }

  /** Run the conversation until nothing is left unread; messages arriving mid-turn are batched into the next. */
  private kick(conv: string): void {
    if (this.running.has(conv)) {
      this.again.add(conv);
      return;
    }
    const loop = (async () => {
      let r: "interrupted" | void;
      do {
        this.again.delete(conv);
        r = await this.chatTurn(conv).catch((err) => console.error(`[midna] chat turn failed:`, err));
        // The message that interrupted it may be the first of a few: answer them together.
        if (r === "interrupted") await this.lull(conv);
      } while (this.again.has(conv) && !this.stopping);
      // An interrupted turn leaves "thinking" up for the turn after it; with none to come, take it down.
      if (r === "interrupted") this.store.bus.emit({ type: "status", conversationId: conv, state: "idle" });
    })().finally(() => this.running.delete(conv));
    this.running.set(conv, loop);
  }

  /** Wait until the user has paused for a moment. */
  private async lull(conv: string): Promise<void> {
    for (let wait: number; !this.stopping && (wait = (this.lastUserAt.get(conv) ?? 0) + this.coalesce - Date.now()) > 0; ) {
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  /** Something the conversation's next turn should hear; a newer note of the same kind replaces the older. */
  private note(conv: string, n: Interruption): void {
    const same = (o: Interruption) => o.by === n.by && (n.by !== "wakeup" || (o as typeof n).reason === n.reason);
    this.interruptions.set(conv, [...(this.interruptions.get(conv) ?? []).filter((o) => !same(o)), n]);
  }

  /** Wait for every running conversation to settle (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all(this.running.values());
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.slots === 0) await new Promise<void>((r) => this.waiting.push(r));
    else this.slots--;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.slots++;
    }
  }

  /**
   * Answer what the user wrote. Their messages count as handled only once
   * the turn is over and they got an answer: a turn that fails, or that
   * their next message interrupts, leaves them for the next turn, which
   * answers them all. A turn that ends without a word to the user — Claude
   * Code can put a background-task notification in front of their message,
   * and the model answers that instead — is asked again, once, plainly; if
   * that still says nothing, the user hears their message arrived and a
   * follow-up answers it.
   */
  private async chatTurn(conv: string): Promise<"interrupted" | void> {
    const { store } = this;
    const unseen = store.log.unseen(conv);
    const asked = unseen.filter((m) => m.role === "user");
    if (!asked.length) return; // only midna's own news: nothing to answer yet

    const settings = store.settings();
    const convo = store.log.conversation(conv);
    const previous = store.log.recent(conv, 1, unseen[0]!.id)[0];
    const now = Date.now();
    const notes = this.interruptions.get(conv) ?? [];
    // The model, or while its provider is at its usage limit a fallback; none while every one is.
    const active = this.activeModel(now);
    if (!active) return this.capOut(conv, unseen, notes);
    let model = active;
    // A turn the user cut short a moment ago carries on in its own session, whose transcript holds what it did.
    const carryOn = notes.some((n) => n.by === "user" && n.kept);
    const stale =
      !convo.brain_session ||
      convo.brain_model !== model ||
      (!carryOn && (convo.brain_turns >= SESSION_TURNS || !previous || now - previous.created_at > SESSION_IDLE));

    const turn: Turn = { abort: new AbortController(), startedAt: now, ran: false, doing: null, tools: 0 };
    this.turns.set(conv, turn);
    let interrupted = false;
    let fresh = stale;
    let turns = fresh ? 0 : convo.brain_turns;
    const keep = (session: string | null | undefined) => {
      store.log.setBrain(conv, { model, session: session ?? null, startedAt: fresh ? now : convo.brain_started_at, turns });
    };
    store.bus.emit({ type: "status", conversationId: conv, state: "thinking" });
    // A brain cut off by its limit after it had used tools: the one taking over checks before redoing them.
    let cutOff: string | undefined;
    try {
      const run = async (fresh: boolean) => {
        const history = fresh ? store.log.recent(conv, HISTORY_ON_FRESH, unseen[0]!.id) : [];
        const sent = store.attachments.forMessages([...history, ...unseen].filter((m) => m.role === "user").map((m) => m.id));
        const files = (m: Message) => (sent.get(m.id) ?? []).map((a) => ({ ...a, path: workspaceCopy(store, this.opts.env.workspace, a) }));
        const prompt = turnPrompt(unseen, history, settings.timezone, now, (id) => store.outbox.get(id)?.text, files, (m) => this.replied(m, settings.timezone), [...notes.map((n) => interruptionNote(n, !fresh)), ...(cutOff ? [cutOff] : [])]);
        return this.episode({ kind: "chat", conversationId: conv, prompt, model, resume: fresh ? undefined : convo.brain_session!, turn });
      };
      let result: Awaited<ReturnType<typeof run>>;
      for (;;) {
        try {
          result = await run(fresh);
          break;
        } catch (err) {
          if (turn.abort.signal.aborted) throw err;
          const p = brainProblem(err);
          if (p?.reason === "capped") {
            // At its limit: the same turn again at once on the fallback, fresh with history, as a model change does.
            const next = this.capped(p, "chat");
            if (!next || next === model) throw err;
            cutOff = capNote(model, err) ?? cutOff;
            console.log(`[midna] ${model} is at its usage limit; ${conv} carries on with ${next}`);
            model = next;
          } else if (fresh) throw err;
          // The saved session may be gone (harness updated, cache cleared): start over with history.
          else console.error(`[midna] resuming ${conv} failed, starting fresh:`, (err as Error).message);
          fresh = true;
          turns = 0;
        }
      }
      turns++;
      keep(result.sessionId);
      // What the brain attached during the turn, and any Markdown image of a file on this machine, go with the reply.
      const replyOf = (r: typeof result) => ({ ...liftLocalImages(store, r.text.trim(), { episodeId: r.episodeId }), attachments: store.attachments.staged(r.episodeId), episodeId: r.episodeId });
      // A question or message sent with ask_user/message_user during the turn answers the user too.
      const answered = (r: ReturnType<typeof replyOf>) => !isNoReply(r.text) || r.attachments.length > 0 || store.log.toolsUsed(r.episodeId).some((t) => t === "ask_user" || t === "message_user");
      let reply = replyOf(result);
      if (!answered(reply)) {
        console.error(`[midna] chat turn in ${conv} ended without a reply to the user (${JSON.stringify(result.text.trim().slice(0, 80))}); asking again`);
        const session = result.sessionId ?? convo.brain_session ?? undefined;
        const again = await this.episode({ kind: "chat", conversationId: conv, prompt: askAgainPrompt(asked, settings.timezone), model, resume: session, turn });
        turns++;
        keep(again.sessionId ?? session);
        reply = replyOf(again);
      }
      if (answered(reply)) {
        if (reply.text && !isNoReply(reply.text) || reply.attachments.length) store.say({ kind: "message", conversationId: conv, text: isNoReply(reply.text) ? "" : reply.text, attachments: reply.attachments }, { client: "chat", seenByBrain: true });
      } else {
        console.error(`[midna] chat turn in ${conv} still ended without a reply; telling the user and following up`);
        store.say({ kind: "message", conversationId: conv, text: "Got your message — I'm on it, and I'll reply shortly." }, { client: "fallback", seenByBrain: true });
        const quoted = asked.map((m) => `[${fmt(m.created_at, settings.timezone)}${m.client ? ` via ${m.client}` : ""}] "${m.text.slice(0, 1500)}"`).join("\n");
        store.schedule.add({ dueAt: Date.now() + NO_REPLY_FOLLOWUP, reason: `Answer the user: their chat message got no reply from you (only "Got your message — I'm on it"). They wrote:\n${quoted}`, kind: "followup", createdBy: "system", tz: settings.timezone });
      }
      store.log.markSeen(unseen.map((m) => m.id));
      this.heard(conv, notes);
    } catch (err) {
      if (turn.abort.signal.aborted) {
        // Cut short by the user's next message, or by midna stopping: nothing to report, and the
        // messages wait for the next turn. Its session holds what the turn did; keep it.
        const session = (err as BrainError).sessionId;
        if (session) {
          turns++;
          keep(session);
        }
        if (turn.ran && !this.stopping) this.note(conv, { by: "user", ms: Date.now() - turn.startedAt, doing: turn.doing, tools: turn.tools, kept: !!session || !fresh });
        console.log(`[midna] chat turn in ${conv} interrupted${this.stopping ? " (stopping)" : " by a new message"}${turn.doing ? ` during ${turn.doing}` : ""}`);
        interrupted = true;
        return "interrupted";
      }
      const p = brainProblem(err);
      if (p?.reason === "capped") {
        this.capped(p, "chat");
        this.capOut(conv, unseen, notes);
        return;
      }
      const why =
        p?.reason === "signed_out"
          ? `my brain (${model}) isn't signed in on ${this.opts.env.hostName}. To sign in, ${howToSignIn(p.loginCommand)} — then ask me again.`
          : p?.reason === "not_installed"
            ? `my brain (${model}) isn't installed on ${this.opts.env.hostName}: ${p.installHint}`
            : err instanceof BrainError
              ? err.message
              : String(err);
      store.say({ kind: "message", conversationId: conv, text: `I couldn't finish that — ${why}` }, { client: "error", seenByBrain: false });
      this.heard(conv, notes);
    } finally {
      this.turns.delete(conv);
      if (!interrupted) store.bus.emit({ type: "status", conversationId: conv, state: "idle" });
    }
  }

  /** The notes a finished turn was given are spent; any that came in since stay for the next. */
  private heard(conv: string, notes: Interruption[]): void {
    const left = (this.interruptions.get(conv) ?? []).filter((n) => !notes.includes(n));
    if (left.length) this.interruptions.set(conv, left);
    else this.interruptions.delete(conv);
  }

  /** One model session, start to finish, recorded as an episode. */
  private async episode(e: { kind: "chat" | "wakeup"; conversationId?: string; wakeupId?: number; prompt: string; model: string; resume?: string; turn?: Turn }) {
    const { store, opts } = this;
    return this.slot(async () => {
      const abort = e.turn?.abort ?? new AbortController();
      // Interrupted while it waited for a slot: it never starts.
      if (abort.signal.aborted) throw new BrainError("interrupted before it started");
      if (e.turn) e.turn.ran = true;
      const settings = store.settings();
      const episodeId = store.log.startEpisode({ kind: e.kind, conversationId: e.conversationId, wakeupId: e.wakeupId, model: e.model });
      // The system prompt stays byte for byte the same, so the prompt cache keeps it and the session's
      // transcript after it; what changes turn by turn ends the turn's prompt instead.
      const now = Date.now();
      const devices = opts.hands?.devices() ?? [];
      const state = [...contextSections(store, now), { title: "The user's computers", body: devicesSection(devices) }];
      this.aborts.add(abort);
      try {
        const result = await this.brain({
          prompt: `${e.prompt}\n\n${stateNote(renderNow(store, now), state, e.resume ? this.stateSeen.get(e.resume) : undefined)}`,
          systemPrompt: systemPrompt(settings, opts.env, { pinned: pinnedFacts(store), hands: devices.length > 0 }),
          model: e.model,
          resume: e.resume,
          cwd: opts.env.workspace,
          mcp: { url: opts.mcp.url(episodeId), token: opts.mcp.token },
          mode: settings.mode,
          signal: abort.signal,
          onActivity: (tool, detail) => {
            if (e.turn) {
              e.turn.doing = detail ? `${tool} (${detail})` : tool;
              e.turn.tools++;
            }
            store.bus.emit({ type: "activity", conversationId: e.conversationId ?? null, tool });
          },
        });
        const u = result.usage;
        store.log.endEpisode(episodeId, {
          session: result.sessionId,
          ...(result.sessionCostUsd !== undefined ? { sessionCostUsd: result.sessionCostUsd } : {}),
          ...(u ? { tokens: { input: u.input_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens } } : {}),
        });
        this.healthy();
        if (result.sessionId) this.sawState(result.sessionId, state);
        return { ...result, episodeId };
      } catch (err) {
        // What the cut-off turn had already done, for the brain that takes over.
        if (err instanceof BrainCappedError) err.tools = store.log.toolsUsed(episodeId);
        const why = !abort.signal.aborted ? String((err as Error).message ?? err) : this.stopping ? "interrupted: midna stopped" : "interrupted by a message from the user";
        store.log.endEpisode(episodeId, { session: (err as BrainError).sessionId, error: why });
        throw err;
      } finally {
        this.aborts.delete(abort);
      }
    });
  }

  /** A session's turn finished having seen this state; its next turn hears only what changes from it. */
  private sawState(session: string, state: ContextSection[]): void {
    this.stateSeen.delete(session);
    this.stateSeen.set(session, new Map(state.map((x) => [x.title, x.body])));
    if (this.stateSeen.size > STATE_SESSIONS_KEPT) this.stateSeen.delete(this.stateSeen.keys().next().value!);
  }

  /**
   * Do what a due wakeup calls for — with any that came due within minutes of
   * it (`joined`), in one turn. A wakeup that failed only because the brain
   * can't be reached is retried later rather than lost; one the user's
   * message interrupted carries on soon after, in its own session. The
   * outcome is every joined wakeup's too.
   */
  async wakeup(first: Wakeup, joined: Wakeup[] = []): Promise<"done" | "failed" | { retryAt: number }> {
    const { store } = this;
    const tz = store.settings().timezone;
    const all = [first, ...joined];
    // One the user's message set aside leads, so its session carries on.
    const w = all.find((x) => this.paused.has(x.id)) ?? first;
    const rest = all.filter((x) => x !== w);
    const turn: Turn = { abort: new AbortController(), startedAt: Date.now(), ran: false, doing: null, tools: 0, reason: w.reason };
    const paused = this.paused.get(w.id);
    for (const x of all) this.paused.delete(x.id);
    try {
      if (w.kind === "reminder") {
        // A reminder the user set for a time is meant to buzz at that time.
        store.say({ kind: "notification", text: `⏰ ${w.reason}`, priority: "urgent", conversationId: MAIN }, { client: "reminder", seenByBrain: false });
        return "done";
      }
      if (w.kind === "system") {
        this.maintenance(w.reason);
        return "done";
      }
      // While every model is at its usage limit, it waits for the first to reset rather than failing.
      const active = this.activeModel();
      if (!active) return { retryAt: this.capsUntil() };
      let model = active;
      this.wakeups.set(w.id, turn);
      if (rest.length) store.schedule.joined(w.id, rest.map((x) => x.id));
      const prompt = (resume?: string) => {
        const resumed = paused ? { resumed: { doing: paused.doing, transcript: !!resume } } : {};
        if (!rest.length) {
          const task = this.taskOf(w, tz);
          return wakeupPrompt(w.reason, w.kind, fmt(w.due_at, tz), { ...(task ? { task } : {}), ...resumed });
        }
        const items = all.map((x) => ({
          id: x.id,
          scheduledFor: fmt(x.due_at, tz),
          early: x.fired_at !== null && x.due_at > x.fired_at ? took(x.due_at - x.fired_at) : null,
          task: this.taskOf(x, tz) ?? ownTask(x.reason, x.kind, fmt(x.due_at, tz)),
        }));
        return wakeupsPrompt(items, { ...resumed });
      };
      // A brain cut off by its limit after it had used tools: the one taking over checks before redoing them.
      let cutOff: string | undefined;
      const run = (resume?: string) => this.episode({ kind: "wakeup", wakeupId: w.id, prompt: `${cutOff ? `${cutOff}\n\n` : ""}${prompt(resume)}`, model, resume, turn });
      let result: Awaited<ReturnType<typeof run>> | undefined;
      let resume = paused?.session;
      while (!result) {
        try {
          result = await run(resume);
        } catch (err) {
          if (turn.abort.signal.aborted) throw err;
          const p = brainProblem(err);
          if (p?.reason === "capped") {
            // At its limit: the same wakeup again at once on the fallback, in a session of its own.
            const next = this.capped(p, "wakeup");
            if (!next || next === model) throw err;
            cutOff = capNote(model, err) ?? cutOff;
            console.log(`[midna] ${model} is at its usage limit; wakeup #${w.id} carries on with ${next}`);
            model = next;
          } else if (!resume) throw err;
          resume = undefined; // its session is gone, or belongs to another model: start it over
        }
      }
      const with_ = rest.length ? ` with ${rest.map((x) => `#${x.id}`).join(", ")}` : "";
      if (result.text) console.log(`[midna] wakeup #${w.id}${with_} (${w.reason.slice(0, 60)}): ${result.text.slice(0, 200)}`);
      return "done";
    } catch (err) {
      if (turn.abort.signal.aborted) {
        // Set aside for the user (or for midna stopping): it picks up from where it got to.
        const session = (err as BrainError).sessionId ?? paused?.session;
        this.paused.set(w.id, { ...(session ? { session } : {}), doing: turn.doing ?? paused?.doing ?? null });
        console.log(`[midna] wakeup #${w.id} set aside${this.stopping ? " (stopping)" : " for the user's message"}`);
        return { retryAt: Date.now() + (this.stopping ? 0 : WAKEUP_RESUME) };
      }
      console.error(`[midna] wakeup #${w.id} failed:`, (err as Error).message);
      const p = brainProblem(err);
      if (p?.reason === "capped") {
        this.capped(p, "wakeup");
        return { retryAt: this.activeModel() ? Date.now() + 5_000 : this.capsUntil() };
      }
      if (this.brainTrouble(err)) {
        for (const x of all) this.blocked.add(x.id);
        return { retryAt: Date.now() + BRAIN_RETRY };
      }
      return "failed";
    } finally {
      this.wakeups.delete(w.id);
    }
  }

  /** What a wakeup that another program caused is about: the events it delivers, or how a job ended. */
  private taskOf(w: Wakeup, tz: string): string | undefined {
    const { store } = this;
    const heard = store.inbound.forWakeup(w.id);
    if (heard.length) return eventsTask(heard.map((e) => ({ ...e, at: fmt(e.received_at, tz) })));
    const job = store.jobs.forWakeup(w.id);
    if (!job) return undefined;
    return jobTask(job, {
      started: fmt(job.started_at, tz),
      ended: fmt(job.ended_at ?? w.due_at, tz),
      ran: (job.ended_at ?? w.due_at) - job.started_at,
      tail: logTail(job.log_path),
      result: job.result_path && existsSync(job.result_path) ? resultOf(job.result_path) : null,
    });
  }

  /**
   * When the brain is signed out or missing, say so — the outbox needs no
   * brain — at most every few hours, and report that it was brain trouble.
   */
  private brainTrouble(err: unknown): boolean {
    const p = brainProblem(err);
    if (!p || p.reason === "capped") return false;
    this.health = {
      ok: false,
      checkedAt: Date.now(),
      reason: p.reason,
      message: (err as Error).message,
      ...(p.reason === "signed_out" ? { loginCommand: p.loginCommand } : { installHint: p.installHint }),
    };
    const { store } = this;
    const last = store.state<number>("brainAlertAt") ?? 0;
    if (Date.now() - last > BRAIN_ALERT_EVERY) {
      store.setState("brainAlertAt", Date.now());
      const s = store.settings();
      const fix = p.reason === "signed_out" ? `it isn't signed in on ${this.opts.env.hostName}. To sign in, ${howToSignIn(p.loginCommand)}` : `it isn't installed on ${this.opts.env.hostName} (${p.installHint})`;
      store.say(
        { kind: "notification", priority: "urgent", conversationId: MAIN, text: `I can't think right now: my brain (${this.activeModel() ?? s.model}) can't be reached — ${fix}. I'll pick up what I was doing as soon as it works.` },
        { client: "system", seenByBrain: false },
      );
    }
    return true;
  }

  /** Providers at their usage limit, and when each resets (epoch ms); ones that reset within the hour stay, so a renewed cap isn't news. */
  private capsKept(now = Date.now()): Record<string, number> {
    const caps = this.store.state<Record<string, number>>("brainCaps") ?? {};
    return Object.fromEntries(Object.entries(caps).filter(([, until]) => until > now - HOUR));
  }

  /** Providers at their usage limit right now, and when each resets. */
  caps(now = Date.now()): Record<string, number> {
    return Object.fromEntries(Object.entries(this.capsKept(now)).filter(([, until]) => until > now));
  }

  /** The model to think with: the setting's, or while its provider is at its limit the first fallback whose isn't; none while all are. */
  activeModel(now = Date.now()): string | null {
    const s = this.store.settings();
    const caps = this.caps(now);
    return [s.model, ...s.fallback].find((m) => !caps[resolveModel(m).provider]) ?? null;
  }

  /** When the first capped provider resets. */
  private capsUntil(now = Date.now()): number {
    const until = Object.values(this.caps(now));
    return until.length ? Math.min(...until) : now;
  }

  /**
   * A provider hit its usage limit: hold it until it resets (or a while, when
   * it didn't say), tell the user once, and give the model to carry on with.
   */
  private capped(p: Extract<BrainProblem, { reason: "capped" }>, where: "chat" | "wakeup"): string | null {
    const { store } = this;
    const now = Date.now();
    const until = p.until && p.until > now ? p.until : now + BRAIN_RETRY;
    const kept = this.capsKept(now);
    const news = !kept[p.provider];
    store.setState("brainCaps", { ...kept, [p.provider]: until });
    const next = this.activeModel(now);
    const s = store.settings();
    const limit = `${title(p.provider)}'s usage limit is reached until ${clock(until, s.timezone, now)}`;
    if (news || kept[p.provider] !== until) console.log(`[midna] ${p.provider} is at its usage limit until ${new Date(until).toISOString()}; ${next ? `thinking with ${next}` : "nothing to think with"}`);
    if (!next) this.health = { ok: false, checkedAt: now, reason: "capped", until: this.capsUntil(now), message: `${limit}.` };
    // With nothing to fall back on, a chat's own reply says it.
    if (news && (next || where === "wakeup")) {
      store.say(
        { kind: "notification", conversationId: MAIN, text: next ? `${limit}; I'm thinking with ${next} till then.` : `${limit}; I'll pick up what's waiting then.` },
        { client: "system", seenByBrain: false },
      );
    }
    return next;
  }

  /** Every model is at its usage limit: say when it answers, and come back to the messages then. */
  private capOut(conv: string, unseen: Message[], notes: Interruption[]): void {
    const { store } = this;
    const s = store.settings();
    const now = Date.now();
    const asked = unseen.filter((m) => m.role === "user");
    const caps = Object.entries(this.caps(now)).sort((a, b) => a[1] - b[1]);
    const back = this.capsUntil(now);
    const which = caps.length > 1 ? `${caps.map(([p]) => title(p)).join(" and ")} are ${caps.length === 2 ? "both" : "all"} at their usage limits; the first resets at ${clock(back, s.timezone, now)}` : `${title(caps[0]?.[0] ?? resolveModel(s.model).provider)}'s usage limit is reached until ${clock(back, s.timezone, now)}`;
    store.say({ kind: "message", conversationId: conv, text: `${which}. I'll answer you then.` }, { client: "error", seenByBrain: false });
    const quoted = asked.map((m) => `[${fmt(m.created_at, s.timezone)}${m.client ? ` via ${m.client}` : ""}] "${m.text.slice(0, 1500)}"`).join("\n");
    store.schedule.add({ dueAt: back + 60_000, reason: `Answer the user: you were at your usage limit when they wrote, and told them you'd answer once it reset. They wrote:\n${quoted}`, kind: "followup", createdBy: "system", tz: s.timezone });
    store.log.markSeen(unseen.map((m) => m.id));
    this.heard(conv, notes);
  }

  get brainHealth(): BrainHealth {
    return this.health;
  }

  /** The brain answered: if it hadn't been, run what was waiting on it now. */
  private healthy(): void {
    const was = this.health.ok;
    this.health = { ok: true, checkedAt: Date.now() };
    if (was === false && this.blocked.size) {
      for (const id of this.blocked) this.store.schedule.reschedule(id, Date.now());
      console.log(`[midna] brain is back; running ${this.blocked.size} postponed wakeup(s)`);
      this.blocked.clear();
    }
  }

  /** A tiny real turn through the brain, to know rather than guess. */
  async checkBrain(): Promise<BrainHealth> {
    const model = this.activeModel();
    if (!model) return this.health; // every model is at its limit: a check would only spend what's left
    const r = await checkBrainLive(model);
    if (r.ok) this.healthy();
    else this.health = { ok: false, checkedAt: Date.now(), reason: r.reason, message: r.message, ...(r.loginCommand ? { loginCommand: r.loginCommand } : {}), ...(r.installHint ? { installHint: r.installHint } : {}) };
    return this.health;
  }

  /**
   * One-off wakeups that failed lately only because the brain was out of
   * reach (signed out, not installed) get another go, held until it answers.
   */
  reviveBrainFailures(): number {
    let n = 0;
    for (const f of this.store.schedule.recentFailures(Date.now() - 3 * 24 * HOUR)) {
      if (!f.error || !brainProblem(new Error(f.error))) continue;
      this.store.schedule.reschedule(f.id, Date.now() + 30_000);
      n++;
    }
    return n;
  }

  /** Deterministic upkeep that needs no model. */
  maintenance(job: string): void {
    if (job === "memory maintenance") {
      const faded = this.store.memory.fade();
      if (faded) console.log(`[midna] memory: ${faded} faded fact(s) archived`);
    }
  }

  /** Make sure each ritual (and the nightly upkeep) has exactly one pending wakeup on its current schedule. */
  ensureRituals(): void {
    const { store } = this;
    const s = store.settings();
    const wanted: Array<[string, string | null, "ritual" | "system"]> = [
      ["morning brief", s.rituals.morning, "ritual"],
      ["evening review", s.rituals.evening, "ritual"],
      ["weekly review", s.rituals.weekly, "ritual"],
      ["memory maintenance", "30 3 * * *", "system"],
    ];
    for (const [reason, cron, kind] of wanted) {
      const existing = store.schedule.ritual(reason);
      if (existing && existing.cron === cron) continue;
      if (existing) store.schedule.cancel(existing.id);
      if (cron) store.schedule.add({ reason, cron, kind, createdBy: "system", tz: s.timezone });
    }
  }

  /** On a brand-new install, midna introduces itself instead of waiting to be spoken to. */
  ensureIntroduced(delayMs = 5_000): void {
    const { store } = this;
    if (delayMs < 0) return;
    if (!store.firstTime("introduced")) return;
    store.schedule.add({
      dueAt: Date.now() + delayMs,
      reason: INTRODUCTION,
      kind: "followup",
      createdBy: "system",
      tz: store.settings().timezone,
    });
  }

  /**
   * After a restart, answer what the user wrote that never got its reply —
   * a turn the restart cut short (midna updating itself, say), or one that
   * failed — if it is recent, and only once, so a turn that brings midna
   * down can't do it again and again.
   */
  answerLeftovers(): boolean {
    const { store } = this;
    const left = store.log.unseen(MAIN).filter((m) => m.role === "user" && m.created_at > Date.now() - LEFTOVER_WINDOW);
    const last = left.at(-1)?.id;
    if (!last || last <= (store.state<number>("leftoversAnswered") ?? 0)) return false;
    store.setState("leftoversAnswered", last);
    this.note(MAIN, { by: "restart" });
    this.kick(MAIN);
    return true;
  }

  /** Stop every running model session; what they were answering waits for the next start. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const a of this.aborts) a.abort();
    for (const t of [...this.turns.values(), ...this.wakeups.values()]) t.abort.abort();
    const settled = (async () => {
      await this.idle();
      while (this.wakeups.size) await new Promise((r) => setTimeout(r, 20));
    })();
    await Promise.race([settled, new Promise((r) => setTimeout(r, 5_000))]);
  }
}

/** The second ask, when a turn carrying the user's message ended without a word to them. */
/** For the brain taking over a turn its limit cut short after it had used tools. */
function capNote(model: string, err: unknown): string | undefined {
  if (!(err instanceof BrainCappedError) || err.toolCalls < 1) return undefined;
  const tools = [...new Set(err.tools)];
  return `Your previous brain (${model}) hit its usage limit partway through this turn, after ${err.toolCalls} tool call${err.toolCalls === 1 ? "" : "s"}${tools.length ? ` (midna tools: ${tools.join(", ")})` : ""}. It may already have done part of it — sent a message, run a device command, written a file: check before you redo anything with a side effect.`;
}

const title = (provider: string) => provider.charAt(0).toUpperCase() + provider.slice(1);

/** A time for the user: "4:00 pm", or "Tue 4:00 pm" when it isn't today. */
function clock(ms: number, tz: string, now = Date.now()): string {
  const day = (t: number) => new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ms).toLowerCase();
  return day(ms) === day(now) ? time : `${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(ms)} ${time}`;
}

function askAgainPrompt(asked: Message[], tz: string): string {
  return `[midna] Your last turn ended without a reply to the user — perhaps a system or background-task notification arrived with their message and you answered that instead. The user is waiting. Reply to them now:\n${asked.map((m) => `[${fmt(m.created_at, tz)}${m.client ? ` via ${m.client}` : ""}] User: ${m.text}`).join("\n")}`;
}

/** What a turn hears about work that was cut short for its messages; `resumed` says the session that did it carries on. */
function interruptionNote(n: Interruption, resumed: boolean): string {
  if (n.by === "restart") {
    return `[midna] midna restarted before you had replied to this — an update or a crash may have cut your last turn short. If you were in the middle of something for it, check how far it got before doing it again.`;
  }
  if (n.by === "wakeup") {
    return `[midna] To answer this, your own wakeup "${n.reason.slice(0, 200)}" was set aside${n.doing ? ` while you were in the middle of ${n.doing}` : ""}; it carries on by itself in a minute.`;
  }
  const done = !n.tools
    ? "It hadn't used any tools yet."
    : resumed
      ? "What its tools already did is done, and it's in your transcript above."
      : "What its tools already did is done, but that session is gone: check the state of things before redoing any of it.";
  return `[midna] You were interrupted: the user wrote again while your previous turn was still working, ${Math.max(1, Math.round(n.ms / 1000))} s in, ${n.doing ? `in the middle of ${n.doing}` : "before it called a tool"}. ${done} Nothing it was going to say reached the user, and files you attached in it were not sent. Background shells and subagents it started were stopped — a "stopped" task notification is that, not news; jobs from job_start keep running. Go by what the user wrote last: carry on, change course or drop what you were doing, and reply to them.`;
}

/**
 * What the brain reads for a turn: a timestamp, the user's new message(s),
 * what happened to work cut short for them, anything midna said on its own
 * since the last turn (so a reply to a notification makes sense). A fresh
 * session also gets recent history.
 */
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

function turnPrompt(
  unseen: Message[],
  history: Message[],
  tz: string,
  now: number,
  questionText: (id: number) => string | undefined,
  files: (m: Message) => Array<Attachment & { path: string | null }>,
  replied: (m: Message) => string | undefined,
  notes: string[] = [],
): string {
  const line = (m: Message) => {
    const q = m.reply_to ? questionText(m.reply_to) : undefined;
    const r = replied(m);
    // What the user sent with it, as files in the workspace the brain can open.
    const sent =
      m.role === "user"
        ? files(m)
            .map((f, i, all) => `\n  Attached ${all.length > 1 ? `${i + 1}/${all.length} ` : ""}${f.kind} "${f.name}" (${f.mime}, ${size(f.size)})${f.caption ? `, captioned "${f.caption}"` : ""}${f.path ? `, saved at \`${f.path}\`` : ""}`)
            .join("")
        : "";
    return `[${fmt(m.created_at, tz)}${m.client ? ` via ${m.client}` : ""}] ${m.role === "user" ? "User" : "You"}: ${r ? `${r} ` : ""}${q ? `(answering your question: "${q}") ` : ""}${m.text}${sent}`;
  };
  // The user's words come first, marked as theirs: Claude Code may put a background-task
  // notification ("NOT USER INPUT") in front of this prompt, and it must not swallow them.
  const user = unseen.filter((m) => m.role === "user");
  const parts = [`[midna] A message from the user — real user input, and it needs a reply. Anything before this marked as a system or background-task notification is separate: deal with it if it matters, then answer the user.\nNow ${fmt(now, tz)}. The user wrote:\n${user.map(line).join("\n")}`, ...notes];
  const own = unseen.filter((m) => m.role === "midna");
  if (own.length) parts.push(`For context — since the last exchange you sent, on your own:\n${own.map(line).join("\n")}`);
  if (history.length) parts.push(`Earlier in this conversation (for continuity; already handled):\n${history.map(line).join("\n")}`);
  return parts.join("\n\n");
}

/** At most this much of a job's result goes in the wakeup's prompt as it is; past it, midna reads the file. */
const RESULT_SHOWN = 4_096;

/** A job's result file: its size, and its text when it is short and is text. */
function resultOf(path: string): { bytes: number; text?: string } {
  const bytes = statSync(path).size;
  if (bytes > RESULT_SHOWN) return { bytes };
  const buf = readFileSync(path);
  const text = buf.toString("utf8");
  return buf.includes(0) || text.includes("\uFFFD") ? { bytes } : { bytes, text: text.replace(/\n$/, "") };
}
