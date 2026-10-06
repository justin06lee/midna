import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FACT_KINDS, HORIZONS, MAIN, fmt, parseWhen, type Store } from "@midna/core";

/**
 * midna's own tools, served over MCP so every harness gets the same set.
 * The model works in local wall-clock time; the store works in epoch ms.
 */

export interface ToolContext {
  store: Store;
  /** The episode these calls belong to, for the audit log. */
  episodeId: number | null;
  /** Chat replies reach the user anyway; on a wakeup only message_user does. */
  episodeKind: "chat" | "wakeup";
  conversationId: string;
}

const when = z.string().describe('Local time "2026-10-02 09:30", a date "2026-10-02", ISO with offset, or relative "+2h" / "+3d"');
const maybeWhen = when.nullable().optional();
const id = z.number().int().positive();

type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function createToolServer(ctx: ToolContext): McpServer {
  const { store } = ctx;
  const p = store.planning;
  const tz = () => store.settings().timezone;
  const t = (ms: number | null | undefined) => (ms == null ? null : fmt(ms, tz()));
  const at = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : parseWhen(v, tz()));

  const server = new McpServer({ name: "midna", version: "0.1.0" }, { capabilities: { tools: {} } });

  /** Register a tool whose calls are audited and whose errors come back as text. */
  function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => unknown) {
    server.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>): Promise<Result> => {
      store.log.action(ctx.episodeId, name, args);
      try {
        const out = await run(args);
        return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 1) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `error: ${(err as Error).message}` }], isError: true };
      }
    }) as never);
  }

  // ── objectives ───────────────────────────────────────────────────────
  tool(
    "goals_list",
    "The user's objective tree. Closed goals are left out unless asked for. Pass goal_id to see one goal's renegotiation history.",
    { include_closed: z.boolean().optional(), goal_id: id.optional() },
    ({ include_closed, goal_id }) => {
      if (goal_id) {
        const g = p.goal(goal_id);
        if (!g) throw new Error(`no goal ${goal_id}`);
        return { ...g, target_at: t(g.target_at), last_reviewed_at: t(g.last_reviewed_at), history: p.goalChanges(goal_id).map((c) => ({ ...c, at: t(c.at) })) };
      }
      return p.goals(include_closed ? ["active", "paused", "done", "abandoned"] : ["active", "paused"]).map((g) => ({
        id: g.id, parent_id: g.parent_id, horizon: g.horizon, title: g.title, why: g.why, success: g.success, status: g.status, target: t(g.target_at),
      }));
    },
  );

  tool(
    "goal_save",
    "Create a goal (title + horizon required), or change one. Changing an existing goal — including marking it done, paused or abandoned — is a renegotiation and needs the reason the user gave. Set reviewed=true after reviewing a goal with the user.",
    {
      id: id.optional(),
      title: z.string().optional(),
      horizon: z.enum(HORIZONS as [string, ...string[]]).optional(),
      parent_id: id.nullable().optional(),
      why: z.string().optional(),
      success: z.string().optional().describe("What done looks like"),
      status: z.enum(["active", "paused", "done", "abandoned"]).optional(),
      target: maybeWhen,
      review_every_days: z.number().int().positive().nullable().optional(),
      reviewed: z.boolean().optional(),
      reason: z.string().optional().describe("Required when changing an existing goal"),
    },
    (a) => {
      const fields = {
        title: a.title, horizon: a.horizon as never, parent_id: a.parent_id, why: a.why, success: a.success, status: a.status,
        target_at: at(a.target), review_every_days: a.review_every_days, ...(a.reviewed ? { last_reviewed_at: Date.now() } : {}),
      };
      if (a.id === undefined) {
        if (!a.title || !a.horizon) throw new Error("a new goal needs a title and a horizon");
        return p.saveGoal(fields);
      }
      const changing = Object.entries(fields).some(([k, v]) => v !== undefined && k !== "last_reviewed_at");
      if (changing && !a.reason) throw new Error("changing a goal needs the reason (renegotiation is recorded)");
      return changing ? p.renegotiateGoal(a.id, fields, a.reason!) : p.saveGoal(fields, a.id);
    },
  );

  // ── tasks ────────────────────────────────────────────────────────────
  tool(
    "tasks_list",
    "Tasks, open ones by default. owner 'midna' are your own to-dos.",
    { status: z.array(z.enum(["todo", "doing", "waiting", "done", "dropped"])).optional(), goal_id: id.optional(), owner: z.enum(["user", "midna"]).optional() },
    (a) => p.tasks({ status: a.status, goalId: a.goal_id, owner: a.owner }).map((x) => ({ ...x, due_at: t(x.due_at), created_at: t(x.created_at), updated_at: undefined, done_at: t(x.done_at) })),
  );

  tool(
    "task_save",
    "Create a task (title required) or update one. Link it to the goal it serves. owner 'midna' for things you will do yourself. Priority 1 (highest) to 4.",
    {
      id: id.optional(),
      title: z.string().optional(),
      goal_id: id.nullable().optional(),
      notes: z.string().optional(),
      status: z.enum(["todo", "doing", "waiting", "done", "dropped"]).optional(),
      owner: z.enum(["user", "midna"]).optional(),
      priority: z.number().int().min(1).max(4).optional(),
      due: maybeWhen,
      estimate_min: z.number().int().positive().nullable().optional(),
    },
    (a) => {
      if (a.id === undefined && !a.title) throw new Error("a new task needs a title");
      const r = p.saveTask({ title: a.title, goal_id: a.goal_id, notes: a.notes, status: a.status, owner: a.owner, priority: a.priority, due_at: at(a.due), estimate_min: a.estimate_min }, a.id);
      return { ...r, due_at: t(r.due_at) };
    },
  );

  // ── commitments ──────────────────────────────────────────────────────
  tool(
    "commitments_list",
    "Promises in both directions: 'mine' = the user owes someone, 'theirs' = someone owes the user. Open ones by default.",
    { include_closed: z.boolean().optional() },
    ({ include_closed }) => p.commitments(include_closed ? ["open", "done", "dropped"] : ["open"]).map((c) => ({ ...c, due_at: t(c.due_at), created_at: t(c.created_at), updated_at: undefined, closed_at: t(c.closed_at) })),
  );

  tool(
    "commitment_save",
    "Record a promise (direction + what required) or update one. Use this whenever the user says they'll do something for someone, or someone says they'll do something for the user.",
    {
      id: id.optional(),
      direction: z.enum(["mine", "theirs"]).optional(),
      counterparty: z.string().optional(),
      person_id: id.nullable().optional(),
      what: z.string().optional(),
      due: maybeWhen,
      goal_id: id.nullable().optional(),
      status: z.enum(["open", "done", "dropped"]).optional(),
      source: z.string().optional().describe("Where this came from, e.g. 'chat 2026-10-01' or an email subject"),
    },
    (a) => {
      if (a.id === undefined && (!a.direction || !a.what)) throw new Error("a new commitment needs direction and what");
      const r = p.saveCommitment({ direction: a.direction, counterparty: a.counterparty, person_id: a.person_id, what: a.what, due_at: at(a.due), goal_id: a.goal_id, status: a.status, source: a.source }, a.id);
      return { ...r, due_at: t(r.due_at) };
    },
  );

  // ── calendar ─────────────────────────────────────────────────────────
  tool(
    "calendar_list",
    "Events in a window (default: now through the next 7 days), from every connected calendar plus your own.",
    { from: when.optional(), to: when.optional() },
    (a) => {
      const from = a.from ? parseWhen(a.from, tz()) : Date.now();
      const to = a.to ? parseWhen(a.to, tz()) : from + 7 * 86_400_000;
      return p.events(from, to).map((e) => ({ id: e.id, title: e.title, start: t(e.starts_at), end: t(e.ends_at), all_day: !!e.all_day, location: e.location, notes: e.notes, source: e.source, status: e.status, goal_id: e.goal_id }));
    },
  );

  tool(
    "event_save",
    "Add an event to your calendar (title + start required) or change one. Set status 'cancelled' to cancel.",
    {
      id: id.optional(),
      title: z.string().optional(),
      start: when.optional(),
      end: maybeWhen,
      all_day: z.boolean().optional(),
      location: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      goal_id: id.nullable().optional(),
      status: z.enum(["tentative", "confirmed", "cancelled"]).optional(),
    },
    (a) => {
      if (a.id === undefined && (!a.title || !a.start)) throw new Error("a new event needs a title and a start");
      const r = p.saveEvent({ title: a.title, starts_at: at(a.start) ?? undefined, ends_at: at(a.end), all_day: a.all_day === undefined ? undefined : a.all_day ? 1 : 0, location: a.location, notes: a.notes, goal_id: a.goal_id, status: a.status }, a.id);
      return { ...r, starts_at: t(r.starts_at), ends_at: t(r.ends_at) };
    },
  );

  // ── people ───────────────────────────────────────────────────────────
  tool("people_find", "Find people by name, relation or notes.", { query: z.string() }, ({ query }) =>
    p.findPeople(query).map((x) => ({ ...x, last_contact_at: t(x.last_contact_at), created_at: undefined, updated_at: undefined })),
  );

  tool(
    "person_save",
    "Add a person (name required) or update one. contact_every_days sets how often the user wants to stay in touch; set last_contact when they talk.",
    {
      id: id.optional(),
      name: z.string().optional(),
      relation: z.string().optional(),
      notes: z.string().optional(),
      birthday: z.string().optional().describe("MM-DD or YYYY-MM-DD"),
      contact_every_days: z.number().int().positive().nullable().optional(),
      last_contact: maybeWhen,
    },
    (a) => {
      if (a.id === undefined && !a.name) throw new Error("a new person needs a name");
      return p.savePerson({ name: a.name, relation: a.relation, notes: a.notes, birthday: a.birthday, contact_every_days: a.contact_every_days, last_contact_at: at(a.last_contact) }, a.id);
    },
  );

  // ── decisions ────────────────────────────────────────────────────────
  tool(
    "decisions_list",
    "The decision journal: recent decisions, or those due for review (due=true).",
    { due: z.boolean().optional() },
    ({ due }) => p.decisions(due ? { dueForReview: Date.now() } : {}).map((d) => ({ ...d, review_at: t(d.review_at), decided_at: t(d.decided_at), reviewed_at: t(d.reviewed_at), created_at: undefined, updated_at: undefined })),
  );

  tool(
    "decision_save",
    "Log a decision the user made (title required): options considered, choice, reasoning, what they expect to happen, confidence 0–1, and when to look back. At review, record the outcome and the lesson.",
    {
      id: id.optional(),
      title: z.string().optional(),
      context: z.string().optional(),
      options: z.array(z.string()).optional(),
      choice: z.string().optional(),
      reasoning: z.string().optional(),
      expected: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      goal_id: id.nullable().optional(),
      review_at: maybeWhen,
      outcome: z.string().optional(),
      lesson: z.string().optional(),
    },
    (a) => {
      if (a.id === undefined && !a.title) throw new Error("a new decision needs a title");
      const r = p.saveDecision(
        {
          title: a.title, context: a.context, options: a.options ? JSON.stringify(a.options) : undefined, choice: a.choice, reasoning: a.reasoning,
          expected: a.expected, confidence: a.confidence, goal_id: a.goal_id, review_at: at(a.review_at),
          ...(a.choice && a.id === undefined ? { decided_at: Date.now() } : {}),
          ...(a.outcome ? { outcome: a.outcome, lesson: a.lesson, reviewed_at: Date.now() } : {}),
        },
        a.id,
      );
      return { ...r, review_at: t(r.review_at) };
    },
  );

  // ── notes ────────────────────────────────────────────────────────────
  tool("notes_search", "Search notes (yours and the user's). Empty query lists the latest.", { query: z.string().optional() }, ({ query }) =>
    p.searchNotes(query ?? "").map((n) => ({ id: n.id, title: n.title, tags: n.tags, updated: t(n.updated_at), preview: n.body.slice(0, 200) })),
  );
  tool("note_read", "Read a note in full.", { id }, ({ id }) => {
    const n = p.note(id);
    if (!n) throw new Error(`no note ${id}`);
    return { ...n, created_at: t(n.created_at), updated_at: t(n.updated_at) };
  });
  tool(
    "note_save",
    "Write a note (title + body) or update one. For reference material, plans, research — anything longer than a fact.",
    { id: id.optional(), title: z.string().optional(), body: z.string().optional(), tags: z.string().optional() },
    (a) => {
      if (a.id === undefined && (!a.title || !a.body)) throw new Error("a new note needs a title and a body");
      const n = p.saveNote({ title: a.title, body: a.body, tags: a.tags }, a.id);
      return { id: n.id, title: n.title };
    },
  );

  // ── memory ───────────────────────────────────────────────────────────
  tool(
    "remember",
    "Store one durable fact about the user or their world, as a short standalone claim. importance: 1 trivia … 5 useful … 8 shapes how you help … 10 core identity. Link it to the goals/people it concerns so it stays strong while they matter.",
    {
      content: z.string(),
      kind: z.enum(FACT_KINDS as [string, ...string[]]),
      importance: z.number().int().min(1).max(10),
      pinned: z.boolean().optional(),
      about: z.array(z.object({ entity: z.enum(["goal", "person", "task", "commitment", "decision"]), id })).optional(),
    },
    (a) => {
      const f = store.memory.remember({ content: a.content, kind: a.kind as never, importance: a.importance, pinned: a.pinned, source: `${ctx.episodeKind}:${ctx.episodeId ?? "?"}`, links: a.about });
      return `remembered #${f.id}`;
    },
  );
  tool(
    "recall",
    "Search memory for facts relevant to a query. Recalling renews a memory's strength.",
    { query: z.string(), kind: z.enum(FACT_KINDS as [string, ...string[]]).optional(), limit: z.number().int().min(1).max(30).optional() },
    (a) => store.memory.recall(a.query, { kind: a.kind as never, limit: a.limit }).map((f) => ({ id: f.id, content: f.content, kind: f.kind, importance: f.importance, pinned: !!f.pinned, since: t(f.created_at), links: f.links })),
  );
  tool(
    "memory_revise",
    "A remembered fact is no longer true: store the new version. The old one is kept as history.",
    { id, content: z.string(), importance: z.number().int().min(1).max(10).optional() },
    (a) => `revised #${a.id} → #${store.memory.revise(a.id, a.content, Date.now(), { importance: a.importance }).id}`,
  );
  tool("memory_forget", "Take a fact out of memory (it is archived with the reason, not erased).", { id, reason: z.string() }, (a) => {
    store.memory.forget(a.id, a.reason);
    return `forgot #${a.id}`;
  });
  tool("memory_pin", "Pin a fact so it never fades, or unpin it.", { id, pinned: z.boolean() }, (a) => {
    store.memory.setPinned(a.id, a.pinned);
    return `${a.pinned ? "pinned" : "unpinned"} #${a.id}`;
  });
  tool("history_search", "Search everything ever said between you and the user.", { query: z.string(), limit: z.number().int().min(1).max(50).optional() }, (a) =>
    store.log.search(a.query, a.limit).map((m) => ({ at: t(m.created_at), from: m.role === "user" ? "user" : "you", via: m.client, text: m.text })),
  );

  // ── your own schedule ────────────────────────────────────────────────
  tool(
    "schedule_wakeup",
    "Schedule your own future. kind 'followup' (default) wakes you to think and act — write the reason so it makes sense to you cold. kind 'reminder' sends the reason to the user verbatim at that time without waking you. Give `when` for once, or `cron` (5-field, user's timezone) to recur.",
    { reason: z.string(), when: when.optional(), cron: z.string().optional(), kind: z.enum(["followup", "reminder"]).optional() },
    (a) => {
      if (!a.when && !a.cron) throw new Error("give `when` or `cron`");
      const w = store.schedule.add({ dueAt: a.when ? parseWhen(a.when, tz()) : undefined, cron: a.cron, reason: a.reason, kind: a.kind ?? "followup", createdBy: "midna", tz: tz() });
      return `scheduled #${w.id} for ${t(w.due_at)}${w.cron ? ` (recurring: ${w.cron})` : ""}`;
    },
  );
  tool("wakeups_list", "Your pending wakeups: follow-ups, reminders, rituals.", {}, () =>
    store.schedule.pending(100).filter((w) => w.kind !== "system").map((w) => ({ id: w.id, at: t(w.due_at), kind: w.kind, reason: w.reason, cron: w.cron, by: w.created_by })),
  );
  tool("wakeup_cancel", "Cancel a pending wakeup.", { id }, ({ id }) => {
    store.schedule.cancel(id);
    return `cancelled #${id}`;
  });

  // ── reaching the user ────────────────────────────────────────────────
  tool(
    "message_user",
    "Send the user a message now. urgent = interrupt them (only for what can't wait); normal = ordinary; fyi = quiet background. Non-urgent messages wait out quiet hours. In a chat, your reply already reaches them — use this only for something separate.",
    { text: z.string(), priority: z.enum(["urgent", "normal", "fyi"]).optional() },
    (a) => {
      const item = store.say({ kind: "notification", text: a.text, priority: a.priority ?? "normal", conversationId: MAIN }, { client: "notification", seenByBrain: ctx.episodeKind === "chat" });
      return item.seq ? "sent" : `held until ${t(item.deliverAfter)} (quiet hours)`;
    },
  );
  tool(
    "ask_user",
    "Ask the user a question, with optional answer choices they can tap. Their answer arrives as a normal message.",
    { question: z.string(), options: z.array(z.string()).max(8).optional(), priority: z.enum(["urgent", "normal", "fyi"]).optional() },
    (a) => {
      const item = store.say(
        { kind: "question", text: a.question, options: a.options, priority: a.priority ?? "normal", conversationId: MAIN },
        { client: "question", seenByBrain: ctx.episodeKind === "chat", logText: a.question + (a.options?.length ? ` [${a.options.join(" / ")}]` : "") },
      );
      return item.seq ? `asked (question #${item.id})` : `question #${item.id} held until ${t(item.deliverAfter)} (quiet hours)`;
    },
  );

  return server;
}
