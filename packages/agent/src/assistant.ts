import { MAIN, HOUR, fmt, renderContext, type Message, type Store, type Wakeup } from "@midna/core";
import { BrainError, yagamiBrain, type Brain } from "./brain.ts";
import { brainProblem, checkBrainLive, howToSignIn } from "./check.ts";
import type { BrainHealth } from "@midna/protocol";
import { INTRODUCTION, systemPrompt, wakeupPrompt, type Environment } from "./prompt.ts";

export interface AssistantOptions {
  store: Store;
  env: Environment;
  /** The MCP endpoint for an episode, and the token that opens it. */
  mcp: { url: (episodeId: number) => string; token: string };
  brain?: Brain;
  /** How many model sessions may run at once (subscriptions have rate limits). */
  concurrency?: number;
}

/** How long to wait before retrying work the brain couldn't do, and how often to say so. */
const BRAIN_RETRY = 15 * 60_000;
const BRAIN_ALERT_EVERY = 6 * HOUR;
/** A chat brain session is started over after this long idle, or this many turns. */
const SESSION_IDLE = 4 * HOUR;
const SESSION_TURNS = 40;
const HISTORY_ON_FRESH = 20;

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
  /** Can midna think right now, as of the last thing that tried? */
  private health: BrainHealth = { ok: null, checkedAt: null };
  /** Wakeups put off because the brain couldn't be reached; they run as soon as it can. */
  private readonly blocked = new Set<number>();

  constructor(private readonly opts: AssistantOptions) {
    this.store = opts.store;
    this.brain = opts.brain ?? yagamiBrain;
    this.slots = opts.concurrency ?? 2;
  }

  get busy(): boolean {
    return this.running.size > 0;
  }

  /** A message from the user, from any client. Answered as soon as the conversation is free. */
  receive(m: { text: string; client: string; conversationId?: string; replyTo?: number }): string {
    const conv = m.conversationId ?? MAIN;
    const question = m.replyTo ? this.store.outbox.get(m.replyTo) : null;
    if (question) this.store.outbox.answered(question.id);
    const msg = this.store.log.addMessage({ conversationId: conv, role: "user", text: m.text, client: m.client, seen: false, ...(question ? { replyTo: question.id } : {}) });
    this.store.bus.emit({ type: "user_message", id: msg.id, conversationId: conv, text: m.text, client: m.client, createdAt: msg.created_at, replyTo: question?.id ?? null });
    this.kick(conv);
    return conv;
  }

  /** Run the conversation until nothing is left unread; messages arriving mid-turn are batched into the next. */
  private kick(conv: string): void {
    if (this.running.has(conv)) {
      this.again.add(conv);
      return;
    }
    const loop = (async () => {
      do {
        this.again.delete(conv);
        await this.chatTurn(conv).catch((err) => console.error(`[midna] chat turn failed:`, err));
      } while (this.again.has(conv));
    })().finally(() => this.running.delete(conv));
    this.running.set(conv, loop);
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

  private async chatTurn(conv: string): Promise<void> {
    const { store } = this;
    const unseen = store.log.unseen(conv);
    if (!unseen.some((m) => m.role === "user")) return; // only midna's own news: nothing to answer yet
    store.log.markSeen(unseen.map((m) => m.id));

    const settings = store.settings();
    const convo = store.log.conversation(conv);
    const previous = store.log.recent(conv, 1, unseen[0]!.id)[0];
    const now = Date.now();
    const stale =
      !convo.brain_session ||
      convo.brain_model !== settings.model ||
      convo.brain_turns >= SESSION_TURNS ||
      !previous ||
      now - previous.created_at > SESSION_IDLE;

    store.bus.emit({ type: "status", conversationId: conv, state: "thinking" });
    try {
      const run = async (fresh: boolean) => {
        const history = fresh ? store.log.recent(conv, HISTORY_ON_FRESH, unseen[0]!.id) : [];
        return this.episode({ kind: "chat", conversationId: conv, prompt: turnPrompt(unseen, history, settings.timezone, now, (id) => store.outbox.get(id)?.text), resume: fresh ? undefined : convo.brain_session! });
      };
      let fresh = stale;
      let result: Awaited<ReturnType<typeof run>>;
      try {
        result = await run(fresh);
      } catch (err) {
        if (fresh) throw err;
        // The saved session may be gone (harness updated, cache cleared): start over with history.
        console.error(`[midna] resuming ${conv} failed, starting fresh:`, (err as Error).message);
        fresh = true;
        result = await run(true);
      }
      store.log.setBrain(conv, {
        model: settings.model,
        session: result.sessionId ?? null,
        startedAt: fresh ? now : convo.brain_started_at,
        turns: fresh ? 1 : convo.brain_turns + 1,
      });
      const reply = result.text.trim();
      if (reply) store.say({ kind: "message", conversationId: conv, text: reply }, { client: "chat", seenByBrain: true });
    } catch (err) {
      const p = brainProblem(err);
      const why =
        p?.reason === "signed_out"
          ? `my brain (${settings.model}) isn't signed in on ${this.opts.env.hostName}. To sign in, ${howToSignIn(p.loginCommand)} — then ask me again.`
          : p?.reason === "not_installed"
            ? `my brain (${settings.model}) isn't installed on ${this.opts.env.hostName}: ${p.installHint}`
            : err instanceof BrainError
              ? err.message
              : String(err);
      store.say({ kind: "message", conversationId: conv, text: `I couldn't finish that — ${why}` }, { client: "error", seenByBrain: false });
    } finally {
      store.bus.emit({ type: "status", conversationId: conv, state: "idle" });
    }
  }

  /** One model session, start to finish, recorded as an episode. */
  private async episode(e: { kind: "chat" | "wakeup"; conversationId?: string; wakeupId?: number; prompt: string; resume?: string }) {
    const { store, opts } = this;
    return this.slot(async () => {
      const settings = store.settings();
      const episodeId = store.log.startEpisode({ kind: e.kind, conversationId: e.conversationId, wakeupId: e.wakeupId, model: settings.model });
      const abort = new AbortController();
      this.aborts.add(abort);
      try {
        const result = await this.brain({
          prompt: e.prompt,
          systemPrompt: systemPrompt(settings, opts.env, renderContext(store)),
          model: settings.model,
          resume: e.resume,
          cwd: opts.env.workspace,
          mcp: { url: opts.mcp.url(episodeId), token: opts.mcp.token },
          mode: settings.mode,
          signal: abort.signal,
          onActivity: (tool) => store.bus.emit({ type: "activity", conversationId: e.conversationId ?? null, tool }),
        });
        store.log.endEpisode(episodeId, { session: result.sessionId, costUsd: result.costUsd });
        this.healthy();
        return result;
      } catch (err) {
        store.log.endEpisode(episodeId, { session: (err as BrainError).sessionId, error: String((err as Error).message ?? err) });
        throw err;
      } finally {
        this.aborts.delete(abort);
      }
    });
  }

  /**
   * Do what a due wakeup calls for. A wakeup that failed only because the
   * brain can't be reached is retried later rather than lost.
   */
  async wakeup(w: Wakeup): Promise<"done" | "failed" | { retryAt: number }> {
    const { store } = this;
    const tz = store.settings().timezone;
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
      const result = await this.episode({ kind: "wakeup", wakeupId: w.id, prompt: wakeupPrompt(w.reason, w.kind, fmt(w.due_at, tz)) });
      if (result.text) console.log(`[midna] wakeup #${w.id} (${w.reason.slice(0, 60)}): ${result.text.slice(0, 200)}`);
      return "done";
    } catch (err) {
      console.error(`[midna] wakeup #${w.id} failed:`, (err as Error).message);
      if (this.brainTrouble(err)) {
        this.blocked.add(w.id);
        return { retryAt: Date.now() + BRAIN_RETRY };
      }
      return "failed";
    }
  }

  /**
   * When the brain is signed out or missing, say so — the outbox needs no
   * brain — at most every few hours, and report that it was brain trouble.
   */
  private brainTrouble(err: unknown): boolean {
    const p = brainProblem(err);
    if (!p) return false;
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
        { kind: "notification", priority: "urgent", conversationId: MAIN, text: `I can't think right now: my brain (${s.model}) can't be reached — ${fix}. I'll pick up what I was doing as soon as it works.` },
        { client: "system", seenByBrain: false },
      );
    }
    return true;
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
    const r = await checkBrainLive(this.store.settings().model);
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

  /** Stop every running model session. */
  async shutdown(): Promise<void> {
    for (const a of this.aborts) a.abort();
    await Promise.race([this.idle(), new Promise((r) => setTimeout(r, 5_000))]);
  }
}

/**
 * What the brain reads for a turn: a timestamp, anything midna said on its
 * own since the last turn (so a reply to a notification makes sense), and
 * the user's new message(s). A fresh session also gets recent history.
 */
function turnPrompt(unseen: Message[], history: Message[], tz: string, now: number, questionText: (id: number) => string | undefined): string {
  const line = (m: Message) => {
    const q = m.reply_to ? questionText(m.reply_to) : undefined;
    return `[${fmt(m.created_at, tz)}${m.client ? ` via ${m.client}` : ""}] ${m.role === "user" ? "User" : "You"}: ${q ? `(answering your question: "${q}") ` : ""}${m.text}`;
  };
  const parts: string[] = [];
  if (history.length) parts.push(`Earlier in this conversation (for continuity; already handled):\n${history.map(line).join("\n")}`);
  const own = unseen.filter((m) => m.role === "midna");
  if (own.length) parts.push(`Since the last exchange you sent, on your own:\n${own.map(line).join("\n")}`);
  const user = unseen.filter((m) => m.role === "user");
  parts.push(`Now ${fmt(now, tz)}. The user wrote:\n${user.map(line).join("\n")}`);
  return parts.join("\n\n");
}
