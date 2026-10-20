import type { Database } from "bun:sqlite";
import type { Approval, ApprovalAnswer, Capability, CommandDecision, CommandOutcome, DeviceCommandRecord, HandsHello, HandsStateUpdate, Op } from "@midna/protocol";

/**
 * Device hands (docs/device-hands.md): what each of the user's computers
 * last said it is and offers, and what midna had each one do. The live
 * connections are the daemon's; this is what outlasts them — a device that
 * went offline is still listed, with when it was last seen, and every
 * command stays in its audit log.
 */

/** A device's last hello, with the state updates since folded in. The nonce was that connection's alone, so it isn't kept. */
export type HandsSnapshot = Omit<HandsHello, "nonce">;

export interface HandsRecord {
  deviceId: string;
  name: string;
  hello: HandsSnapshot;
  lastSeenAt: number;
}

interface CommandRow {
  id: string;
  device_id: string;
  episode_id: number | null;
  op: Op;
  args: string;
  decision: CommandDecision;
  decided_by: string | null;
  reason: string | null;
  started_at: number;
  ended_at: number | null;
  outcome: CommandOutcome | null;
  summary: string | null;
  error_code: string | null;
  attachments: string | null;
  approval_id: string | null;
}

interface ApprovalRow {
  id: string;
  device_id: string;
  device_name: string;
  capability: Capability;
  op: Op;
  summary: string;
  command_id: string;
  episode_id: number | null;
  outbox_id: number | null;
  requested_at: number;
  expires_at: number;
  state: Approval["state"];
  answer: ApprovalAnswer | null;
  answered_by: string | null;
  answered_via: string | null;
  answered_at: number | null;
}

const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id,
  deviceId: r.device_id,
  deviceName: r.device_name,
  capability: r.capability,
  op: r.op,
  summary: r.summary,
  commandId: r.command_id,
  episodeId: r.episode_id,
  outboxId: r.outbox_id,
  requestedAt: r.requested_at,
  expiresAt: r.expires_at,
  state: r.state,
  answer: r.answer,
  answeredBy: r.answered_by,
  answeredVia: r.answered_via,
  answeredAt: r.answered_at,
});
const APPROVAL = "SELECT a.*, d.name AS device_name FROM approvals a JOIN devices d ON d.id = a.device_id";

/** The most of a result the audit log keeps. */
export const SUMMARY_MAX = 4096;
const cap = (s: string | null | undefined) => (s == null ? null : s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s);

const toRecord = (r: CommandRow): DeviceCommandRecord => ({
  id: r.id,
  deviceId: r.device_id,
  episodeId: r.episode_id,
  op: r.op,
  args: JSON.parse(r.args),
  decision: r.decision,
  decidedBy: r.decided_by,
  reason: r.reason,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  outcome: r.outcome,
  summary: r.summary,
  errorCode: r.error_code,
  attachments: r.attachments ? JSON.parse(r.attachments) : [],
  approvalId: r.approval_id,
});

export class Hands {
  constructor(private db: Database) {}

  /** A device said hello: this is what it is and offers now. */
  saveHello(deviceId: string, hello: HandsHello, now = Date.now()): void {
    const { nonce: _, ...snapshot } = hello;
    this.db
      .query(
        `INSERT INTO hands_devices (device_id, hello, last_seen_at) VALUES ($d, $h, $now)
         ON CONFLICT(device_id) DO UPDATE SET hello = $h, last_seen_at = $now`,
      )
      .run({ d: deviceId, h: JSON.stringify(snapshot), now });
  }

  /** Fold what changed into the device's snapshot. */
  update(deviceId: string, change: Omit<HandsStateUpdate, "session">, now = Date.now()): HandsSnapshot | null {
    const row = this.get(deviceId);
    if (!row) return null;
    const hello: HandsSnapshot = { ...row.hello };
    if (change.state) hello.state = change.state;
    if (change.offers) hello.offers = change.offers;
    if (change.permissions) hello.permissions = { ...hello.permissions, ...change.permissions };
    if (change.automation) hello.automation = { ...hello.automation, ...change.automation };
    if (change.displays) hello.displays = change.displays;
    this.db.query("UPDATE hands_devices SET hello = $h, last_seen_at = $now WHERE device_id = $d").run({ d: deviceId, h: JSON.stringify(hello), now });
    return hello;
  }

  seen(deviceId: string, now = Date.now()): void {
    this.db.query("UPDATE hands_devices SET last_seen_at = $now WHERE device_id = $d").run({ d: deviceId, now });
  }

  get(deviceId: string): HandsRecord | null {
    return this.list().find((r) => r.deviceId === deviceId) ?? null;
  }

  /** Every paired device that has offered its hands, in pairing order; revoked ones are gone. */
  list(): HandsRecord[] {
    const rows = this.db
      .query(
        `SELECT h.device_id, d.name, h.hello, h.last_seen_at FROM hands_devices h JOIN devices d ON d.id = h.device_id
         WHERE d.revoked_at IS NULL ORDER BY d.created_at`,
      )
      .all() as Array<{ device_id: string; name: string; hello: string; last_seen_at: number }>;
    return rows.map((r) => ({ deviceId: r.device_id, name: r.name, hello: JSON.parse(r.hello), lastSeenAt: r.last_seen_at }));
  }

