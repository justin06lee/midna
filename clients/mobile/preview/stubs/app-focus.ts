export { clock, minutes, parseWindow, type Window } from "@phone/focusTime";
export interface FocusStatus { authorized: boolean; shielded: boolean; minutesToday: number }
export const focus = null;
export const focusStatus = (): FocusStatus | null => null;
export const syncFocus = async (): Promise<FocusStatus | null> => null;
export const onFocusTap = (_: () => void) => ({ remove() {} });
