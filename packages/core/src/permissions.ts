import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { AskedPermission } from "@midna/protocol";

interface Row {
  id: string;
  device_id: string;
  kind: string;
  summary: string;
  scope: string;
  reason: string | null;
  data: string | null;
  status: AskedPermission["status"];
  decided_by: AskedPermission["decidedBy"];
  decision_reason: string | null;
  approved_until: number | null;
  requested_at: number;
  expires_at: number;
  decided_at: number | null;
}

/** An ask as kept: what the asker sees, and what only midna does (who asked, their reason, the details). */
export interface PermissionRecord extends AskedPermission {
  deviceId: string;
  askersReason: string | null;
  data: string | null;
}

const record = (r: Row): PermissionRecord => ({
  id: r.id,
  kind: r.kind,
  summary: r.summary,
  scope: r.scope,
  status: r.status,
  decidedBy: r.decided_by,
  reason: r.decision_reason,
  approvedUntil: r.approved_until,
  requestedAt: r.requested_at,
  expiresAt: r.expires_at,
  decidedAt: r.decided_at,
  deviceId: r.device_id,
  askersReason: r.reason,
  data: r.data,
});

/** What the asker is told: nothing of its own reason or details back, only the decision. */
export const asAnswer = ({ deviceId: _d, askersReason: _r, data: _x, ...p }: PermissionRecord): AskedPermission => p;

/**
 * Asks for midna's permission from programs the user runs, and what became
 * of each: kept, so a decision and its reason can be looked up later.
 * Deciding (midna's brain, the user) is the daemon's.
 */
export class Permissions {
  constructor(private readonly db: Database) {}

  add(a: { deviceId: string; kind: string; summary: string; scope: string; reason?: string; data?: string; expiresAt: number }, now = Date.now()): PermissionRecord {
    const id = "perm_" + randomBytes(9).toString("base64url");
    this.db
      .query(
        `INSERT INTO permissions (id, device_id, kind, summary, scope, reason, data, requested_at, expires_at)
         VALUES ($id, $d, $k, $s, $scope, $r, $data, $now, $x)`,
      )
      .run({ id, d: a.deviceId, k: a.kind, s: a.summary, scope: a.scope, r: a.reason ?? null, data: a.data ?? null, now, x: a.expiresAt });
    return this.get(id)!;
  }

  get(id: string): PermissionRecord | null {
    const r = this.db.query("SELECT * FROM permissions WHERE id = $id").get({ id }) as Row | null;
    return r ? record(r) : null;
  }

  /** Decide one still pending; the first decision stands. Null when it was decided already, or never asked. */
  decide(id: string, d: { status: "approved" | "denied" | "expired"; by: AskedPermission["decidedBy"]; reason: string | null; approvedUntil?: number | null }, now = Date.now()): PermissionRecord | null {
    const done = this.db
      .query(
        `UPDATE permissions SET status = $s, decided_by = $by, decision_reason = $r, approved_until = $u, decided_at = $now
         WHERE id = $id AND status = 'pending'`,
      )
      .run({ id, s: d.status, by: d.by, r: d.reason, u: d.status === "approved" ? (d.approvedUntil ?? null) : null, now });
    return done.changes ? this.get(id) : null;
  }

  /** The approval still running for this asker and scope, if there is one. */
  grant(deviceId: string, scope: string, now = Date.now()): PermissionRecord | null {
    const r = this.db
      .query("SELECT * FROM permissions WHERE device_id = $d AND scope = $s AND status = 'approved' AND approved_until > $now ORDER BY approved_until DESC LIMIT 1")
      .get({ d: deviceId, s: scope, now }) as Row | null;
    return r ? record(r) : null;
  }

  pending(): PermissionRecord[] {
    return (this.db.query("SELECT * FROM permissions WHERE status = 'pending' ORDER BY requested_at").all() as Row[]).map(record);
  }
}
