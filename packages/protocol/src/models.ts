import type { Account, BrainInfo, BrainModel, Status } from "./index.ts";

/**
 * What a model picker shows, worked out the same way in every app from what
 * the host says: its setting (Status), the brains installed on it, and each
 * brain's own list of models (GET /v1/brains/:id/models, 0.13.7 on). A model
 * is named to the host by its ref: "claude:opus", "codex",
 * "opencode:opencode/deepseek-v4.1-flash-free".
 *
 * A model's name, and which model an alias stands for, come only from the
 * brain's own list. Nothing here knows a model: with no list (an older
 * host, or a brain that didn't answer) a model is shown by its id as it is
 * written, and only what the host itself names is offered.
 */

/** A provider's name as a person says it. */
const SHORT: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", gemini: "Gemini", hermes: "Hermes", copilot: "Copilot", cursor: "Cursor", qwen: "Qwen", goose: "Goose", kimi: "Kimi", kilo: "Kilo", cline: "Cline", auggie: "Auggie", amp: "Amp", grok: "Grok", droid: "Droid" };

/** How many of a provider's models show before "More". */
const SHOWN = 5;

export interface ModelRef {
  provider: string;
  /** The provider's own id for the model; null for the provider's default. */
  model: string | null;
}

/** A ref taken apart. A bare word is a provider when one has that id ("codex"), else one of Claude's models ("opus"). */
export function parseModel(ref: string, providers: readonly string[]): ModelRef {
  const i = ref.indexOf(":");
  if (i > 0) return { provider: ref.slice(0, i), model: ref.slice(i + 1) || null };
  return providers.includes(ref) || ref in SHORT ? { provider: ref, model: null } : { provider: "claude", model: ref };
}

/** The one way to write a ref, so two spellings of a model compare equal: "opus" and "claude:opus". */
export function modelRef(r: ModelRef): string {
  return r.model ? `${r.provider}:${r.model}` : r.provider;
}

export function providerName(id: string, brains: readonly BrainInfo[] = []): string {
  return SHORT[id] ?? brains.find((b) => b.id === id)?.label ?? id;
}

export type Catalogues = Readonly<Record<string, readonly BrainModel[] | undefined>>;

/** The brain's entry for a model: by its id, or the first whose alias stands for it ("claude-opus-5-5" finds "opus"). */
function entry(r: ModelRef, catalogue: readonly BrainModel[] | undefined): BrainModel | undefined {
  if (!r.model || !catalogue) return undefined;
  return catalogue.find((m) => m.id === r.model) ?? catalogue.find((m) => m.resolved === r.model);
}

/** What two refs are compared by: the model an alias stands for, when the brain says, so "opus" and "claude-opus-5-5" are one. */
function sameAs(r: ModelRef, catalogue: readonly BrainModel[] | undefined): string {
  const e = entry(r, catalogue);
  return e ? `${r.provider}:${e.resolved ?? e.id}` : modelRef(r);
}

/** A model's name: the brain's own (without the vendor it leads with: "opencode/DeepSeek V4.1" → "DeepSeek V4.1"); with no list, its id as written, less the vendor. */
function nameOf(r: ModelRef, catalogue: readonly BrainModel[] | undefined, brains: readonly BrainInfo[]): string {
  // A provider with no model named runs its own default: that model's name, when the brain says which it is.
  if (!r.model) return defaultOf(catalogue) ?? providerName(r.provider, brains);
  return bare(entry(r, catalogue)?.name ?? r.model);
}

/** A name without the vendor it leads with. */
const bare = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/** The model a brain runs when none is named, by the name it gives it; nothing when its list doesn't say. */
function defaultOf(catalogue: readonly BrainModel[] | undefined): string | undefined {
  const d = catalogue?.find((m) => m.default);
  return d ? bare(d.name) : undefined;
}

/** Where a model comes from inside a provider that carries several vendors' ("opencode/…" is OpenCode Zen, "ollama/…" Ollama); nothing for a provider's own. */
function vendorOf(r: ModelRef): string | undefined {
  const i = r.model?.indexOf("/") ?? -1;
  if (i <= 0) return undefined;
  const v = r.model!.slice(0, i);
  return v === "opencode" ? "Zen" : v[0]!.toUpperCase() + v.slice(1);
}

