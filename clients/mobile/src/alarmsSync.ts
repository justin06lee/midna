/**
 * The phone's side of midna's alarms, kept free of Expo so it can be tested
 * under bun: take midna's list (as a push brought it, or fetched), hand it to
 * iOS, and tell midna what iOS holds. One sync at a time, and never an older
 * list over a newer one.
 */
import { MidnaError, type Alarm, type AlarmReport, type AlarmsState } from "@midna/protocol";

/** What a sync needs of midna: MidnaClient has both. */
export interface AlarmsHost {
  alarms(): Promise<AlarmsState>;
  reportAlarms(report: AlarmReport): Promise<unknown>;
}

/** midna's silent push (`midna: "alarms"`): the list as it stood at `asOf`; without them, the list is too long for a push. */
export interface PushedAlarms {
  alarms?: Alarm[];
  asOf?: number;
}

/** What a sync needs of the phone. */
export interface AlarmsSide {
  /** Make iOS hold exactly these, asking the user to allow alarms first when `ask`; what iOS holds afterwards. */
  apply(alarms: Alarm[], ask: boolean): Promise<AlarmReport>;
  /** midna's clock when the list last given to iOS was read (kept across launches); 0 before the first. */
  lastAsOf(): number;
  setAsOf(asOf: number): void;
}

/** How a sync ended: midna's list, what iOS holds of it, and whether midna has been told. */
export interface AlarmsOnPhone {
  alarms: Alarm[];
  held: AlarmReport;
  reported: boolean;
}

/** The alarms iOS holds of midna's list, as the versions midna has now. */
export const heldOf = (on: AlarmsOnPhone): Alarm[] => on.alarms.filter((a) => on.held.scheduled.some((s) => s.id.toLowerCase() === a.id && s.updatedAt === a.updatedAt));

/** Still to ring: a recurring alarm, or a one-off ahead. */
export const upcoming = (alarms: Alarm[], now = Date.now()): Alarm[] => alarms.filter((a) => a.at === null || a.at > now);

export function alarmSync(side: AlarmsSide) {
  let chain: Promise<unknown> = Promise.resolve();

  async function once(host: AlarmsHost | null, opts: { ask?: boolean; pushed?: PushedAlarms }): Promise<AlarmsOnPhone | null> {
    const p = opts.pushed;
    // A push that comes late carries a list older than the one iOS has: midna is asked instead.
    let list = p?.alarms && p.asOf !== undefined && p.asOf >= side.lastAsOf() ? { alarms: p.alarms, asOf: p.asOf } : null;
    if (!list) {
      if (!host) return null;
      try {
        list = await host.alarms();
      } catch (err) {
        // A midna before alarms: nothing to hold.
        if (err instanceof MidnaError && err.status === 404) return null;
        throw err;
      }
    }
    const held = await side.apply(list.alarms, opts.ask ?? false);
    side.setAsOf(list.asOf);
    // iOS has the alarms whether or not midna hears of it now; the next sync says it again.
    const reported = host
      ? await host.reportAlarms(held).then(
          () => true,
          () => false,
        )
      : false;
    return { alarms: list.alarms, held, reported };
  }

  return {
    /**
     * Bring iOS up to midna's list and tell midna what it holds: `pushed` is
     * the list a push brought, else it is fetched from `host` (null when the
     * phone has no token it can read now). Null when there was nothing to go
     * by. Each waits for the one before.
     */
    sync(host: AlarmsHost | null, opts: { ask?: boolean; pushed?: PushedAlarms } = {}): Promise<AlarmsOnPhone | null> {
      const next = chain.then(() => once(host, opts));
      chain = next.catch(() => {});
      return next;
    },
  };
}
