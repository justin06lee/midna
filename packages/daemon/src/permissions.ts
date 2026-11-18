import { asAnswer, type Device, type PermissionRecord, type Store } from "@midna/core";
import { APPROVAL_GRANT_MS, PERMISSION_GRANT_MAX_MIN, PERMISSION_TIMEOUT_MS, type Capability, type Op, type AskedPermission, type PermissionAsk } from "@midna/protocol";
import type { Approver } from "./hands.ts";

/**
 * Asking midna's permission (docs/permissions.md). A program the user runs
 * asks; midna's brain hears it in the background, as an event of its own,
 * and approves, denies, or asks the user with the same card a device action
 * gets. The asker waits on the answer. If midna hasn't decided by half the
 * time the asker gave, the user is asked directly, so a slow or signed-out
 * brain doesn't mean an automatic no. No decision in time is "expired".
 */

type Ask = ReturnType<typeof PermissionAsk.parse>;

export interface PermissionsOptions {
  store: Store;
  approvals: Approver;
  /** Run what is due now, rather than at the scheduler's next tick. */
  tickSoon: () => void;
}

export class PermissionDesk {
  private readonly store: Store;
  /** Whoever waits on a decision, by ask. */
  private readonly waiting = new Map<string, Set<(p: PermissionRecord) => void>>();
  private readonly timers = new Map<string, Array<ReturnType<typeof setTimeout>>>();
  /** The user is being asked about these; the abort drops the card when midna decides first, or time runs out. */
  private readonly asking = new Map<string, AbortController>();

  constructor(private readonly opts: PermissionsOptions) {
    this.store = opts.store;
    // Left pending by an earlier run: nobody could decide them while midna was down.
    for (const p of this.store.permissions.pending()) this.store.permissions.decide(p.id, { status: "expired", by: null, reason: "midna restarted before deciding" });
  }

  /** An ask from a paired program. One covered by an approval still running is approved at once. */
  ask(device: Device, ask: Ask, now = Date.now()): PermissionRecord {
    const { store } = this;
    const timeout = ask.timeoutMs ?? PERMISSION_TIMEOUT_MS;
    const kept = store.permissions.add(
      { deviceId: device.id, kind: ask.kind, summary: ask.summary, scope: ask.scope, expiresAt: now + timeout, ...(ask.reason ? { reason: ask.reason } : {}), ...(ask.data !== undefined ? { data: JSON.stringify(ask.data) } : {}) },
      now,
    );
    const grant = store.permissions.grant(device.id, ask.scope, now);
    if (grant) {
      console.log(`[midna] permission: ${device.name}: ${ask.summary.slice(0, 100)} — approved (allowed until ${new Date(grant.approvedUntil!).toISOString()})`);
      return store.permissions.decide(kept.id, { status: "approved", by: "grant", reason: `allowed for this until then by ${grant.decidedBy === "user" ? "the user" : "midna"}`, approvedUntil: grant.approvedUntil }, now)!;
    }
    // midna hears it now, in a turn of its own: an event with its own subject waits on no other.
    store.inbound.add({
      source: device.name,
      title: `asks your permission: ${ask.summary}`,
      extId: kept.id,
      subject: kept.id,
      kind: "permission.ask",
      data: JSON.stringify({ permission: kept.id, kind: ask.kind, scope: ask.scope, reason: ask.reason ?? null, decideWithinSeconds: Math.round(timeout / 1000), details: ask.data ?? null }),
      windowMs: 0,
      tz: store.settings().timezone,
    });
    this.timers.set(kept.id, [
      setTimeout(() => void this.askUser(kept.id, "midna hadn't decided yet"), timeout / 2),
      setTimeout(() => this.settle(store.permissions.decide(kept.id, { status: "expired", by: null, reason: `nobody decided within ${Math.round(timeout / 1000)} s` })), timeout),
    ]);
    console.log(`[midna] permission: ${device.name} asks: ${ask.summary.slice(0, 100)} (${kept.id})`);
    this.opts.tickSoon();
    return kept;
  }

