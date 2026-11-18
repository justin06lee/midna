import { z } from "zod";

/**
 * Screen Time: midna holds the rules for the apps Justin chose to hold back
 * on his phone, and the phone carries them out and reports how the day went
 * (docs/screen-time.md). The phone never names the apps: Apple's picker gives
 * it opaque tokens, so the rules speak of "the held apps".
 */

/** A daily window that holds the apps, in minutes after midnight; one that ends before it starts runs past midnight. */
export const FocusWindow = z.object({ start: z.number().int().min(0).max(1439), end: z.number().int().min(0).max(1439) });
export type FocusWindow = z.infer<typeof FocusWindow>;

/** iOS monitors about 20 activities per app; the phone keeps a few for itself. */
export const MAX_FOCUS_WINDOWS = 8;

/** What a shield offers instead: a book, a study block, and a link that opens it. */
export const FocusOffer = z.object({ title: z.string().trim().min(1).max(80), url: z.string().trim().max(500).nullable() });
export type FocusOffer = z.infer<typeof FocusOffer>;

/** A lift: the shield comes down for this many minutes of use, for the reason Justin gave. Each has its own id, so the phone applies it once. */
export const FocusLift = z.object({
  id: z.string(),
  minutes: z.number().int().min(1).max(120),
  reason: z.string().trim().min(3).max(500),
  /** Who lifted it: Justin on the phone, or midna when he asked with a reason. */
  by: z.enum(["phone", "midna"]),
  at: z.number(),
});
export type FocusLift = z.infer<typeof FocusLift>;

/** The rules midna holds; the phone fetches them when it opens, and gets them in a silent push when they change. */
export const FocusRules = z.object({
  /** The held apps are shielded now, on demand. */
  held: z.boolean(),
  /** A hold ends by itself then (ms); null holds until let go. */
  heldUntil: z.number().nullable(),
  windows: z.array(FocusWindow).max(MAX_FOCUS_WINDOWS),
  offer: FocusOffer.nullable(),
  /** The latest lift; the phone applies one it hasn't yet, if it is still running. */
  lift: FocusLift.nullable(),
  updatedAt: z.number(),
});
export type FocusRules = z.infer<typeof FocusRules>;

export const DEFAULT_FOCUS_RULES: FocusRules = { held: false, heldUntil: null, windows: [], offer: null, lift: null, updatedAt: 0 };

/** PATCH /v1/focus/rules: any of the rules. Putting the shield up needs no reason; lifting goes through POST /v1/focus/lift. */
export const FocusRulesPatch = z.object({
  held: z.boolean().optional(),
  heldUntil: z.number().nullable().optional(),
  windows: z.array(FocusWindow).max(MAX_FOCUS_WINDOWS).optional(),
  offer: FocusOffer.nullable().optional(),
});
export type FocusRulesPatch = z.infer<typeof FocusRulesPatch>;

/** POST /v1/focus/lift; `endHold` lets go of the on-demand hold too, so the shield stays down after the lift (windows still hold). */
export const FocusLiftAsk = z.object({ minutes: z.number().int().min(1).max(120), reason: z.string().trim().min(3).max(500), endHold: z.boolean().optional() });
export type FocusLiftAsk = z.infer<typeof FocusLiftAsk>;

/** One day on the phone: minutes in the held apps (known in quarter hours) and how often a shield was met. */
export const FocusDay = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  minutes: z.number().int().min(0).max(1440),
  hits: z.number().int().min(0).max(100_000),
});
export type FocusDay = z.infer<typeof FocusDay>;

/** POST /v1/focus/report: how the last days went, and how Screen Time stands on the phone now. */
export const FocusReport = z.object({
  days: z.array(FocusDay).max(14),
  authorized: z.boolean(),
  shielded: z.boolean(),
  apps: z.number().int().min(0),
  categories: z.number().int().min(0),
  sites: z.number().int().min(0),
});
export type FocusReport = z.infer<typeof FocusReport>;

/** GET /v1/focus: the rules, the days the phone reported, the lifts, and the phone as it last said. */
export interface FocusState {
  rules: FocusRules;
  days: Array<FocusDay & { reportedAt: number }>;
  lifts: FocusLift[];
  phone: (Omit<FocusReport, "days"> & { reportedAt: number }) | null;
}
