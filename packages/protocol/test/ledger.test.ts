import { describe, expect, test } from "bun:test";
import { budgetLine, budgetUse, dayLabel, entryAmount, entryNote, ledgerDays, ledgerEmpty, localDay, money, moneySums, monthName, zakatLine, type Ledger, type LedgerEntry } from "../src/index.ts";

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({ id: "1", date: "2026-11-26T13:12:00+09:00", kind: "spend", amount: 5600, currency: "KRW", description: "Starbucks", account: "Toss", other: "Starbucks", ...over });

describe("money, as the apps write it", () => {
  test("won has no fraction, dollars two places, and an unknown currency says its code", () => {
    expect(money(5600, "KRW")).toBe("₩5,600");
    expect(money(1_842_300, "krw")).toBe("₩1,842,300");
    expect(money(12.5, "USD")).toBe("$12.50");
    expect(money(1234.5, "CHF")).toBe("1,234.50 CHF");
    expect(money(0, "KRW")).toBe("₩0");
  });

  test("a minus goes before the symbol, and never on what rounds to nothing", () => {
    expect(money(-1600, "KRW")).toBe("−₩1,600");
    expect(money(-0.4, "KRW")).toBe("₩0");
    expect(money(-0.004, "USD")).toBe("$0.00");
  });

  test("sums in several currencies go on one line, the largest first", () => {
    expect(moneySums({ USD: 20, KRW: 612_400 })).toBe("₩612,400 · $20.00");
    expect(moneySums({})).toBe("nothing");
    expect(moneySums({ KRW: 0 }, "₩0")).toBe("₩0");
  });
});

describe("an entry", () => {
  test("money in has a plus, a move has none and is told apart", () => {
    expect(entryAmount(entry({}))).toEqual({ text: "₩5,600", tone: "out" });
    expect(entryAmount(entry({ kind: "earn", amount: 2_400_000 }))).toEqual({ text: "+₩2,400,000", tone: "in" });
    expect(entryAmount(entry({ kind: "repay", amount: 35_000 }))).toEqual({ text: "+₩35,000", tone: "in" });
    expect(entryAmount(entry({ kind: "move", amount: 500_000 }))).toEqual({ text: "₩500,000", tone: "moved" });
  });

  test("its note names the category, who it was for, interest, and the account", () => {
    expect(entryNote(entry({ category: "Coffee" }))).toBe("Coffee · Toss");
    expect(entryNote(entry({ kind: "lend", for: "Minjun" }))).toBe("for Minjun · lent · Toss");
    expect(entryNote(entry({ kind: "earn", riba: "received", category: "Income", account: "Kakao savings" }))).toBe("interest received · Kakao savings");
    expect(entryNote(entry({ kind: "move", other: "Kakao savings" }))).toBe("Toss → Kakao savings");
  });

  test("entries group by the ledger's own day, each with the user's own spending", () => {
    const days = ledgerDays([
      entry({ id: "3", date: "2026-11-26T13:12:00+09:00" }),
      entry({ id: "2", date: "2026-11-26T00:30:00+09:00", amount: 20, currency: "USD" }),
      entry({ id: "1", date: "2026-11-25T23:50:00+09:00", kind: "lend", for: "Minjun", amount: 35_000 }),
      entry({ id: "0", date: "2026-11-25T09:00:00+09:00", kind: "earn", amount: 100 }),
    ]);
    expect(days.map((d) => [d.day, d.entries.map((e) => e.id), d.spent])).toEqual([
      ["2026-11-26", ["3", "2"], { KRW: 5600, USD: 20 }],
      ["2026-11-25", ["1", "0"], {}],
    ]);
  });

  test("a day is Today, Yesterday, or its date; the year only when it isn't this one", () => {
    expect(dayLabel("2026-11-26", "2026-11-26")).toBe("Today");
    expect(dayLabel("2026-11-25", "2026-11-26")).toBe("Yesterday");
    expect(dayLabel("2026-11-24", "2026-11-26")).toBe("Tue, Nov 24");
    expect(dayLabel("2025-12-31", "2026-01-02")).toBe("Wed, Dec 31, 2025");
    expect(localDay(new Date(2026, 10, 6, 23, 59).getTime())).toBe("2026-11-06");
    expect(monthName("2026-11")).toBe("November");
  });
});

describe("budgets and zakat", () => {
  test("a budget says what is left, or by how much it is over", () => {
    const food = { name: "Food", limit: 300_000, spent: 248_600, left: 51_400, currency: "KRW" };
    const coffee = { name: "Coffee", limit: 60_000, spent: 61_600, left: -1_600, currency: "KRW" };
    expect(budgetLine(food)).toBe("₩51,400 left of ₩300,000");
    expect(budgetLine(coffee)).toBe("₩1,600 over ₩60,000");
    expect(budgetUse(food).over).toBe(false);
    expect(budgetUse(food).used).toBeCloseTo(0.8287, 3);
    expect(budgetUse(coffee)).toEqual({ used: 1, over: true });
    expect(budgetUse({ ...food, limit: 0, spent: 0, left: 0 })).toEqual({ used: 0, over: false });
  });

  test("zakat in a line: what is due, where the year stands, or why there is no figure", () => {
    const z = { wealth: 7_646_550, currency: "KRW" };
    expect(zakatLine({ ...z, nisab: 1_194_102, aboveNisab: true, daysLeft: 192 })).toBe("Year ends in 192 days");
    expect(zakatLine({ ...z, nisab: 1_194_102, aboveNisab: true, daysLeft: 1 })).toBe("Year ends in 1 day");
    expect(zakatLine({ ...z, nisab: 1_194_102, aboveNisab: true, due: 191_164, daysLeft: 0 })).toBe("₩191,164 due");
    expect(zakatLine({ ...z, nisab: 9_000_000, aboveNisab: false })).toBe("Below the nisab");
    expect(zakatLine(z)).toBe("No gold or silver price yet");
  });

  test("a ledger with no account and no entry is empty", () => {
    const none: Ledger = { name: "midna", worth: { total: 0, currency: "KRW", missingRates: [] }, accounts: [], owed: [], month: { month: "2026-11", count: 0, spent: {}, earned: {}, categories: [] }, budgets: [], riba: { received: {}, paid: {}, purified: {}, toPurify: {} }, zakat: null, recent: [], at: 0 };
    expect(ledgerEmpty(none)).toBe(true);
    expect(ledgerEmpty({ ...none, accounts: [{ name: "Toss", kind: "asset", currency: "KRW", balance: 0 }] })).toBe(false);
  });
});
