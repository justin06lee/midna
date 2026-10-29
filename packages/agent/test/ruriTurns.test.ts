import { describe, expect, test } from "bun:test";
import { ruriTurn } from "../src/ruriTurns.ts";

type Chat = { id: string; name: string; role: string; lastSummary: string; lastPrompt?: { id: string; at: string } | null };
const chat = (name: string, lastPrompt?: { id: string; at: string } | null, role = "lead"): Chat => ({
  id: `c-${name}`,
  name,
  role,
  lastSummary: "done",
  ...(lastPrompt !== undefined ? { lastPrompt } : {}),
});
const event = (chats: Chat[], kind = "project.idle") => ({
  id: "e1",
  source: "ruri",
  kind,
  project: { id: "p-jamo", name: "jamo", path: "/work/jamo" },
  chats,
  costUsd: 1,
  at: "2026-10-29T06:00:00.000Z",
});
const midna = (at: string) => ({ id: "midna-0b6f7c1e-1111-4a1a-9c1d-2f3e4d5c6b7a", at });
const justin = (at: string) => ({ id: "4c2d9e8f-2222-4b2b-8d2e-3a4b5c6d7e8f", at });

describe("whose turn a ruri event is about", () => {
  test("a turn midna started: midna hears it, idle or blocked", () => {
    expect(ruriTurn(event([chat("Lead", midna("2026-10-29T05:50:00Z"))]))).toEqual({ by: "midna" });
    expect(ruriTurn(event([chat("Lead", midna("2026-10-29T05:50:00Z"))], "project.blocked"))).toEqual({ by: "midna" });
  });

  test("a turn the user typed: not midna's", () => {
    expect(ruriTurn(event([chat("Lead", justin("2026-10-29T05:50:00Z"))]))).toEqual({
      by: "other",
      why: "the latest prompt in jamo (Lead) wasn't midna's",
    });
    expect(ruriTurn(event([chat("Lead", justin("2026-10-29T05:50:00Z"))], "project.blocked"))?.by).toBe("other");
  });

  test("midna's turn, then the user typing in the same chat: the latest decides", () => {
    // ruri names a chat's latest prompt, so the user's later one is what it carries.
    expect(ruriTurn(event([chat("Lead", justin("2026-10-29T05:55:00Z"))]))?.by).toBe("other");
    // And the other way round: midna's prompt after the user's.
    expect(ruriTurn(event([chat("Lead", midna("2026-10-29T05:55:00Z"))]))?.by).toBe("midna");
  });

  test("across a team, the latest prompt in any of its chats decides", () => {
    // midna's job in the lead, blocked on a teammate's card: the teammate only had the lead's letters.
    const blocked = event([chat("Tests", null, "teammate"), chat("Lead", midna("2026-10-29T05:40:00Z"))], "project.blocked");
    expect(ruriTurn(blocked)).toEqual({ by: "midna" });
    // An old midna prompt in the lead, the user at work in a teammate since: theirs.
    const since = event([chat("Lead", midna("2026-10-28T09:00:00Z")), chat("Tests", justin("2026-10-29T05:40:00Z"), "teammate")]);
    expect(ruriTurn(since)?.by).toBe("other");
    // The user earlier, midna since: midna's.
    const after = event([chat("Lead", midna("2026-10-29T05:45:00Z")), chat("Tests", justin("2026-10-29T05:40:00Z"), "teammate")]);
    expect(ruriTurn(after)?.by).toBe("midna");
  });

  test("no prompt on file from outside the team: not midna's", () => {
    expect(ruriTurn(event([chat("Lead", null), chat("Liaison", null, "liaison")]))).toEqual({
      by: "other",
      why: "no prompt in jamo came from midna",
    });
  });

  test("a prompt it can't read counts as none", () => {
    const odd = event([chat("Lead", { id: "midna-x", at: "yesterday-ish" }), chat("Tests", justin("2026-10-29T05:40:00Z"), "teammate")]);
    expect(ruriTurn(odd)?.by).toBe("other");
  });

  test("no telling: a ruri before lastPrompt, or not a project event", () => {
    expect(ruriTurn(event([chat("Lead")]))).toBeNull();
    expect(ruriTurn(event([chat("Lead", justin("2026-10-29T05:50:00Z"))], "project.test"))).toBeNull();
    // ruri-watch's weekly usage events carry no kind or project.
    expect(ruriTurn({ weekly: 71, threshold: 70 })).toBeNull();
    expect(ruriTurn(undefined)).toBeNull();
    expect(ruriTurn("idle")).toBeNull();
  });
});
