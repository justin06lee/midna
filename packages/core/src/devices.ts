import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { MINUTE } from "./time.ts";

/**
 * Every client — desktop, phone bridge, CLI on another machine — holds its
 * own token, minted by pairing. Only the hash is stored. Pairing is needed
 * even on a private mesh: makima publishes anything on localhost to every
 * machine on it.
 */

export interface Device {
  id: string;
  name: string;
  kind: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
// No 0/O/1/I/L: codes get read off one screen and typed into another.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export class Devices {
  constructor(private db: Database) {}

  /** Register a device and return its token — the only time it is visible. */
  create(name: string, kind: string, now = Date.now()): { device: Device; token: string } {
    const id = "dev_" + randomBytes(6).toString("hex");
    const token = "mdn_" + randomBytes(24).toString("base64url");
    this.db
      .query("INSERT INTO devices (id, name, kind, token_hash, created_at) VALUES ($id, $name, $kind, $h, $now)")
      .run({ id, name, kind, h: hash(token), now });
    return { device: this.get(id)!, token };
  }

  get(id: string): Device | null {
    return this.db.query("SELECT id, name, kind, created_at, last_seen_at, revoked_at FROM devices WHERE id = $id").get({ id }) as Device | null;
  }

  list(): Device[] {
    return this.db.query("SELECT id, name, kind, created_at, last_seen_at, revoked_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at").all() as Device[];
  }

  authenticate(token: string, now = Date.now()): Device | null {
    const d = this.db
      .query("SELECT id, name, kind, created_at, last_seen_at, revoked_at FROM devices WHERE token_hash = $h AND revoked_at IS NULL")
      .get({ h: hash(token) }) as Device | null;
    if (d) this.db.query("UPDATE devices SET last_seen_at = $now WHERE id = $id").run({ now, id: d.id });
    return d;
  }

  revoke(id: string, now = Date.now()): void {
    this.db.query("UPDATE devices SET revoked_at = $now WHERE id = $id").run({ now, id });
  }

  pairingCode(now = Date.now(), ttl = 10 * MINUTE): { code: string; expiresAt: number } {
    this.db.query("DELETE FROM pairing_codes WHERE expires_at < $now").run({ now });
    const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    const expiresAt = now + ttl;
    this.db.query("INSERT INTO pairing_codes (code, expires_at) VALUES ($code, $e)").run({ code, e: expiresAt });
    return { code, expiresAt };
  }

  /** Spend a pairing code on a new device. Codes are single-use. */
  pair(code: string, name: string, kind: string, now = Date.now()): { device: Device; token: string } | null {
    const normalized = code.toUpperCase().replace(/[^0-9A-Z]/g, "");
    const r = this.db.query("DELETE FROM pairing_codes WHERE code = $c AND expires_at >= $now").run({ c: normalized, now });
    if (r.changes === 0) return null;
    return this.create(name, kind, now);
  }
}