/**
 * The line of models an entry belongs to, read from the id the brain gives
 * it ("claude-fable-5-2" → "claude-fable"): what is left when the version
 * goes. Entries whose id has no version are each their own.
 */
function familyOf(m: BrainModel): string {
  const id = m.resolved ?? m.id;
  const cut = id.search(/[-_.:@]v?\d/);
  return cut > 0 ? id.slice(0, cut) : id;
}

/**
 * The entries a brain's list leads with: in its own order, up to where a
 * line of models comes round a second time. Claude Code lists its current
 * models first and older ones after, so this is "Opus 5.5, Fable 5.2,
 * Sonnet 5.5, Haiku 5.5" without anything here knowing those names. A list
 * with no such turn in its first few entries (a catalogue in some other
 * order) leads with nothing.
 */
function leading(catalogue: readonly BrainModel[]): BrainModel[] {
  const seen = new Set<string>();
  const out: BrainModel[] = [];
  for (const m of catalogue) {
    const f = familyOf(m);
    if (seen.has(f)) return out.length >= 2 ? out : [];
    if (out.length === SHOWN) break;
    seen.add(f);
    out.push(m);
  }
  return [];
}

/** A model's name for a button or a status line: "Opus 5.5", "DeepSeek V4.1 Flash Free", "Codex". */
export function modelName(ref: string, brains: readonly BrainInfo[] = [], catalogues: Catalogues = {}): string {
  const r = parseModel(ref, brains.map((b) => b.id));
  return nameOf(r, catalogues[r.provider], brains);
}

export interface ModelChoice {
  /** What to send as the `model` setting. */
  ref: string;
  name: string;
  /** A word beside the name: the vendor inside a provider that carries several. */
  note?: string;
  /** What the brain says of it, and the model an alias stands for: for a tooltip. */
  detail?: string;
  /** The model setting is this one. */
  selected: boolean;
}

export interface ModelGroup {
  provider: string;
  label: string;
  /** The ones to show at once. */
  choices: ModelChoice[];
  /** The rest of what the provider offers, behind "More". */
  more: ModelChoice[];
  /** False when the brain's own list isn't known: only what the host names is offered. */
  listed: boolean;
}

/**
 * Every installed brain and its models, the setting's marked. A provider
 * leads with what the user is likely after: the model set now and the
 * fallbacks, then the start of the brain's own list (Claude's current
 * models), then the provider's default where it has one to offer. The rest
 * of the list waits behind "More". With no list, a provider offers what the
 * host names and its default, and no more.
 */
export function modelGroups(status: Pick<Status, "model" | "fallback">, brains: readonly BrainInfo[], catalogues: Catalogues = {}): ModelGroup[] {
  const ids = brains.map((b) => b.id);
  const set = parseModel(status.model, ids);
  const wanted = [status.model, ...(status.fallback ?? [])].map((m) => parseModel(m, ids));
  return brains
    .filter((b) => b.installed || set.provider === b.id)
    .map((b) => {
      const catalogue = catalogues[b.id];
      const current = set.provider === b.id ? sameAs(set, catalogue) : null;
      const choice = (r: ModelRef): ModelChoice => {
        const e = entry(r, catalogue);
        const note = vendorOf(r);
        const detail = e ? [e.description, e.resolved && e.resolved !== e.id ? `${e.id} is ${e.resolved}` : e.id].filter(Boolean).join(" · ") : undefined;
        // The provider's own default says which model that is, when the brain's list marks one.
        const byDefault = defaultOf(catalogue);
        const name = r.model ? nameOf(r, catalogue, brains) : b.id === "hermes" ? "Hermes" : byDefault ? `Default (${byDefault})` : "Default";
        const what = r.model || b.id === "hermes" ? detail : `Whatever ${providerName(b.id, brains)} is set to use on the host${byDefault ? `: ${byDefault} now` : ""}`;
        return { ref: modelRef(r), name, ...(note ? { note } : {}), ...(what ? { detail: what } : {}), selected: sameAs(r, catalogue) === current };
      };
      const listed = (catalogue ?? []).map((m) => ({ provider: b.id, model: m.id }));
      const mine = wanted.filter((r) => r.provider === b.id);
      const lead = catalogue ? leading(catalogue).map((m) => ({ provider: b.id, model: m.id })) : [];
      // Claude Code has no "default" of its own to offer: yagami's is an alias for one of the listed models.
      const fallback = b.id === "claude" ? [] : [{ provider: b.id, model: null }];
      const seen = new Set<string>();
      const once = (rs: ModelRef[]) => rs.filter((r) => !seen.has(sameAs(r, catalogue)) && seen.add(sameAs(r, catalogue)));
      // The brain's leading entries keep their place; what is set or a fallback joins them when it isn't one of them.
      const first = once([...lead, ...mine, ...fallback]);
      const rest = once(listed);
      // A short list shows whole: "More" is for a provider with dozens.
      const room = Math.max(0, SHOWN - first.length);
      const shown = rest.length <= room ? rest : [];
      return { provider: b.id, label: providerName(b.id, brains), choices: [...first, ...shown].map(choice), more: rest.slice(shown.length).map(choice), listed: catalogue !== undefined || b.id === "hermes" };
    });
}

