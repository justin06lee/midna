import type { Database } from "bun:sqlite";
import type { PushRegistration, PushState } from "@midna/protocol";

/** A phone's Apple push token and the pairing it came with. */
export interface PushToken {
  token: string;
  device_id: string;
  environment: PushRegistration["environment"];
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
}

/** A push still pending this long after it started never finished (a restart): it counts as failed. */
export const PUSH_STALE_MS = 60_000;

/**
 * Push notifications' records: the phones to push to, and each alert's push
 * outcome. Sending is the daemon's; this keeps what a restart must not lose.
 */
export class Push {
  constructor(private readonly db: Database) {}

  /**
   * Keep a phone's token, moving it to this pairing if another had it. False
   * when it was kept just so already (a phone saying it again): nothing is
   * written. One Apple refused is written again, which clears that.
   */
  register(deviceId: string, reg: PushRegistration, now = Date.now()): boolean {
    const token = reg.token.toLowerCase();
    const had = this.db.query("SELECT device_id, environment, last_error FROM push_tokens WHERE token = $token").get({ token }) as Pick<PushToken, "device_id" | "environment" | "last_error"> | null;
    if (had && had.device_id === deviceId && had.environment === reg.environment && had.last_error === null) return false;
    this.db
      .query(
        `INSERT INTO push_tokens (token, device_id, environment, created_at) VALUES ($token, $device, $env, $now)
         ON CONFLICT(token) DO UPDATE SET device_id = $device, environment = $env, last_error = NULL`,
      )
      .run({ token, device: deviceId, env: reg.environment, now });
    return true;
  }

  unregister(token: string, deviceId?: string): boolean {
    const t = token.toLowerCase();
    const r = deviceId
      ? this.db.query("DELETE FROM push_tokens WHERE token = $t AND device_id = $d").run({ t, d: deviceId })
      : this.db.query("DELETE FROM push_tokens WHERE token = $t").run({ t });
    return r.changes > 0;
  }

  /** Tokens of pairings still in use; a revoked pairing's phone gets nothing. */
  tokens(): PushToken[] {
    return this.db
      .query(
        `SELECT p.token, p.device_id, p.environment, p.created_at, p.last_ok_at, p.last_error FROM push_tokens p
         JOIN devices d ON d.id = p.device_id WHERE d.revoked_at IS NULL ORDER BY p.created_at`,
      )
      .all() as PushToken[];
  }

  /** Apple took a push for this token; it may have learned which environment the token is. */
  ok(token: string, environment: PushRegistration["environment"], now = Date.now()): void {
    this.db.query("UPDATE push_tokens SET last_ok_at = $now, last_error = NULL, environment = $env WHERE token = $t").run({ now, env: environment, t: token });
  }

  failed(token: string, error: string): void {
    this.db.query("UPDATE push_tokens SET last_error = $e WHERE token = $t").run({ e: error, t: token });
  }

  /** Record an alert's push: pending when it starts, then sent, failed or none. */
  record(outboxId: number, state: PushState, detail: string | null = null, now = Date.now()): void {
    this.db
      .query(
        `INSERT INTO push_sends (outbox_id, state, detail, at) VALUES ($id, $state, $detail, $now)
         ON CONFLICT(outbox_id) DO UPDATE SET state = $state, detail = $detail, at = $now`,
      )
      .run({ id: outboxId, state, detail, now });
  }

  /** What became of an alert's push; null when none was recorded (Telegram-only, or before 0.12). */
  outcome(outboxId: number, now = Date.now()): { state: PushState; detail: string | null } | null {
    const row = this.db.query("SELECT state, detail, at FROM push_sends WHERE outbox_id = $id").get({ id: outboxId }) as
      | { state: PushState; detail: string | null; at: number }
      | null;
    if (!row) return null;
    if (row.state === "pending" && now - row.at > PUSH_STALE_MS) return { state: "failed", detail: "never finished" };
    return { state: row.state, detail: row.detail };
  }
}
