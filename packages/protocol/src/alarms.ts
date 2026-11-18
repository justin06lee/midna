import { z } from "zod";

/**
 * Alarms on the user's iPhone, set by midna: midna holds the list, the phone
 * fetches it (when the app is opened, when a silent push brings it, and now
 * and then in the background) and hands each one to iOS's own alarms
 * (AlarmKit, iOS 26), which ring through silent mode and a Focus as the
 * Clock app's do. The phone says back what iOS holds, so midna knows an
 * alarm is really on the phone. After 0.13.4.
 */

/** iOS shows the label over the ringing alarm. */
export const ALARM_LABEL_MAX = 60;
/** Upcoming one-off alarms and recurring ones together; the list also rides in one push (4 KB). */
export const MAX_ALARMS = 20;
/**
 * A one-off alarm stays in the phone's list this long after it rang: a sync
 * while it rings must not take it away.
 */
export const ALARM_GRACE_MS = 60 * 60_000;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time of day is "HH:MM", like "04:30"');
/** ISO weekdays: 1 is Monday, 7 is Sunday. */
const weekday = z.number().int().min(1).max(7);

/** One alarm, as midna holds it and the phone is given it. */
export interface Alarm {
  /** A UUID: iOS knows the alarm by the same one. */
  id: string;
  label: string;
  /** A one-off alarm: when it rings, ms since the epoch. Null for a recurring one. */
  at: number | null;
  /** A recurring alarm: "HH:MM" on the phone's own clock. Null for a one-off. */
  time: string | null;
  /** A recurring alarm: the ISO weekdays it rings on (1 is Monday), all seven for every day. Empty for a one-off. */
  days: number[];
  /** When it was set or last changed, ms: the phone says which version of it iOS holds. */
  updatedAt: number;
}

/** POST /v1/alarms: a new alarm, or with `id` a change to one. Either `at` (one-off) or `time` (recurring; every day without `days`). */
export const AlarmSet = z
  .object({
    id: z.string().uuid().optional(),
    label: z.string().trim().min(1).max(ALARM_LABEL_MAX),
    at: z.number().int().positive().optional(),
    time: clock.optional(),
    days: z.array(weekday).max(7).optional(),
  })
  .refine((a) => (a.at === undefined) !== (a.time === undefined), "an alarm rings once (at) or repeats (time), not both")
  .refine((a) => a.time !== undefined || a.days === undefined, "days go with a repeating alarm (time)");
export type AlarmSet = z.input<typeof AlarmSet>;

/** Whether the user lets midna set alarms on the phone; "unsupported" before iOS 26, or in a build without alarms. */
export const AlarmAuthorization = z.enum(["authorized", "denied", "notDetermined", "unsupported"]);
export type AlarmAuthorization = z.infer<typeof AlarmAuthorization>;

/** POST /v1/alarms/report: what iOS holds on this phone after it went through midna's list. */
export const AlarmReport = z.object({
  authorization: AlarmAuthorization,
  /** The alarms iOS holds, each as the version the phone was given. */
  scheduled: z.array(z.object({ id: z.string().max(64), updatedAt: z.number() })).max(100),
  /** Alarms iOS refused, and why. */
  problems: z.array(z.object({ id: z.string().max(64), error: z.string().max(300) })).max(100).optional(),
});
export type AlarmReport = z.infer<typeof AlarmReport>;

/** A phone's last report. */
export interface AlarmPhone extends AlarmReport {
  /** The phone's device id and name. */
  device: string;
  name: string;
  reportedAt: number;
}

/** GET /v1/alarms: the alarms the phone should hold, and what each phone said it holds. */
export interface AlarmsState {
  alarms: Alarm[];
  phones: AlarmPhone[];
}

/** Whether a phone said iOS holds this alarm, as it stands now. */
export const onPhone = (alarm: Alarm, phones: AlarmPhone[]): boolean =>
  phones.some((p) => p.authorization === "authorized" && p.scheduled.some((s) => s.id.toLowerCase() === alarm.id && s.updatedAt === alarm.updatedAt));