/** The providers whose lists are needed to name what the host is set to: the model, what is thinking now, and each fallback. */
export function providersInUse(status: Pick<Status, "model" | "activeModel" | "fallback">, brains: readonly BrainInfo[]): string[] {
  const ids = brains.map((b) => b.id);
  return [...new Set([status.model, status.activeModel ?? status.model, ...(status.fallback ?? [])].map((m) => parseModel(m, ids).provider))];
}

/** When a cap ends, as a status line says it: "4:00 PM" today, "Sat 1:00 AM" another day. */
export function capTime(until: number, now = Date.now(), locale?: string): string {
  const d = new Date(until);
  const time = d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
}

export interface AccountChoice {
  account: Account;
  name: string;
  /** Who it's signed in as on the host, "not signed in", or when its usage comes back. */
  note: string;
  selected: boolean;
  /** Out of usage until then (epoch ms). */
  cappedUntil?: number;
  signedIn: boolean;
}

/** The two Claude accounts, the setting's marked; none from a host that has no accounts (0.13.2 and older). */
export function accountChoices(status: Pick<Status, "account" | "accounts" | "caps">, now = Date.now()): AccountChoice[] {
  if (!status.accounts) return [];
  return (["personal", "work"] as const).map((account) => {
    const email = status.accounts![account];
    const until = status.caps?.[`claude@${account}`];
    const capped = until !== undefined && until > now;
    return {
      account,
      name: account[0]!.toUpperCase() + account.slice(1),
      note: capped ? `Out of usage until ${capTime(until, now)}` : email ?? "Not signed in",
      selected: (status.account ?? "work") === account,
      ...(capped ? { cappedUntil: until } : {}),
      signedIn: email !== null,
    };
  });
}

/**
 * What is thinking now, for the button that opens the picker: the model's
 * name, and a line for when it isn't the one that's set (the set one is out
 * of usage and a fallback has taken over).
 */
export function thinkingWith(status: Pick<Status, "model" | "activeModel" | "account" | "activeAccount" | "caps">, brains: readonly BrainInfo[] = [], catalogues: Catalogues = {}, now = Date.now()): { name: string; account?: Account; standIn?: string } {
  const ids = brains.map((b) => b.id);
  const set = parseModel(status.model, ids);
  const active = parseModel(status.activeModel ?? status.model, ids);
  const account = active.provider === "claude" ? status.activeAccount ?? status.account : undefined;
  const name = modelName(modelRef(active), brains, catalogues);
  const moved = modelRef(active) !== modelRef(set) || (set.provider === "claude" && status.account !== undefined && account !== undefined && account !== status.account);
  if (!moved) return { name, ...(account ? { account } : {}) };
  const until = status.caps?.[set.provider === "claude" && status.account ? `claude@${status.account}` : set.provider] ?? status.caps?.[set.provider];
  const was = `${modelName(modelRef(set), brains, catalogues)}${set.provider === "claude" && status.account ? ` on ${status.account}` : ""}`;
  return { name, ...(account ? { account } : {}), standIn: `${was} is out of usage${until && until > now ? ` until ${capTime(until, now)}` : ""}` };
}