  /** A command decided: sent on, or refused before it went out. */
  record(
    c: {
      id: string;
      deviceId: string;
      episodeId: number | null;
      op: Op;
      args: Record<string, unknown>;
      decision: CommandDecision;
      decidedBy?: string | null;
      reason?: string | null;
      approvalId?: string | null;
    },
    now = Date.now(),
  ): void {
    this.db
      .query(
        `INSERT INTO device_commands (id, device_id, episode_id, op, args, decision, decided_by, reason, started_at, ended_at, approval_id)
         VALUES ($id, $d, $e, $op, $args, $decision, $by, $reason, $now, $ended, $approval)`,
      )
      .run({
        id: c.id,
        d: c.deviceId,
        e: c.episodeId,
        op: c.op,
        args: JSON.stringify(c.args),
        decision: c.decision,
        by: c.decidedBy ?? null,
        reason: cap(c.reason),
        now,
        // A refused or denied command is over as soon as it is decided.
        ended: c.decision === "refused" || c.decision === "denied" ? now : null,
        approval: c.approvalId ?? null,
      });
  }

  /** How a command that went out ended. Only the first ending counts. */
  finish(
    id: string,
    end: { outcome: CommandOutcome; summary?: string | null; errorCode?: string | null; reason?: string | null; attachments?: string[] },
    now = Date.now(),
  ): boolean {
    return (
      this.db
        .query(
          `UPDATE device_commands SET ended_at = $now, outcome = $o, summary = $s, error_code = $code, reason = COALESCE($reason, reason), attachments = $a
           WHERE id = $id AND outcome IS NULL`,
        )
        .run({ id, now, o: end.outcome, s: cap(end.summary), code: end.errorCode ?? null, reason: cap(end.reason), a: end.attachments?.length ? JSON.stringify(end.attachments) : null }).changes === 1
    );
  }

  command(id: string): DeviceCommandRecord | null {
    const r = this.db.query("SELECT * FROM device_commands WHERE id = $id").get({ id }) as CommandRow | null;
    return r ? toRecord(r) : null;
  }

  /** What midna had a device do, newest first. */
  commands(deviceId: string, limit = 200): DeviceCommandRecord[] {
    return (this.db.query("SELECT * FROM device_commands WHERE device_id = $d ORDER BY started_at DESC, rowid DESC LIMIT $n").all({ d: deviceId, n: limit }) as CommandRow[]).map(toRecord);
  }

  // ── approvals ────────────────────────────────────────────────────────

  /** A command waits for a person's yes. */
  requestApproval(
    a: { id: string; deviceId: string; capability: Capability; op: Op; summary: string; commandId: string; episodeId: number | null; outboxId: number | null; expiresAt: number },
    now = Date.now(),
  ): Approval {
    this.db
      .query(
        `INSERT INTO approvals (id, device_id, capability, op, summary, command_id, episode_id, outbox_id, requested_at, expires_at)
         VALUES ($id, $d, $c, $op, $s, $cmd, $e, $o, $now, $x)`,
      )
      .run({ id: a.id, d: a.deviceId, c: a.capability, op: a.op, s: a.summary, cmd: a.commandId, e: a.episodeId, o: a.outboxId, now, x: a.expiresAt });
    return this.approval(a.id)!;
  }

  approval(id: string): Approval | null {
    const r = this.db.query(`${APPROVAL} WHERE a.id = $id`).get({ id }) as ApprovalRow | null;
    return r ? toApproval(r) : null;
  }

  /** The approval asked by this question in chat. */
  approvalAsked(outboxId: number): Approval | null {
    const r = this.db.query(`${APPROVAL} WHERE a.outbox_id = $o`).get({ o: outboxId }) as ApprovalRow | null;
    return r ? toApproval(r) : null;
  }

  pendingApprovals(): Approval[] {
    return (this.db.query(`${APPROVAL} WHERE a.state = 'pending' ORDER BY a.requested_at`).all() as ApprovalRow[]).map(toApproval);
  }

  /** The first answer wins: null when the approval was already over. */
  answerApproval(id: string, a: { answer: ApprovalAnswer; by: string; via: string }, now = Date.now()): Approval | null {
    const r = this.db
      .query(
        `UPDATE approvals SET state = $state, answer = $answer, answered_by = $by, answered_via = $via, answered_at = $now
         WHERE id = $id AND state = 'pending'`,
      )
      .run({ id, state: a.answer === "deny" ? "denied" : "allowed", answer: a.answer, by: a.by, via: a.via, now });
    return r.changes ? this.approval(id) : null;
  }

  /** Nobody answered in time, or nobody waits any more. Null when it was already over. */
  closeApproval(id: string, state: "expired" | "cancelled", now = Date.now()): Approval | null {
    const r = this.db.query("UPDATE approvals SET state = $state, answered_at = $now WHERE id = $id AND state = 'pending'").run({ id, state, now });
    return r.changes ? this.approval(id) : null;
  }

  /** A fresh "Allow for 10 min" for this device and capability. */
  grant(deviceId: string, capability: Capability, grantMs: number, now = Date.now()): Approval | null {
    const r = this.db
      .query(`${APPROVAL} WHERE a.device_id = $d AND a.capability = $c AND a.answer = 'allow_10_min' AND a.answered_at > $since ORDER BY a.answered_at DESC LIMIT 1`)
      .get({ d: deviceId, c: capability, since: now - grantMs }) as ApprovalRow | null;
    return r ? toApproval(r) : null;
  }

  /** Forget commands that ended (or, cut off, started), and approvals that closed, before `before`. */
  prune(before: number): number {
    const commands = this.db.query("DELETE FROM device_commands WHERE COALESCE(ended_at, started_at) < $b").run({ b: before }).changes;
    const approvals = this.db.query("DELETE FROM approvals WHERE state != 'pending' AND answered_at < $b").run({ b: before }).changes;
    return commands + approvals;
  }
}
