import type { Database } from "bun:sqlite";
import { ftsQuery } from "./planning.ts";
import { DAY } from "./time.ts";

/**
 * Semantic memory. A fact is one small claim with an importance; its strength
 * decays with disuse at a rate set by that importance, is renewed every time
 * it is recalled, and holds while the fact is tied to something still alive
 * (an active goal, an open commitment, a person). Weak facts are archived —
 * out of recall, not deleted. Contradicted facts are superseded, keeping the
 * history ("lived in X until …").
 */

export type FactKind = "identity" | "preference" | "relationship" | "pattern" | "context" | "procedure" | "world";
export const FACT_KINDS: FactKind[] = ["identity", "preference", "relationship", "pattern", "context", "procedure", "world"];
export type LinkEntity = "goal" | "person" | "task" | "commitment" | "decision";

export interface Fact {
  id: number;
  content: string;
  kind: FactKind;
  importance: number;
  pinned: number;
  source: string | null;
  superseded_by: number | null;
  created_at: number;
  last_used_at: number;
  use_count: number;
  archived_at: number | null;
  archive_reason: string | null;
}

export interface ScoredFact extends Fact {
  strength: number;
  links: Array<{ entity: LinkEntity; entity_id: number }>;
}

/** Days until an unused fact's strength halves, by importance 1–10. */
const HALF_LIFE_DAYS = [0, 3, 7, 10, 14, 30, 45, 90, 180, 365, 730];
/** Below this an unpinned, unlinked fact is archived by maintenance. */
export const ARCHIVE_BELOW = 0.05;

export function strength(f: Pick<Fact, "importance" | "pinned" | "last_used_at" | "use_count">, now: number, alive: boolean): number {
  if (f.pinned) return Number.POSITIVE_INFINITY;
  const days = Math.max(0, now - f.last_used_at) / DAY;
  const decay = Math.pow(0.5, days / HALF_LIFE_DAYS[f.importance]!);
  const use = 1 + 0.25 * Math.log2(1 + f.use_count);
  return (f.importance / 10) * decay * use * (alive ? 1.5 : 1);
}

export class Memory {
  constructor(private db: Database) {}

  remember(
    input: { content: string; kind: FactKind; importance: number; pinned?: boolean; source?: string; links?: Array<{ entity: LinkEntity; id: number }> },
    now = Date.now(),
  ): Fact {
    const fact = this.db
      .query(
        `INSERT INTO facts (content, kind, importance, pinned, source, created_at, last_used_at)
         VALUES ($content, $kind, $importance, $pinned, $source, $now, $now) RETURNING *`,
      )
      .get({
        content: input.content.trim(),
        kind: input.kind,
        importance: Math.min(10, Math.max(1, Math.round(input.importance))),
        pinned: input.pinned ? 1 : 0,
        source: input.source ?? null,
        now,
      }) as Fact;
    for (const l of input.links ?? []) this.link(fact.id, l.entity, l.id);
    return fact;
  }

  link(factId: number, entity: LinkEntity, entityId: number): void {
    this.db.query("INSERT OR IGNORE INTO fact_links (fact_id, entity, entity_id) VALUES ($f, $e, $i)").run({ f: factId, e: entity, i: entityId });
  }

  get(id: number): Fact | null {
    return this.db.query("SELECT * FROM facts WHERE id = $id").get({ id }) as Fact | null;
  }

  /** Replace a fact that is no longer true; the old one stays as history. */
  revise(id: number, content: string, now = Date.now(), changes: { importance?: number; pinned?: boolean } = {}): Fact {
    const old = this.get(id);
    if (!old) throw new Error(`no fact with id ${id}`);
    if (old.superseded_by) throw new Error(`fact ${id} was already superseded by ${old.superseded_by}`);
    const links = this.links(id);
    const next = this.remember(
      {
        content,
        kind: old.kind,
        importance: changes.importance ?? old.importance,
        pinned: changes.pinned ?? !!old.pinned,
        source: old.source ?? undefined,
        links: links.map((l) => ({ entity: l.entity, id: l.entity_id })),
      },
      now,
    );
    this.db
      .query("UPDATE facts SET superseded_by = $n, archived_at = $now, archive_reason = 'superseded' WHERE id = $id")
      .run({ n: next.id, now, id });
    return next;
  }

