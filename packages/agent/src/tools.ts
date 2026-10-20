import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FACT_KINDS, HORIZONS, MAIN, fmt, parseWhen, type Store } from "@midna/core";
import { MAX_ATTACHMENTS_PER_MESSAGE, type Attachment, type Op } from "@midna/protocol";
import { attach, liftLocalImages, workspaceCopy, type FileRef } from "./attachments.ts";
import type { HandsHandle, HandsOutcome, HandsRequest } from "./hands.ts";

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
  /** The user's computers that offer their hands; without it, there are no device tools. */
  hands?: HandsHandle;
  /** Aborted when the brain gives up on the call (its turn was interrupted): a device command in flight is cancelled. */
  signal?: AbortSignal;
  /** midna's working directory: files a device sends are copied here for the brain to open. */
  workspace?: string;
}

const when = z.string().describe('Local time "2026-10-02 09:30", a date "2026-10-02", ISO with offset, or relative "+2h" / "+3d"');
const maybeWhen = when.nullable().optional();
const id = z.number().int().positive();
const fileRef = z.union([
  z.string().describe("An absolute path on this machine, an http(s) URL to download, or an attachment id (att_…) such as a device screenshot's"),
  z.object({
    file: z.string().describe("An absolute path on this machine, an http(s) URL to download, or an attachment id (att_…)"),
    name: z.string().optional().describe('The name it arrives under, e.g. "Q4 report.pdf" (default: its own)'),
    caption: z.string().optional().describe("A line shown with this one file"),
    as: z.enum(["image", "file"]).optional().describe('"file" sends an image as a file — full quality, not shown inline. Other types always go as files.'),
  }),
]);
const files = z
  .array(fileRef)
  .max(MAX_ATTACHMENTS_PER_MESSAGE)
  .describe(
    "Files to send, of any type — images, PDFs, zips, spreadsheets, logs, audio, video, anything up to 100 MB — in the order the user should see them. Each is a path or URL, or {file, name, caption, as} to choose how it arrives.",
  );

type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Result = { content: Block[]; isError?: boolean };
/** A tool's answer that is more than words: an image for the model to see, say. */
class Blocks {
  constructor(readonly content: Block[]) {}
}
/** Images a model can look at. */
const VIEWABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** How long the screen gets to catch up with input before the screenshot after it. */
const SETTLE_MS = 300;

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
        if (out instanceof Blocks) return { content: out.content };
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
  /** Text plus files: the listed ones, and any Markdown image of a file on this machine. */
  async function withFiles(text: string, refs: FileRef[] | undefined) {
    const kept = [];
    for (const ref of refs ?? []) kept.push((await attach(store, ref)).id);
    const lifted = liftLocalImages(store, text);
    const attachments = [...kept, ...lifted.attachments];
    if (!lifted.text.trim() && !attachments.length) throw new Error("nothing to send: give text or attachments");
    return { text: lifted.text, attachments };
  }
  const sizeOf = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
