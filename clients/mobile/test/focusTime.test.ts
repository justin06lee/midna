import { describe, expect, test } from "bun:test";
import { clock, minutes, parseWindow } from "../src/focusTime";

describe("Screen Time's words and times", () => {
  test("minutes read the way Justin says them", () => {
    expect(minutes(0)).toBe("0 min");
    expect(minutes(45)).toBe("45 min");
    expect(minutes(60)).toBe("1 h");
    expect(minutes(90)).toBe("1 h 30");
    expect(minutes(125)).toBe("2 h 05");
  });

  test("a window is two clock times", () => {
    expect(parseWindow("21:00-23:30")).toEqual({ start: 1260, end: 1410 });
    expect(parseWindow(" 9:00 – 11:15 ")).toEqual({ start: 540, end: 675 });
    // Past midnight: it ends before it starts.
    expect(parseWindow("23:00-1:00")).toEqual({ start: 1380, end: 60 });
    expect(parseWindow("22:00-24:00")).toEqual({ start: 1320, end: 1439 });
    for (const bad of ["", "21-23", "25:00-26:00", "21:60-22:00", "21:00-21:00", "nine to five"]) expect(parseWindow(bad)).toBeNull();
    expect(clock(1410)).toBe("23:30");
    expect(clock(60)).toBe("01:00");
  });
});
