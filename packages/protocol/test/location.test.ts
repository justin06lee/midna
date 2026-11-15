import { describe, expect, test } from "bun:test";
import { LocationReport, PlacePatch, metresBetween, placeAt } from "../src/index.ts";

describe("location", () => {
  test("distances are right to a few metres over a city", () => {
    // Apple Park to the Googleplex: about 11.7 km.
    expect(Math.round(metresBetween({ lat: 37.3349, lon: -122.009 }, { lat: 37.422, lon: -122.0841 }) / 100)).toBe(117);
    expect(metresBetween({ lat: 10, lon: 10 }, { lat: 10, lon: 10 })).toBe(0);
  });

  test("a point is in the smallest place around it", () => {
    const home = { name: "Home", lat: 37.3318, lon: -122.0312, radius: 150 };
    const area = { name: "Area", lat: 37.3318, lon: -122.0312, radius: 2000 };
    expect(placeAt([area, home], { lat: 37.3319, lon: -122.0312 })?.name).toBe("Home");
    expect(placeAt([area, home], { lat: 37.336, lon: -122.0312 })?.name).toBe("Area");
    expect(placeAt([area, home], { lat: 37.5, lon: -122.0312 })).toBeNull();
  });

  test("a report is checked: real coordinates, a known source, not empty; a patch changes something", () => {
    expect(LocationReport.safeParse({ fixes: [{ at: 1, lat: 1, lon: 1, source: "significant" }] }).success).toBe(true);
    expect(LocationReport.safeParse({ fixes: [{ at: 1, lat: 1, lon: 181, source: "significant" }] }).success).toBe(false);
    expect(LocationReport.safeParse({ fixes: [{ at: 1, lat: 1, lon: 1, source: "gps" }] }).success).toBe(false);
    expect(LocationReport.safeParse({ fixes: [] }).success).toBe(false);
    expect(PlacePatch.safeParse({}).success).toBe(false);
  });
});