  /** midna's own decision. Null when it was decided already (or never asked). */
  decide(id: string, d: { approve: boolean; minutes?: number; reason: string }, now = Date.now()): PermissionRecord | null {
    const minutes = d.approve && d.minutes ? Math.min(d.minutes, PERMISSION_GRANT_MAX_MIN) : 0;
    const done = this.store.permissions.decide(id, { status: d.approve ? "approved" : "denied", by: "midna", reason: d.reason, approvedUntil: minutes ? now + minutes * 60_000 : null }, now);
    if (done) console.log(`[midna] permission: midna ${d.approve ? `approved${minutes ? ` for ${minutes} min` : ""}` : "denied"} ${id}: ${d.reason.slice(0, 100)}`);
    this.settle(done);
    return done;
  }

  /**
   * Put it to the user, as a device action is: a card on their devices and a
   * question in chat, first answer wins. Returns at once; their answer
   * decides the ask. "asked" also when they were asked already.
   */
  askUser(id: string, why?: string): "asked" | "over" {
    const p = this.store.permissions.get(id);
    if (!p || p.status !== "pending") return "over";
    if (this.asking.has(id)) return "asked";
    const abort = new AbortController();
    this.asking.set(id, abort);
    const device = this.store.devices.get(p.deviceId);
    const name = device?.name ?? "a program";
    void this.opts.approvals
      .request(
        {
          deviceId: p.deviceId,
          deviceName: name,
          // Not a device operation: the card shows the summary, and "allow for 10 min" is kept per scope.
          op: "permission" as Op,
          capability: `${p.kind} ${p.scope}` as Capability,
          commandId: p.id,
          args: {},
          summary: `allow this for ${name}: ${p.summary}${p.askersReason ? ` (its reason: "${p.askersReason.slice(0, 200)}")` : ""}${why ? ` — asking you because ${why}` : ""}`,
          episodeId: null,
        },
        abort.signal,
      )
      .then((d) => {
        this.asking.delete(id);
        if (abort.signal.aborted) return;
        const tenMinutes = d.approved && d.approvalId ? this.store.hands.approval(d.approvalId)?.answer === "allow_10_min" : false;
        const done = this.store.permissions.decide(id, {
          status: d.approved ? "approved" : "denied",
          by: "user",
          reason: d.approved ? `allowed by ${d.by ?? "the user"}` : (d.reason ?? "the user said no"),
          approvedUntil: tenMinutes ? Date.now() + APPROVAL_GRANT_MS : null,
        });
        if (done) console.log(`[midna] permission: ${done.reason} (${id})`);
        this.settle(done);
      });
    return "asked";
  }

  /** The ask, once it is decided or `waitMs` has passed. */
  async wait(id: string, waitMs: number): Promise<PermissionRecord | null> {
    const now = this.store.permissions.get(id);
    if (!now || now.status !== "pending" || waitMs <= 0) return now;
    return new Promise((resolve) => {
      const waiters = this.waiting.get(id) ?? new Set();
      this.waiting.set(id, waiters);
      const done = (p: PermissionRecord) => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve(p);
      };
      const timer = setTimeout(() => done(this.store.permissions.get(id)!), waitMs);
      waiters.add(done);
    });
  }

  /** What still waits, for midna to look at. */
  pending(): PermissionRecord[] {
    return this.store.permissions.pending();
  }

  get(id: string): PermissionRecord | null {
    return this.store.permissions.get(id);
  }

  /** Stop the timers and drop any card still up: the daemon is going down. */
  close(): void {
    for (const t of this.timers.values()) t.forEach(clearTimeout);
    this.timers.clear();
    for (const a of this.asking.values()) a.abort();
  }

  /** It's decided: stop its timers, take down a card still up, and answer whoever waits. */
  private settle(p: PermissionRecord | null): void {
    if (!p) return;
    this.timers.get(p.id)?.forEach(clearTimeout);
    this.timers.delete(p.id);
    this.asking.get(p.id)?.abort();
    this.asking.delete(p.id);
    for (const done of [...(this.waiting.get(p.id) ?? [])]) done(p);
    this.waiting.delete(p.id);
  }
}

export const answer = (p: PermissionRecord): AskedPermission => asAnswer(p);
