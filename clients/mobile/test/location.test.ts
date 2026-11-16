import { describe, expect, test } from "bun:test";
import type { LocationFix, Place } from "@midna/protocol";
import { QUEUE_MAX, SEND_EVERY_MS, ago, crossing, dequeue, enqueue, fromTask, keepWatched, placeOf, regionId, regionsKey, sendNow } from "../src/locationQueue";

const fix = (at: number, source: LocationFix["source"] = "significant"): LocationFix => ({ at, lat: 1, lon: 2, source });
const place = (id: number, lat = 37.33, radius = 150): Place => ({ id, name: `p${id}`, lat, lon: -122, radius, created_at: 0, updated_at: 0 });

describe("the phone's location", () => {
  test("iOS's fixes become midna's, leaving out what the phone didn't know", () => {
    expect(fromTask([{ coords: { latitude: 37.3, longitude: -122, accuracy: 65, altitude: null, speed: -1 }, timestamp: 1_700_000_000_123.4 }])).toEqual([
      { at: 1_700_000_000_123, lat: 37.3, lon: -122, accuracy: 65, altitude: null, speed: null, source: "significant" },
    ]);
    expect(fromTask([{ coords: { latitude: Number.NaN, longitude: 1 }, timestamp: 1 }])).toEqual([]);
  });

  test("each fix keeps where it came from: precise, significant, or midna asking", () => {
    const at = (source?: "precise" | "significant" | "requested") => fromTask([{ coords: { latitude: 1, longitude: 2 }, timestamp: 5, ...(source ? { source } : {}) }])[0]!.source;
    expect([at("precise"), at("significant"), at("requested"), at()]).toEqual(["precise", "significant", "requested", "significant"]);
  });

  test("precise fixes go together, at most once a minute; anything else goes at once", () => {
    const now = 10_000_000;
    expect(sendNow([fix(1, "precise")], now - 5_000, now)).toBe(false);
    expect(sendNow([fix(1, "precise")], now - SEND_EVERY_MS, now)).toBe(true);
    expect(sendNow([fix(1, "precise")], null, now)).toBe(true);
    expect(sendNow([fix(1, "precise"), fix(2, "requested")], now - 5_000, now)).toBe(true);
    expect(sendNow([fix(1, "arrive")], now - 5_000, now)).toBe(true);
  });

  test("the queue keeps each fix once, oldest first, and only what midna hasn't taken", () => {
    let q = enqueue([], [fix(3), fix(1)]);
    q = enqueue(q, [fix(1), fix(2), fix(1, "arrive")]);
    expect(q.map((f) => `${f.at}${f.source[0]}`)).toEqual(["1s", "1a", "2s", "3s"]);
    // A fix that came in while a report was on its way stays.
    expect(dequeue(enqueue(q, [fix(4)]), q.slice(0, 2)).map((f) => f.at)).toEqual([2, 3, 4]);
  });

  test("a phone off the network for weeks keeps the latest fixes", () => {
    const q = enqueue([], Array.from({ length: QUEUE_MAX + 10 }, (_, i) => fix(i + 1)));
    expect(q.length).toBe(QUEUE_MAX);
    expect(q[0]!.at).toBe(11);
  });

  test("only a change of state is an arrival or a departure: not the first state heard, nor a repeat", () => {
    const id = regionId(place(7));
    let r = crossing({}, id, "outside");
    expect(r.news).toBeNull();
    r = crossing(r.inside, id, "outside");
    expect(r.news).toBeNull();
    r = crossing(r.inside, id, "inside");
    expect(r.news).toBe("arrive");
    r = crossing(r.inside, id, "inside");
    expect(r.news).toBeNull();
    r = crossing(r.inside, id, "outside");
    expect(r.news).toBe("leave");
    expect(keepWatched({ ...r.inside, "place:99": "inside" }, [place(7)])).toEqual({ [id]: "outside" });
  });

  test("geofence ids and when they need registering again", () => {
    expect(placeOf("place:12")).toBe(12);
    expect(placeOf("other")).toBeNull();
    expect(regionsKey([place(1), place(2)])).toBe(regionsKey([place(2), place(1)]));
    expect(regionsKey([place(1)])).not.toBe(regionsKey([place(1, 37.331)]));
    expect(regionsKey([place(1)])).not.toBe(regionsKey([place(1, 37.33, 300)]));
  });

  test("how long ago, as Settings says it", () => {
    expect(ago(20_000)).toBe("just now");
    expect(ago(4 * 60_000)).toBe("4 min ago");
    expect(ago(3 * 3_600_000)).toBe("3 h ago");
    expect(ago(5 * 86_400_000)).toBe("5 days ago");
  });
});
