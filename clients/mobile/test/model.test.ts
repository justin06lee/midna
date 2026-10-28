import { expect, test } from "bun:test";
import { APPROVAL_OPTIONS, type Approval } from "@midna/protocol";
import { approvalOutcome, asksApproval, mergeLines, type Line } from "../src/lines.ts";
import { sameHost, serverUrl } from "../src/server.ts";

test("an address typed on a phone becomes midna's URL on the tailnet", () => {
  expect(serverUrl("midna")).toBe("http://midna:7717");
  expect(serverUrl(" midna:7717/ ")).toBe("http://midna:7717");
  expect(serverUrl("100.101.1.2")).toBe("http://100.101.1.2:7717");
  expect(serverUrl("midna.tail1234.ts.net")).toBe("http://midna.tail1234.ts.net:7717");
  expect(serverUrl("http://midna:7717")).toBe("http://midna:7717");
  // A whole URL is taken as it is.
  expect(serverUrl("https://midna.example.com")).toBe("https://midna.example.com");
  expect(serverUrl("")).toBeNull();
  expect(serverUrl("ftp://midna")).toBeNull();
  expect(serverUrl("http://")).toBeNull();
});

test("an old token is only ever named to the host it came from", () => {
  expect(sameHost("http://midna:7717", "http://midna:7717/")).toBe(true);
  expect(sameHost("http://midna:7717", "http://midna:7718")).toBe(false);
  expect(sameHost("http://midna:7717", "http://100.101.1.2:7717")).toBe(false);
  expect(sameHost("nonsense", "http://midna:7717")).toBe(false);
});

const line = (l: Partial<Line> & Pick<Line, "key">): Line => ({ role: "user", text: "", client: "mobile", at: 1, attachments: [], ...l });

test("the echo of a line this phone sent replaces its placeholder; a line seen again is updated in place", () => {
  const cur = [line({ key: "o:1", role: "midna", text: "hi", answered: false }), line({ key: "p:1", text: "yes", pending: true })];
  const next = mergeLines(cur, [line({ key: "m:7", text: "yes" }), line({ key: "o:1", role: "midna", text: "hi", answered: true })]);
  expect(next.map((l) => l.key)).toEqual(["o:1", "m:7"]);
  expect(next[0]!.answered).toBe(true);
  expect(next[1]!.pending).toBeUndefined();
  // Older lines go before.
  expect(mergeLines(next, [line({ key: "m:2", text: "older" })], "prepend").map((l) => l.key)).toEqual(["m:2", "o:1", "m:7"]);
});

test("a question with an approval's options is an approval, whose buttons never send its label", () => {
  const labels = APPROVAL_OPTIONS.map((o) => o.label);
  expect(asksApproval(line({ key: "o:3", role: "midna", kind: "question", options: labels }))).toBe(true);
  expect(asksApproval(line({ key: "o:4", role: "midna", kind: "question", options: ["Allow", "Deny"] }))).toBe(false);
  expect(asksApproval(line({ key: "o:5", role: "midna", kind: "message", options: labels }))).toBe(false);
});

test("how an approval ended, in words", () => {
  const a = { state: "allowed", answer: "allow_10_min", answeredBy: "iPhone", answeredVia: "mobile", expiresAt: 0 } as Approval;
  expect(approvalOutcome(a)).toBe("Allowed for 10 min by iPhone (mobile)");
  expect(approvalOutcome({ ...a, state: "denied", answer: "deny" })).toBe("Denied by iPhone (mobile)");
  expect(approvalOutcome({ ...a, state: "expired", answeredBy: null })).toBe("No answer in time, so no");
});

test("an echo settles a line sent here as sent, even one that had failed; the same words said long before don't", () => {
  const now = Date.now();
  const sending: Line = { key: "p:1", role: "user", text: "ok", client: "mobile", at: now, pending: true, state: "failed", attachments: [] };
  const old: Line = { key: "m:5", role: "user", text: "ok", client: "mobile", at: now - 2 * 3600_000, messageId: 5, attachments: [] };
  const kept = mergeLines([sending], [old], "prepend");
  expect(kept.map((l) => l.key)).toEqual(["m:5", "p:1"]);
  expect(kept[1]!.state).toBe("failed");
  const echoed = mergeLines(kept, [{ key: "m:9", role: "user", text: "ok", client: "mobile", at: now + 400, messageId: 9, attachments: [] }]);
  expect(echoed.map((l) => [l.key, l.state])).toEqual([
    ["m:5", undefined],
    ["m:9", "sent"],
  ]);
});
