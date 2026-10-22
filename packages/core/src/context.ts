import type { Goal } from "./planning.ts";
import type { Store } from "./store.ts";
import { DAY, HOUR, fmt } from "./time.ts";

/**
 * The working context: what midna holds in mind at the start of every
 * session. It is rendered fresh from the database each time and every
 * section has a hard size cap — this, not an ever-growing file, is what the
 * model always sees. Everything else is a tool call away.
 *
 * It changes turn by turn, so it never goes in the system prompt, whose
 * bytes must stay the same for the prompt cache: each turn's prompt ends
 * with it. Pinned facts are the exception — they never fade or reorder, so
 * they go in the system prompt (pinnedFacts).
 */

/** A section of the working context; its body is empty while there's nothing to show. */
export interface ContextSection {
  title: string;
  body: string;
}

function capped(lines: string[], maxChars: number, empty?: string): string {
  if (lines.length === 0) return empty ?? "";
  const out: string[] = [];
  let used = 0;
  for (const [i, line] of lines.entries()) {
    if (used + line.length > maxChars) {
      out.push(`… and ${lines.length - i} more (use the tools to see them)`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}

function goalTree(goals: Goal[], tz: string): string[] {
  const byParent = new Map<number | null, Goal[]>();
  const ids = new Set(goals.map((g) => g.id));
  for (const g of goals) {
    const parent = g.parent_id != null && ids.has(g.parent_id) ? g.parent_id : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), g]);
  }
  const lines: string[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const g of byParent.get(parent) ?? []) {
      const bits = [
        `${"  ".repeat(depth)}- #${g.id} [${g.horizon}${g.status === "paused" ? ", paused" : ""}] ${g.title}`,
        g.why ? ` — why: ${g.why}` : "",
        g.success ? ` — done when: ${g.success}` : "",
        g.target_at ? ` — by ${fmt(g.target_at, tz).slice(0, 10)}` : "",
      ];
      lines.push(bits.join(""));
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines;
}

/** The working context's first section, given every turn: the time, and how midna is set up. */
export function renderNow(store: Store, now = Date.now()): string {
  const s = store.settings();
  return `## Now\n${fmt(now, s.timezone)} (${s.timezone}) · mode: ${s.mode} · model: ${s.model}` + (s.quietHours ? ` · quiet hours ${s.quietHours.start}–${s.quietHours.end}` : "");
}

/** The rest of the working context, section by section, always the same sections in the same order. */
export function contextSections(store: Store, now = Date.now()): ContextSection[] {
  const tz = store.settings().timezone;
  const p = store.planning;

  const goals = p.goals();
  const tasks = p.tasks();
  const commitments = p.commitments();
  const soonEvents = p.events(now - 2 * HOUR, now + 2 * DAY);
  const wakeups = store.schedule.pending().filter((w) => w.due_at < now + DAY && w.kind !== "system");
  const reviews = p.decisions({ dueForReview: now });
  const reconnect = p.overdueContacts(now).slice(0, 5);
  const facts = store.memory.strongest(40, now, { unpinned: true });

  const due = (ms: number | null) => (ms ? (ms < now ? ` — OVERDUE since ${fmt(ms, tz)}` : ` — due ${fmt(ms, tz)}`) : "");

  return [
    {
      title: "The user's objectives",
      body: capped(goalTree(goals, tz), 3500, "(none recorded yet — learning them is the first priority; see Onboarding)"),
    },
    {
      title: "Calendar, next 48 hours",
      body: capped(
        soonEvents.map((e) => `- #${e.id} ${fmt(e.starts_at, tz)}${e.ends_at ? `–${fmt(e.ends_at, tz).slice(-5)}` : ""} ${e.title}${e.location ? ` @ ${e.location}` : ""}${e.source !== "midna" ? ` (${e.source})` : ""}`),
        1500,
      ),
    },
    {
      title: "Open tasks",
      body: capped(
        tasks.map((t) => `- #${t.id} ${t.owner === "midna" ? "[yours] " : ""}${t.status !== "todo" ? `(${t.status}) ` : ""}P${t.priority} ${t.title}${t.goal_id ? ` → goal #${t.goal_id}` : " → NO GOAL"}${due(t.due_at)}`),
        2500,
      ),
    },
    {
      title: "Open commitments",
      body: capped(
        commitments.map((c) => `- #${c.id} ${c.direction === "mine" ? "user owes" : "owed to user by"} ${c.counterparty ?? (c.person_id ? `person #${c.person_id}` : "someone")}: ${c.what}${due(c.due_at)}`),
        1500,
      ),
    },
    { title: "Your own scheduled wakeups, next 24 hours", body: capped(wakeups.map((w) => `- #${w.id} ${fmt(w.due_at, tz)} [${w.kind}] ${w.reason}`), 1000) },
    { title: "Decisions due for review", body: capped(reviews.map((d) => `- #${d.id} ${d.title} (chose: ${d.choice ?? "?"}; expected: ${d.expected ?? "?"})`), 800) },
    {
      title: "People overdue for contact",
      body: capped(reconnect.map((x) => `- #${x.id} ${x.name}${x.relation ? ` (${x.relation})` : ""}, every ${x.contact_every_days}d, last ${x.last_contact_at ? fmt(x.last_contact_at, tz).slice(0, 10) : "never"}`), 600),
    },
    { title: "What you know about the user (strongest memories)", body: capped(facts.map((f) => `- #${f.id} (${f.kind}) ${f.content}`), 3500, "(nothing yet)") },
  ];
}

/** The whole working context as one text: the clock, then every section with something in it. */
export function renderContext(store: Store, now = Date.now()): string {
  return [renderNow(store, now), ...contextSections(store, now).filter((x) => x.body).map((x) => `## ${x.title}\n${x.body}`)].join("\n\n");
}

/** The pinned facts, one line each, the most important first; "" while none is pinned. */
export function pinnedFacts(store: Store): string {
  return capped(store.memory.pinned().map((f) => `- #${f.id} (${f.kind}) ${f.content}`), 3500);
}
