/**
 * The user's money as the apps show it: what King of Greed (`kog`, the
 * halal ledger on midna's host) holds, read through GET /v1/ledger. Reading
 * only: an entry is made by telling midna ("5,600원 starbucks"), and the
 * ledger's own tools record it. After 0.13.10.
 */

/** Sums by currency: { KRW: 412300, USD: 12.5 }. */
export type LedgerSums = Record<string, number>;

export interface LedgerAccount {
  name: string;
  /** asset: money you hold. owed: a debt someone owes you. debt: one you owe. */
  kind: "asset" | "owed" | "debt";
  currency: string;
  balance: number;
  person?: string;
}

/** A monthly budget, and where this month stands against it. */
export interface LedgerBudget {
  name: string;
  limit: number;
  spent: number;
  left: number;
  currency: string;
}

export type LedgerKind = "spend" | "earn" | "move" | "lend" | "repay" | "opening";

/** One entry. `amount` is always positive; `kind` says which way it went. */
export interface LedgerEntry {
  id: string;
  /** With the ledger's offset: 2026-11-25T14:02:00+09:00. */
  date: string;
  kind: LedgerKind;
  amount: number;
  currency: string;
  description: string;
  /** Your account: where it came from, or for income where it went. */
  account: string;
  /** The other side: the shop, the payer, the account moved to. */
  other: string;
  category?: string;
  /** Who it was paid for, when not yourself. */
  for?: string;
  /** Interest, which is flagged and never counted as a gain. */
  riba?: "received" | "paid";
  /** Who recorded it: "midna", "cli", "app". */
  via?: string;
}

/** Zakat, as the ledger works it out. It calculates and does not rule. */
export interface LedgerZakat {
  /** Zakatable wealth today. */
  wealth: number;
  currency: string;
  /** The nisab in that currency; absent when the ledger has no gold or silver price. */
  nisab?: number;
  aboveNisab?: boolean;
  /** The day the lunar year ends, once wealth has reached the nisab. */
  dueOn?: string;
  daysLeft?: number;
  /** What is due, once the year has passed. */
  due?: number;
}

export interface Ledger {
  /** Who midna is in the ledger's record of changes. */
  name: string;
  worth: { total: number; currency: string; missingRates: string[] };
  accounts: LedgerAccount[];
  /** Who owes the user what. */
  owed: Array<{ person: string; amount: number; currency: string }>;
  /** This month so far. `spent` is the user's own spending: not what was paid for others, nor lent. */
  month: { month: string; count: number; spent: LedgerSums; earned: LedgerSums; categories: Array<{ name: string; currency: string; amount: number }> };
  budgets: LedgerBudget[];
  /** Interest: received, paid, given away, and what is left to give away. */
  riba: { received: LedgerSums; paid: LedgerSums; purified: LedgerSums; toPurify: LedgerSums };
  zakat: LedgerZakat | null;
  /** The latest entries, newest first. */
  recent: LedgerEntry[];
  /** When the host read this from the ledger (epoch ms). */
  at: number;
}

/** A ledger call runs the ledger's CLI several times on the host, each asking its server. */
export const LEDGER_TIMEOUT_MS = 45_000;

const SYMBOLS: Record<string, string> = { KRW: "₩", USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "CN¥", INR: "₹", TRY: "₺", VND: "₫" };
/** Currencies written without a fraction. */
const WHOLE = new Set(["KRW", "JPY", "VND", "IDR", "CLP", "ISK", "HUF"]);

/** An amount as a person writes it: ₩5,600, $12.50, 12.50 CHF; a minus before the symbol. Written by hand so every device prints the same. */
export function money(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const digits = WHOLE.has(code) ? 0 : 2;
  const fixed = Math.abs(amount).toFixed(digits);
  const [whole, fraction] = fixed.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
  // Rounds to nothing: no minus on a zero.
  const minus = amount < 0 && Number(fixed) !== 0 ? "−" : "";
  const symbol = SYMBOLS[code];
  return symbol ? `${minus}${symbol}${grouped}` : `${minus}${grouped} ${code}`;
}

