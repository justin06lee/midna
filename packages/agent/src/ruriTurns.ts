/**
 * Whose turn a ruri project event is about. midna sends ruri its prompts
 * with a clientId starting MIDNA_PROMPT_PREFIX (rc.mjs on the Mac), and
 * ruri keeps that as the prompt's id. Each chat in a project.idle or
 * project.blocked event names its latest prompt from outside the team
 * (chats[].lastPrompt: typed by the user, or sent over ruri's socket;
 * never another agent's letter, nor ruri's own words after a compaction).
 * The latest of those across the event's chats decides: midna's means the
 * event is about work midna started; anyone else's means the user is
 * running that project themselves, and the event isn't midna's to hear.
 */

/** What every prompt midna sends ruri has its clientId start with. */
export const MIDNA_PROMPT_PREFIX = "midna-";

export type RuriTurn =
  /** midna started the work the event is about. */
  | { by: "midna" }
  /** Someone else did (the user, in ruri itself); why, in a few words. */
  | { by: "other"; why: string }
  /** Not a project event, or a ruri from before chats[].lastPrompt: there is no telling. */
  | null;

const PROJECT_EVENTS = new Set(["project.idle", "project.blocked"]);

export function ruriTurn(data: unknown): RuriTurn {
  if (!data || typeof data !== "object") return null;
  const d = data as { kind?: unknown; project?: { name?: unknown }; chats?: unknown };
  if (typeof d.kind !== "string" || !PROJECT_EVENTS.has(d.kind) || !Array.isArray(d.chats)) return null;
  const chats = d.chats.filter((c): c is Record<string, unknown> => !!c && typeof c === "object");
  // A ruri that doesn't name prompts yet: hear it, as before.
  if (!chats.some((c) => "lastPrompt" in c)) return null;
  const project = typeof d.project?.name === "string" ? d.project.name : "the project";
  let latest: { id: string; at: number; chat: string } | null = null;
  for (const c of chats) {
    const p = c.lastPrompt as { id?: unknown; at?: unknown } | null | undefined;
    if (!p || typeof p.id !== "string" || typeof p.at !== "string") continue;
    const at = Date.parse(p.at);
    if (Number.isNaN(at)) continue;
    if (!latest || at > latest.at) latest = { id: p.id, at, chat: typeof c.name === "string" ? c.name : "a chat" };
  }
  if (!latest) return { by: "other", why: `no prompt in ${project} came from midna` };
  if (latest.id.startsWith(MIDNA_PROMPT_PREFIX)) return { by: "midna" };
  return { by: "other", why: `the latest prompt in ${project} (${latest.chat}) wasn't midna's` };
}
