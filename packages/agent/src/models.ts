import { createProvider, loadHostEngineConfig } from "@justin06lee/yagami";
import type { Account, BrainModel } from "@midna/protocol";
import { claudeConfigDir } from "./accounts.ts";
import { installedBrains } from "./brain.ts";
import { isHermes } from "./hermes.ts";

/** How long a harness's list is kept: a model picker asks every time it opens, and each ask starts the harness. */
const KEPT_MS = 10 * 60_000;

type Lister = (id: string, account?: Account) => Promise<BrainModel[]>;

/** The harness's own answer, through yagami: Claude Code's supported models, Codex's catalogue, an ACP agent's model option. No tokens spent. */
const ask: Lister = async (id, account) => {
  const entry = loadHostEngineConfig().providerConfig?.[id] ?? {};
  const configDir = id === "claude" && account ? claudeConfigDir(account) : undefined;
  const models = await createProvider(id, { ...entry, ...(configDir ? { configDir } : {}) }, { appName: "midna" }).listModels();
  return models
    // yagami's "default" row is its own alias for Sonnet, not a model of Claude's.
    .filter((m) => !(id === "claude" && m.id === "default"))
    .map((m) => ({ id: m.id, name: m.display_name, ...(m.description ? { description: m.description } : {}), ...(m.resolved_model ? { resolved: m.resolved_model } : {}), ...(m.is_default ? { default: true } : {}) }));
};

const kept = new Map<string, { at: number; models: Promise<BrainModel[]> }>();

/**
 * The models a harness on this machine offers, each id being what follows
 * the provider in a model ref ("claude:<id>"). Claude's are the account's.
 * Hermes has none to choose from. A list is kept for ten minutes; a failed
 * ask isn't kept.
 */
export function brainModels(id: string, account?: Account, deps: { list?: Lister; brains?: typeof installedBrains } = {}): Promise<BrainModel[]> {
  if (isHermes(id)) return Promise.resolve([]);
  const brain = (deps.brains ?? installedBrains)().find((b) => b.id === id);
  if (!brain) return Promise.reject(new Error(`unknown provider "${id}"`));
  if (!brain.installed) return Promise.reject(new Error(`${brain.label} isn't installed on this machine (${brain.installHint})`));
  const key = id === "claude" ? `claude@${account ?? "work"}` : id;
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < KEPT_MS) return hit.models;
  const models = (deps.list ?? ask)(id, id === "claude" ? account ?? "work" : undefined);
  kept.set(key, { at: Date.now(), models });
  models.catch(() => kept.get(key)?.models === models && kept.delete(key));
  return models;
}