/** Sums in several currencies on one line, the largest first: "₩412,300 · $12.50". Nothing in any: `none`. */
export function moneySums(sums: LedgerSums, none = "nothing"): string {
  const parts = Object.entries(sums).filter(([, amount]) => amount !== 0);
  if (!parts.length) return none;
  return parts
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([currency, amount]) => money(amount, currency))
    .join(" · ");
}

/** An entry's amount with the way it went: money out is plain, money in has a plus, a move between your own accounts neither. */
export function entryAmount(entry: LedgerEntry): { text: string; tone: "out" | "in" | "moved" } {
  const text = money(entry.amount, entry.currency);
  if (entry.kind === "earn" || entry.kind === "repay" || entry.kind === "opening") return { text: `+${text}`, tone: "in" };
  if (entry.kind === "move") return { text, tone: "moved" };
  return { text, tone: "out" };
}

/** What an entry says under its name: its category, who it was for, that it is interest, and the account. */
export function entryNote(entry: LedgerEntry): string {
  const where = entry.kind === "move" ? `${entry.account} → ${entry.other}` : entry.account;
  return [entry.riba ? `interest ${entry.riba}` : entry.category, entry.for ? `for ${entry.for}` : null, entry.kind === "lend" ? "lent" : null, where].filter(Boolean).join(" · ");
}

/** The calendar day an entry is filed under, in the ledger's own offset: "2026-11-25". */
export const entryDay = (entry: LedgerEntry): string => entry.date.slice(0, 10);

/** Entries grouped by day, in the order given (newest first), each day with what was spent on it. */
export function ledgerDays(entries: LedgerEntry[]): Array<{ day: string; entries: LedgerEntry[]; spent: LedgerSums }> {
  const days: Array<{ day: string; entries: LedgerEntry[]; spent: LedgerSums }> = [];
  for (const entry of entries) {
    const day = entryDay(entry);
    let group = days[days.length - 1];
    if (!group || group.day !== day) days.push((group = { day, entries: [], spent: {} }));
    group.entries.push(entry);
    if (entry.kind === "spend" && !entry.for) group.spent[entry.currency] = (group.spent[entry.currency] ?? 0) + entry.amount;
  }
  return days;
}

/** A day as a heading, from where `today` (YYYY-MM-DD, the reader's own) stands: "Today", "Yesterday", "Tue, Nov 24". */
export function dayLabel(day: string, today: string): string {
  const at = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  const days = Math.round((at(today) - at(day)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(at(day));
  const text = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()]}, ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()]} ${date.getUTCDate()}`;
  return day.slice(0, 4) === today.slice(0, 4) ? text : `${text}, ${day.slice(0, 4)}`;
}

/** A local day as YYYY-MM-DD. */
export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "2026-11" as "November". */
export function monthName(month: string): string {
  return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(month.slice(5, 7)) - 1] ?? month;
}

/** How much of a budget is used, 0 to 1, and whether it has run over. */
export function budgetUse(budget: LedgerBudget): { used: number; over: boolean } {
  const used = budget.limit > 0 ? budget.spent / budget.limit : budget.spent > 0 ? 1 : 0;
  return { used: Math.max(0, Math.min(1, used)), over: budget.left < 0 };
}

/** What a budget says beside its name: "₩38,000 left of ₩150,000", or by how much it is over. */
export function budgetLine(budget: LedgerBudget): string {
  return budget.left < 0 ? `${money(-budget.left, budget.currency)} over ${money(budget.limit, budget.currency)}` : `${money(budget.left, budget.currency)} left of ${money(budget.limit, budget.currency)}`;
}

/** Zakat in one line, for a row's value. */
export function zakatLine(zakat: LedgerZakat): string {
  if (zakat.due !== undefined && zakat.due > 0) return `${money(zakat.due, zakat.currency)} due`;
  if (zakat.nisab === undefined) return "No gold or silver price yet";
  if (zakat.aboveNisab === false) return "Below the nisab";
  if (zakat.daysLeft !== undefined) return zakat.daysLeft <= 0 ? "The year has ended" : `Year ends in ${zakat.daysLeft} day${zakat.daysLeft === 1 ? "" : "s"}`;
  return "Above the nisab";
}

/** True when the ledger holds nothing to show yet: no account and no entry. */
export const ledgerEmpty = (ledger: Ledger): boolean => ledger.accounts.length === 0 && ledger.recent.length === 0;
