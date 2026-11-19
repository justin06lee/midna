export { heldOf, upcoming, type AlarmsOnPhone } from "@phone/alarmsSync";
const at = Date.now() + 3 * 86_400_000;
const alarm = { id: "a1", at, label: "Wake up", updatedAt: 1 };
export const alarmAuthorization = () => "authorized" as const;
export const syncAlarms = async () => ({ alarms: [alarm], held: { authorization: "authorized", scheduled: [{ id: "a1", updatedAt: 1 }] }, reported: true }) as never;
