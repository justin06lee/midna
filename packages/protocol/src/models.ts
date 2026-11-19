import type { Account, BrainInfo, BrainModel, Status } from "./index.ts";

/**
 * What a model picker shows, worked out the same way in every app from what
 * the host says: its setting (Status), the brains installed on it, and each
 * brain's own list of models when the host can give one (0.13.7 on). A model
 * is named to the host by its ref: "claude:opus", "codex",
 * "opencode:opencode/deepseek-v4.1-flash-free".
 */

/** A provider's name as a person says it. */
const SHORT: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", gemini: "Gemini", hermes: "Hermes", copilot: "Copilot", cursor: "Cursor", qwen: "Qwen", goose: "Goose", kimi: "Kimi", kilo: "Kilo", cline: "Cline", auggie: "Auggie", amp: "Amp", grok: "Grok", droid: "Droid" };

/** Claude's aliases, which every Claude Code knows; listed even when the host can't say what it offers. */
const CLAUDE_ALIASES = ["opus", "fable", "sonnet", "haiku"];

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

const capital = (w: string) => (/^[a-z]/.test(w) ? w[0]!.toUpperCase() + w.slice(1) : w);

/** A model's id as words, for when the host hasn't named it: "claude-fable-5-2" → "Fable 5.2", "opencode/deepseek-v4.1-flash-free" → "Deepseek V4.1 Flash Free". */
function fromId(provider: string, id: string): string {
  const claude = provider === "claude" ? /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?$/.exec(id) : null;
  if (claude) return `${capital(claude[1]!)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  return id.slice(id.lastIndexOf("/") + 1).split(/[-_]/).filter(Boolean).map(capital).join(" ");
}

/** A model's name: the host's when it gave one (without the vendor it leads with: "opencode/DeepSeek V4.1" → "DeepSeek V4.1"), else its id as words. */
function nameOf(r: ModelRef, catalogue: readonly BrainModel[] | undefined, brains: readonly BrainInfo[]): string {
  if (!r.model) return providerName(r.provider, brains);
  const listed = catalogue?.find((m) => m.id === r.model)?.name;
  if (listed) return listed.slice(listed.lastIndexOf("/") + 1);
  return fromId(r.provider, r.model);
}

/** Where a model comes from inside a provider that carries several vendors' ("opencode/…" is OpenCode Zen, "ollama/…" Ollama); nothing for a provider's own. */
function vendorOf(r: ModelRef): string | undefined {
  const i = r.model?.indexOf("/") ?? -1;
  if (i <= 0) return undefined;
  const v = r.model!.slice(0, i);
  return v === "opencode" ? "Zen" : capital(v);
}

export type Catalogues = Readonly<Record<string, readonly BrainModel[] | undefined>>;

/** A model's name for a button or a status line: "Opus 5.5", "DeepSeek V4.1 Flash Free", "Codex". */
export function modelName(ref: string, brains: readonly BrainInfo[] = [], catalogues: Catalogues = {}): string {
  const r = parseModel(ref, brains.map((b) => b.id));
  return nameOf(r, catalogues[r.provider], brains);
}

export interface ModelChoice {
  /** What to send as the `model` setting. */
  ref: string;
  name: string;
  /** A few words under or beside the name: the vendor, or the host's description. */
  note?: string;
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
}

/**
 * Every installed brain and its models, the setting's marked. Each provider
 * leads with what the user is likely after: Claude's four aliases; elsewhere
 * the model set now, the fallbacks, then the provider's default. The rest of
 * what the host lists waits behind "More". Works with no catalogue at all.
 */
export function modelGroups(status: Pick<Status, "model" | "fallback">, brains: readonly BrainInfo[], catalogues: Catalogues = {}): ModelGroup[] {
  const ids = brains.map((b) => b.id);
  const current = modelRef(parseModel(status.model, ids));
  const wanted = [status.model, ...(status.fallback ?? [])].map((m) => parseModel(m, ids));
  return brains
    .filter((b) => b.installed || parseModel(current, ids).provider === b.id)
    .map((b) => {
      const catalogue = catalogues[b.id];
      const choice = (r: ModelRef): ModelChoice => {
        const ref = modelRef(r);
        const note = r.model ? vendorOf(r) ?? catalogue?.find((m) => m.id === r.model)?.description : undefined;
        return { ref, name: r.model ? nameOf(r, catalogue, brains) : b.id === "hermes" ? "Hermes" : "Default", ...(note ? { note } : {}), selected: ref === current };
      };
      const listed = (catalogue ?? []).map((m) => ({ provider: b.id, model: m.id }));
      const mine = wanted.filter((r) => r.provider === b.id);
      const lead: ModelRef[] =
        b.id === "claude"
          ? [...CLAUDE_ALIASES.filter((a) => !catalogue || catalogue.some((m) => m.id === a)).map((a) => ({ provider: b.id, model: a })), ...mine]
          : [...mine, { provider: b.id, model: null }];
      const seen = new Set<string>();
      const once = (rs: ModelRef[]) => rs.filter((r) => !seen.has(modelRef(r)) && seen.add(modelRef(r)));
      const first = once(lead);
      const rest = once(listed);
      // A short list shows whole: "More" is for a provider with dozens.
      const room = Math.max(0, SHOWN - first.length);
      const shown = rest.length <= room ? rest : [];
      return { provider: b.id, label: providerName(b.id, brains), choices: [...first, ...shown].map(choice), more: rest.slice(shown.length).map(choice) };
    });
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
      name: capital(account),
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