const sentWith = (n: number) => (n ? ` with ${n} attachment${n === 1 ? "" : "s"}` : "");

  tool(
    "message_user",
    "Send the user a message now, with files of any type if it helps (attachments: images, PDFs, zips, anything; shown in the order you list them, after the text). urgent = interrupt them (only for what can't wait); normal = ordinary; fyi = quiet background. Non-urgent messages wait out quiet hours. In a chat, your reply already reaches them — use this only for something separate, and use attach to put files on your reply.",
    { text: z.string(), priority: z.enum(["urgent", "normal", "fyi"]).optional(), attachments: files.optional() },
    async (a) => {
      const body = await withFiles(a.text, a.attachments);
      const item = store.say({ kind: "notification", ...body, priority: a.priority ?? "normal", conversationId: MAIN }, { client: "notification", seenByBrain: ctx.episodeKind === "chat" });
      return (item.seq ? "sent" : `held until ${t(item.deliverAfter)} (quiet hours)`) + sentWith(item.attachments.length);
    },
  );
  tool(
    "ask_user",
    "Ask the user a question, with optional answer choices they can tap, and files of any type to look at (attachments, in the order you list them). Their answer arrives as a normal message.",
    { question: z.string(), options: z.array(z.string()).max(8).optional(), priority: z.enum(["urgent", "normal", "fyi"]).optional(), attachments: files.optional() },
    async (a) => {
      const body = await withFiles(a.question, a.attachments);
      const item = store.say(
        { kind: "question", ...body, options: a.options, priority: a.priority ?? "normal", conversationId: MAIN },
        { client: "question", seenByBrain: ctx.episodeKind === "chat", logText: body.text + (a.options?.length ? ` [${a.options.join(" / ")}]` : "") },
      );
      return (item.seq ? `asked (question #${item.id})` : `question #${item.id} held until ${t(item.deliverAfter)} (quiet hours)`) + sentWith(item.attachments.length);
    },
  );
  tool(
    "attach",
    "Put files of any type on your reply in this chat — a screenshot you took, a chart, a PDF or zip you made, a log, a file from the web. They arrive with the reply, after its text, in the order you attach them (call it again to add more after); images show inline unless you send them as files. Works in the user's app and on Telegram. Call it before you finish; your reply can be short or even empty.",
    { files: files.min(1) },
    async (a) => {
      if (ctx.episodeKind !== "chat" || ctx.episodeId === null) throw new Error("there is no reply to attach to here — send files with message_user's attachments instead");
      const kept = [];
      for (const ref of a.files) kept.push(await attach(store, ref, { episodeId: ctx.episodeId }));
      return `attached ${kept.map((f) => `${f.name} (${f.kind === "image" ? "image" : f.mime}, ${sizeOf(f.size)})`).join(", ")} — they go with your reply, in this order`;
    },
  );

  // ── the user's computers ─────────────────────────────────────────────
  // The daemon decides whether each command may run (pause, state, permissions, the device's
  // toggles, ask mode) and asks the user when it needs a yes, whatever the harness lets through.
  const hands = ctx.hands;
  if (hands) {
    const device = z.string().optional().describe("The device's name or id, from device_list. Leave it out when only one online device can do this.");
    const display = z.string().optional().describe("A display id from device_list; the main display when left out");
    const thenScreenshot = z.boolean().optional().describe("Take a screenshot afterwards and return it (default true); false saves a round trip");
    const timeout = (cap: number) => z.number().int().min(1).max(cap).optional().describe(`Seconds to let it run (at most ${cap})`);
    const run = async (req: Pick<HandsRequest, "device" | "op" | "args" | "timeoutMs">) => {
      const r = await hands.run({ ...req, episodeId: ctx.episodeId, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      if (!r.ok) throw new Error(r.message);
      return r;
    };
    type Done = Extract<HandsOutcome, { ok: true }>;
    /** Where the brain can open a file a device sent: a copy in its workspace. */
    const saved = (a: Attachment) => {
      const path = ctx.workspace ? workspaceCopy(store, ctx.workspace, a) : null;
      return `attachment ${a.id} (${a.name}, ${sizeOf(a.size)})${path ? `, saved at \`${path}\`` : ""}`;
    };
    /** An image a device sent, for the model to see, with a line about it. */
    const image = (a: Attachment, about: string): Block[] => {
      const file = store.attachments.read(a.id);
      if (!file || !VIEWABLE.has(a.mime)) return [{ type: "text", text: `${about}: ${saved(a)}` }];
      return [
        { type: "image", data: Buffer.from(file.data).toString("base64"), mimeType: a.mime },
        { type: "text", text: `${about}: ${saved(a)}` },
      ];
    };
    const screenshot = (r: Done): Block[] => {
      const png = r.attachments.find((x) => VIEWABLE.has(x.mime));
      if (!png) throw new Error(`${r.device.name} took the screenshot but sent no image`);
      const d = (r.data ?? {}) as { width?: number; height?: number; display?: string; cursor?: { x: number; y: number } | null };
      const where = d.cursor ? `, pointer at ${d.cursor.x},${d.cursor.y}` : "";
      return image(png, `${r.device.name}, display ${d.display ?? "?"}: ${d.width ?? "?"}×${d.height ?? "?"} px${where}`);
    };
    /** Input, then a look at what it did, unless the brain said not to. */
    const act = async (a: { device?: string; display?: string; then_screenshot?: boolean }, op: Op, args: Record<string, unknown>, did: string, timeoutMs?: number) => {
      const r = await run({ device: a.device, op, args, ...(timeoutMs ? { timeoutMs } : {}) });
      const text = `${did} on ${r.device.name}`;
      if (a.then_screenshot === false) return text;
      await new Promise((settle) => setTimeout(settle, SETTLE_MS));
      try {
        return new Blocks([{ type: "text", text }, ...screenshot(await run({ device: r.device.id, op: "screenshot", args: { display: a.display } }))]);
      } catch (err) {
        return `${text}; no screenshot after it: ${(err as Error).message}`;
      }
    };
    /** A file on this machine, a URL or an attachment, kept for a device to fetch. */
    const upload = async (file: string) => (await attach(store, file)).id;

    tool(
      "device_list",
      'The user\'s computers that offer you their hands, through the midna app on each: online or not (and when last seen), state (ready, paused, locked, display_asleep), displays, and what each lets you do. Under `can`, each capability is "on" (runs; in ask mode, only looking runs without the user\'s yes) or "ask" (asks the user each time), with any permission it still needs; anything not listed is off, and only the user can turn it on. Look here first.',
      {},
      () => {
        const list = hands.devices();
        if (!list.length) return "No device offers its hands yet. They come from the midna app on the user's computers, once hands are turned on there.";
        return list.map((d) => ({
          name: d.name,
          id: d.id,
          online: d.online,
          ...(d.online ? {} : { last_seen: t(d.lastSeenAt) }),
          state: d.state,
          os: d.os ? `${d.os.family} ${d.os.version} (${d.os.arch})` : null,
          displays: d.displays.map((x) => `${x.id}: ${x.name}, ${x.width}×${x.height}${x.primary ? ", main" : ""}`),
          can: Object.fromEntries(
            d.capabilities.filter((c) => c.policy !== "off").map((c) => [c.capability, c.missing.length ? `${c.policy}, needs ${c.missing.join(", ")}` : c.policy]),
          ),
        }));
      },
    );
    tool(
      "device_screenshot",
      "See a screen of one of the user's computers: you get the image, its size in pixels and where the pointer is. It is scaled so the long edge is at most 1568 px, unless full is true; pointer tools take coordinates in these pixels. To show it to the user, pass its attachment id to attach or message_user.",
      { device, display, full: z.boolean().optional().describe("Native resolution, for small text"), wake: z.boolean().optional().describe("Wake a sleeping display to take it") },
      async (a) => new Blocks(screenshot(await run({ device: a.device, op: "screenshot", args: { display: a.display, full: a.full, wake: a.wake } }))),
    );

    // Pointer and keyboard: coordinates are pixels in the latest screenshot of that display.
    const x = z.number().describe("Pixels from the left of your latest screenshot of that display");
    const y = z.number().describe("Pixels from the top of your latest screenshot of that display");
    const button = z.enum(["left", "right", "middle"]).optional();
    tool(
      "device_click",
      "Click on one of the user's computers, at a point in your latest screenshot of that display. count 2 double-clicks. Returns a fresh screenshot.",
      { device, x, y, display, button, count: z.number().int().min(1).max(3).optional(), then_screenshot: thenScreenshot },
      (a) => act(a, "click", { x: a.x, y: a.y, display: a.display, button: a.button, count: a.count }, `${a.count === 2 ? "double-" : ""}${a.button === "right" ? "right-" : ""}clicked at ${a.x},${a.y}`),
    );
    tool(
      "device_move",
      "Move the pointer on one of the user's computers (to hover), to a point in your latest screenshot of that display. Returns a fresh screenshot.",
      { device, x, y, display, then_screenshot: thenScreenshot },
      (a) => act(a, "move", { x: a.x, y: a.y, display: a.display }, `moved the pointer to ${a.x},${a.y}`),
    );
    tool(
      "device_drag",
      "Drag on one of the user's computers: press at the first point, move through the rest, release at the last (screenshot pixels). Returns a fresh screenshot.",
      { device, path: z.array(z.object({ x, y })).min(2).max(50), display, button, then_screenshot: thenScreenshot },
      (a) => act(a, "drag", { path: a.path, display: a.display, button: a.button }, `dragged from ${a.path[0]!.x},${a.path[0]!.y} to ${a.path.at(-1)!.x},${a.path.at(-1)!.y}`),
    );
    tool(
      "device_scroll",
      "Scroll on one of the user's computers by dx, dy pixels (positive dy scrolls down), at x, y when given, else where the pointer is. Returns a fresh screenshot.",
      { device, dx: z.number().optional(), dy: z.number().optional(), x: x.optional(), y: y.optional(), display, then_screenshot: thenScreenshot },
      (a) => act(a, "scroll", { dx: a.dx ?? 0, dy: a.dy ?? 0, x: a.x, y: a.y, display: a.display }, `scrolled ${a.dx ?? 0},${a.dy ?? 0}`),
    );
    tool(
      "device_type",
      "Type text on one of the user's computers, into whatever has focus. Mark anything private secret: it stays out of the logs. Never type a password unless the user asked for exactly that. Returns a fresh screenshot.",
      { device, text: z.string().min(1).max(10_000), secret: z.boolean().optional(), then_screenshot: thenScreenshot },
      (a) => act(a, "type", { text: a.text, secret: a.secret }, `typed ${a.secret ? `${a.text.length} secret characters` : `${a.text.length} characters`}`, Math.min(60_000, 5_000 * Math.ceil(a.text.length / 200))),
    );
    tool(
      "device_key",
      'Press a key or a chord on one of the user\'s computers: "return", "escape", "cmd+space", "cmd+shift+4", "ctrl+c". Returns a fresh screenshot.',
      { device, keys: z.string().min(1).max(100), then_screenshot: thenScreenshot },
      (a) => act(a, "key", { keys: a.keys }, `pressed ${a.keys}`),
    );

    // Reach: scripts, the shell, files and the clipboard.
    tool(
      "device_applescript",
      "Run AppleScript (or JXA) on one of the user's Macs, as the user: drive Messages, Mail, Calendar, Finder, System Events and any scriptable app. Returns the script's result.",
      { device, source: z.string().min(1).max(100_000), language: z.enum(["applescript", "jxa"]).optional(), timeout_s: timeout(300) },
      async (a) => {
        const r = await run({ device: a.device, op: "script", args: { source: a.source, language: a.language ?? "applescript" }, ...(a.timeout_s ? { timeoutMs: a.timeout_s * 1000 } : {}) });
        const result = ((r.data ?? {}) as { result?: string }).result ?? "";
        return result.trim() ? `result on ${r.device.name}:\n${result}` : `ran on ${r.device.name}; no result`;
      },
    );
    tool(
      "device_shell",
      "Run a shell command on one of the user's computers, as the user, in their login shell (zsh -lc on a Mac), in their home unless cwd says otherwise. Returns the exit code and the output; long output comes whole as a file.",
      {
        device,
        command: z.string().min(1).max(100_000),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        timeout_s: timeout(600),
      },
      async (a) => {
        const r = await run({ device: a.device, op: "shell", args: { command: a.command, cwd: a.cwd, env: a.env }, ...(a.timeout_s ? { timeoutMs: a.timeout_s * 1000 } : {}) });
        const d = (r.data ?? {}) as { exit?: number | null; stdout?: string; stderr?: string; truncated?: boolean };
        const parts = [`${r.device.name}: ${d.exit === null ? "ended by a signal" : `exit ${d.exit ?? "?"}`}`];
        if (d.stdout) parts.push(`stdout:\n${d.stdout}`);
        if (d.stderr) parts.push(`stderr:\n${d.stderr}`);
        for (const f of r.attachments) parts.push(`(${f.name} in full: ${saved(f)})`);
        if (d.truncated && !r.attachments.length) parts.push("(output cut short)");
        return parts.join("\n");
      },
    );
    const path = z.string().min(1).describe("Absolute, or starting with ~ (the user's home)");
    tool(
      "device_file_read",
      "Read a file on one of the user's computers, or a byte range of it. Text comes back as text; an image comes back for you to see; anything else, or over 64 KB, is saved in your workspace for you to open.",
      { device, path, offset: z.number().int().min(0).optional(), length: z.number().int().positive().optional() },
      async (a) => {
        const r = await run({ device: a.device, op: "file_read", args: { path: a.path, offset: a.offset, length: a.length } });
        const d = (r.data ?? {}) as { path?: string; size?: number; text?: string | null };
        const head = `${d.path ?? a.path} on ${r.device.name} (${sizeOf(d.size ?? 0)})`;
        if (typeof d.text === "string") return `${head}:\n${d.text}`;
        const file = r.attachments[0];
        if (!file) throw new Error(`${r.device.name} read ${a.path} but sent nothing`);
        return new Blocks(image(file, head));
      },
    );
    tool(
      "device_file_list",
      "List a folder on one of the user's computers: each entry's name, kind, size and when it changed.",
      { device, path },
      async (a) => {
        const r = await run({ device: a.device, op: "file_list", args: { path: a.path } });
        const d = (r.data ?? {}) as { path?: string; entries?: Array<{ name: string; kind: string; size: number | null; modifiedAt: number | null }>; truncated?: boolean };
        const entries = (d.entries ?? []).map((e) => ({ name: e.kind === "dir" ? `${e.name}/` : e.name, kind: e.kind, size: e.size, changed: t(e.modifiedAt) }));
        return { path: d.path ?? a.path, device: r.device.name, entries, ...(d.truncated ? { truncated: true } : {}) };
      },
    );
    tool(
      "device_file_write",
      "Write a file on one of the user's computers: text, or a file you have (a path on this machine, a URL, or an attachment id). mode create (the default) won't replace an existing file; overwrite and append do.",
      {
        device,
        path,
        text: z.string().optional(),
        file: z.string().optional().describe("A path on this machine, a URL, or an attachment id (att_…), to copy there"),
        mode: z.enum(["create", "overwrite", "append"]).optional(),
      },
      async (a) => {
        if ((a.text === undefined) === (a.file === undefined)) throw new Error("give text or file, not both");
        const content = a.file !== undefined ? { attachmentId: await upload(a.file) } : { text: a.text };
        const r = await run({ device: a.device, op: "file_write", args: { path: a.path, ...content, mode: a.mode ?? "create" } });
        return `wrote ${sizeOf(((r.data ?? {}) as { bytes?: number }).bytes ?? 0)} to ${a.path} on ${r.device.name}`;
      },
    );
    tool(
      "device_clipboard_read",
      "What's on the clipboard of one of the user's computers: its text, or an image for you to see.",
      { device },
      async (a) => {
        const r = await run({ device: a.device, op: "clipboard_read", args: {} });
        const text = ((r.data ?? {}) as { text?: string | null }).text;
        if (typeof text === "string") return `clipboard on ${r.device.name}:\n${text}`;
        const file = r.attachments[0];
        return file ? new Blocks(image(file, `clipboard on ${r.device.name}`)) : `the clipboard on ${r.device.name} is empty`;
      },
    );
    tool(
      "device_clipboard_write",
      "Put text, or an image or file you have (a path on this machine, a URL, or an attachment id), on the clipboard of one of the user's computers.",
      { device, text: z.string().optional(), file: z.string().optional().describe("A path on this machine, a URL, or an attachment id (att_…)") },
      async (a) => {
        if ((a.text === undefined) === (a.file === undefined)) throw new Error("give text or file, not both");
        const content = a.file !== undefined ? { attachmentId: await upload(a.file) } : { text: a.text };
        const r = await run({ device: a.device, op: "clipboard_write", args: content });
        return `set the clipboard on ${r.device.name}`;
      },
    );

    tool(
      "device_open",
      "Open a web page, an app, or a file in its default app, on one of the user's computers. Give exactly one of url, app or path.",
      {
        device,
        url: z.string().optional(),
        app: z.string().optional().describe('An app\'s name ("Safari") or bundle id'),
        path: z.string().optional().describe("A file or folder on that computer"),
      },
      async (a) => {
        const r = await run({ device: a.device, op: "open", args: { url: a.url, app: a.app, path: a.path } });
        return `opened ${a.url ?? a.app ?? a.path} on ${r.device.name}`;
      },
    );
    tool(
      "device_notify",
      "Show a system notification on one of the user's computers, to get their attention at that machine. To tell them something, message_user reaches them everywhere; this is for that computer.",
      { device, title: z.string().min(1).max(200), body: z.string().max(2000) },
      async (a) => {
        const r = await run({ device: a.device, op: "notify", args: { title: a.title, body: a.body } });
        return `notified on ${r.device.name}`;
      },
    );
  }

  return server;
}