  /** Take a fact out of recall. It is archived with the reason, not erased. */
  forget(id: number, reason: string, now = Date.now()): void {
    const r = this.db.query("UPDATE facts SET archived_at = $now, archive_reason = $reason WHERE id = $id AND archived_at IS NULL").run({ now, reason, id });
    if (r.changes === 0) throw new Error(`no live fact with id ${id}`);
  }

  setPinned(id: number, pinned: boolean): void {
    this.db.query("UPDATE facts SET pinned = $p WHERE id = $id").run({ p: pinned ? 1 : 0, id });
  }

  private links(factId: number): Array<{ entity: LinkEntity; entity_id: number }> {
    return this.db.query("SELECT entity, entity_id FROM fact_links WHERE fact_id = $f").all({ f: factId }) as never;
  }

  /** Is anything this fact is about still alive? */
  private alive(factId: number): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM fact_links l WHERE l.fact_id = $f AND (
           l.entity = 'person'
           OR (l.entity = 'goal' AND EXISTS (SELECT 1 FROM goals g WHERE g.id = l.entity_id AND g.status IN ('active','paused')))
           OR (l.entity = 'task' AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = l.entity_id AND t.status IN ('todo','doing','waiting')))
           OR (l.entity = 'commitment' AND EXISTS (SELECT 1 FROM commitments c WHERE c.id = l.entity_id AND c.status = 'open'))
           OR (l.entity = 'decision' AND EXISTS (SELECT 1 FROM decisions d WHERE d.id = l.entity_id AND d.reviewed_at IS NULL))
         ) LIMIT 1`,
      )
      .get({ f: factId });
    return !!row;
  }

  private score(f: Fact, now: number): ScoredFact {
    return { ...f, strength: strength(f, now, this.alive(f.id)), links: this.links(f.id) };
  }

  /**
   * Relevant live facts for a query, ranked by text match weighted by
   * strength. Recalling a fact renews it — memory that gets used stays.
   */
  recall(query: string, opts: { limit?: number; kind?: FactKind; now?: number; reinforce?: boolean } = {}): ScoredFact[] {
    const now = opts.now ?? Date.now();
    const limit = opts.limit ?? 10;
    const q = ftsQuery(query);
    if (!q) return [];
    const rows = this.db
      .query(
        `SELECT facts.*, bm25(facts_fts) AS rank FROM facts_fts JOIN facts ON facts.id = facts_fts.rowid
         WHERE facts_fts MATCH $q AND facts.archived_at IS NULL ${opts.kind ? "AND facts.kind = $kind" : ""}
         ORDER BY rank LIMIT 50`,
      )
      .all({ q, ...(opts.kind ? { kind: opts.kind } : {}) } as never) as Array<Fact & { rank: number }>;
    const scored = rows
      .map(({ rank, ...f }) => {
        const s = this.score(f, now);
        // bm25 is negative-is-better; strength (capped for pinned) scales it.
        return { fact: s, score: -rank * (0.5 + Math.min(s.strength, 3)) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.fact);
    if (opts.reinforce !== false) this.touch(scored.map((f) => f.id), now);
    return scored;
  }

  /** The strongest live facts overall — the always-in-context profile. */
  strongest(limit: number, now = Date.now()): ScoredFact[] {
    const rows = this.db.query("SELECT * FROM facts WHERE archived_at IS NULL").all() as Fact[];
    return rows
      .map((f) => this.score(f, now))
      .sort((a, b) => b.strength - a.strength || b.importance - a.importance)
      .slice(0, limit);
  }

  private touch(ids: number[], now: number): void {
    const stmt = this.db.query("UPDATE facts SET last_used_at = $now, use_count = use_count + 1 WHERE id = $id");
    for (const id of ids) stmt.run({ now, id });
  }

  /** Nightly forgetting: archive every fact that has faded below the line. */
  fade(now = Date.now()): number {
    const rows = this.db.query("SELECT * FROM facts WHERE archived_at IS NULL AND pinned = 0").all() as Fact[];
    let n = 0;
    for (const f of rows) {
      if (this.score(f, now).strength < ARCHIVE_BELOW) {
        this.db.query("UPDATE facts SET archived_at = $now, archive_reason = 'faded' WHERE id = $id").run({ now, id: f.id });
        n++;
      }
    }
    return n;
  }

  count(): { live: number; archived: number } {
    return this.db
      .query("SELECT SUM(archived_at IS NULL) AS live, SUM(archived_at IS NOT NULL) AS archived FROM facts")
      .get() as { live: number; archived: number };
  }
}
