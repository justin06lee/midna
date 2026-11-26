/**
 * A ledger for the stand-in kog (fake-kog.ts) to answer from: the JSON each
 * of King of Greed's read commands prints, in its own shapes, for a month
 * that ends on `today`. The tests read it at a fixed day; the preview
 * (scripts/preview.ts) at the real one, so its entries say Today and
 * Yesterday.
 */
export function fakeLedger(today: Date = new Date(2026, 10, 26, 15, 0)) {
  const pad = (n: number) => String(n).padStart(2, "0");
  /** A moment `back` days before today, at hh:mm, with Seoul's offset as the ledger writes it. */
  const at = (back: number, hm: string) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hm}:00+09:00`;
  };
  const month = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
  const tx = (id: number, back: number, hm: string, kind: string, amount: number, description: string, more: Record<string, unknown> = {}) => ({
    id: String(id), date: at(back, hm), kind, amount, currency: "KRW", description, account: "Toss", other: description, tags: [], via: "midna", ...more,
  });
  const accounts = [
    { id: "1", name: "Toss", kind: "asset", currency: "KRW", balance: 1_842_300, inPrimary: 1_842_300 },
    { id: "2", name: "Kakao savings", kind: "asset", currency: "KRW", balance: 5_200_000, inPrimary: 5_200_000 },
    { id: "3", name: "Wise", kind: "asset", currency: "USD", balance: 412.5, inPrimary: 569_250 },
    { id: "4", name: "Minjun", kind: "owed", currency: "KRW", balance: 35_000, person: "Minjun", inPrimary: 35_000 },
  ];
  return {
    status: {
      server: { address: "http://127.0.0.1:8322", version: "6.2.0" },
      name: "midna",
      accounts,
      worth: { total: 7_646_550, currency: "KRW", missingRates: [] },
      owed: [{ person: "Minjun", account: "Minjun", amount: 35_000, currency: "KRW" }],
      month: {
        month,
        count: 41,
        spent: { KRW: 612_400, USD: 20 },
        earned: { KRW: 2_400_000 },
        categories: [
          { name: "Food", currency: "KRW", amount: 248_600 },
          { name: "Other", currency: "KRW", amount: 114_000 },
          { name: "Transport", currency: "KRW", amount: 84_200 },
          { name: "Coffee", currency: "KRW", amount: 61_600 },
          { name: "Subscriptions", currency: "KRW", amount: 58_000 },
          { name: "Books", currency: "KRW", amount: 46_000 },
          { name: "Subscriptions", currency: "USD", amount: 20 },
        ],
        forOthers: [{ person: "Minjun", covered: {}, lent: { KRW: 35_000 } }],
        riba: { received: { KRW: 1_240 }, paid: {} },
      },
    },
    budget: [
      { name: "Food", limit: 300_000, spent: 248_600, left: 51_400, currency: "KRW" },
      { name: "Transport", limit: 100_000, spent: 84_200, left: 15_800, currency: "KRW" },
      { name: "Coffee", limit: 60_000, spent: 61_600, left: -1_600, currency: "KRW" },
      { name: "Books", limit: 80_000, spent: 46_000, left: 34_000, currency: "KRW" },
    ],
    riba: { received: { KRW: 1_240 }, paid: {}, purified: {}, toPurify: { KRW: 1_240 } },
    zakat: {
      wealth: 7_646_550,
      currency: "KRW",
      nisab: { value: 1_194_102, standard: "silver", grams: 612.36, perGram: 1_950, date: at(0, "09:00").slice(0, 10), source: "goldapi" },
      aboveNisab: true,
      hawl: { start: "2026-06-17", dueOn: "2027-06-06", startHijri: "1 Muharram 1448", dueHijri: "1 Muharram 1449", daysLeft: 192 },
      today: { date: at(0, "09:00").slice(0, 10), hijri: "16 Jumada II 1448" },
      settings: { standard: "silver", rule: "hanafi" },
      notes: [],
    },
    list: [
      tx(41, 0, "13:12", "spend", 5_600, "Starbucks", { category: "Coffee" }),
      tx(40, 0, "12:20", "spend", 9_500, "Lunch, kimchi jjigae", { category: "Food" }),
      tx(39, 0, "08:02", "spend", 1_500, "T-money", { category: "Transport" }),
      tx(38, 1, "19:40", "lend", 35_000, "Dinner, Minjun's half", { for: "Minjun", other: "Minjun" }),
      tx(37, 1, "19:38", "spend", 35_000, "Dinner in Seongsu", { category: "Food" }),
      tx(36, 1, "10:05", "spend", 20, "Claude", { currency: "USD", account: "Wise", category: "Subscriptions", via: "cli" }),
      tx(35, 2, "16:30", "spend", 18_000, "Kyobo, Justice", { category: "Books" }),
      tx(34, 2, "09:00", "earn", 1_240, "Savings interest", { account: "Kakao savings", riba: "received", via: "import" }),
      tx(33, 3, "21:10", "move", 500_000, "To savings", { other: "Kakao savings" }),
      tx(32, 3, "12:45", "spend", 12_000, "GS25", { category: "Food" }),
      tx(31, 5, "09:00", "earn", 2_400_000, "caveira, November", { other: "caveira", category: "Salary", via: "import" }),
      tx(30, 6, "18:15", "spend", 46_800, "Emart", { category: "Food" }),
    ],
  };
}

/** What kog prints where nothing has been set up yet: no account, no entry. */
export function emptyLedger(month = "2026-11") {
  return {
    status: { server: { address: "http://127.0.0.1:8322", version: "6.2.0" }, name: "midna", accounts: [], worth: { total: 0, currency: "KRW", missingRates: [] }, owed: [], month: { month, count: 0, spent: {}, earned: {}, categories: [], forOthers: [], riba: { received: {}, paid: {} } } },
    budget: [],
    riba: { received: {}, paid: {}, purified: {}, toPurify: {} },
    zakat: { wealth: 0, currency: "KRW", hawl: {}, today: { date: `${month}-26`, hijri: "" }, settings: { standard: "silver", rule: "hanafi" }, notes: ["no gold or silver price to measure the nisab against."] },
    list: [],
  };
}
