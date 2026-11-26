import { useCallback, useEffect, useRef, useState } from "react";
import { MidnaError, budgetLine, budgetUse, dayLabel, entryAmount, entryNote, ledgerDays, ledgerEmpty, localDay, money, moneySums, monthName, zakatLine, type Ledger, type LedgerBudget, type LedgerEntry, type MidnaClient } from "@midna/protocol";
import { Button, Empty, Group, Icon, Loading, Section } from "../ui";

/** How many categories and entries are shown before the rest is left to a question. */
const CATEGORIES = 8;
const ENTRIES = 60;

/**
 * Money: what the user holds, how the month stands against its budgets, and
 * the latest entries, from the ledger midna keeps with them (King of Greed,
 * on midna's host). Read only: an entry is made by telling midna in the
 * chat. Asked for again whenever midna has just done something (`changed`).
 */
export function Money({ client, changed }: { client: MidnaClient; changed: number }) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [none, setNone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tries, setTries] = useState(0);
  // The first read may be the host's remembered one; after midna did something, or on Refresh, a new one.
  const first = useRef(true);

  useEffect(() => {
    let live = true;
    const fresh = !first.current;
    first.current = false;
    setBusy(true);
    client
      .ledger(fresh)
      .then(
        (l) => live && (setLedger(l), setError(null), setNone(false)),
        (err: Error) => {
          if (!live) return;
          // 503: no ledger on this host. 404: a host from before it could be read.
          if (err instanceof MidnaError && (err.status === 503 || err.status === 404)) setNone(true);
          else setError(`Couldn't read the ledger: ${err.message}`);
        },
      )
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [client, changed, tries]);
  const reload = useCallback(() => setTries((n) => n + 1), []);

  if (none)
    return (
      <div className="mx-auto w-full max-w-[880px] px-8 pt-2 pb-10">
        <div className="sheet rounded-[14px] px-5 py-8 text-center">
          <p className="text-[14px] font-medium">No ledger on this midna</p>
          <p className="mx-auto mt-1 max-w-[400px] text-[12.5px] text-dim">King of Greed keeps the ledger on midna's host. Once it is set up there, your money shows here.</p>
        </div>
      </div>
    );
  if (!ledger) return <Loading error={error} onRetry={reload} />;

  const month = monthName(ledger.month.month);
  const assets = ledger.accounts.filter((a) => a.kind === "asset");
  const debts = ledger.accounts.filter((a) => a.kind === "debt" && a.balance !== 0);
  const days = ledgerDays(ledger.recent.slice(0, ENTRIES));
  const today = localDay(Date.now());
  const toPurify = moneySums(ledger.riba.toPurify, "");
  const hadInterest = Object.values(ledger.riba.received).some((n) => n > 0);
  const zero = money(0, ledger.worth.currency);

  return (
    <div data-testid="money" className="mx-auto w-full max-w-[880px] px-8 pt-2 pb-10">
      <header className="mb-7 flex items-end justify-between gap-4">
        <div>
          <p className="text-[12px] font-medium text-dim">Net worth</p>
          <h1 className="selectable tabular mt-0.5 text-[30px] leading-[1.15] font-bold tracking-[-0.02em]">{money(ledger.worth.total, ledger.worth.currency)}</h1>
          <p className="mt-1.5 text-[13px] text-dim">
            Spent in {month} <span className="tabular font-medium text-ink">{moneySums(ledger.month.spent, zero)}</span>
            <span className="mx-2 text-dimmer">·</span>
            Earned <span className="tabular font-medium text-ink">{moneySums(ledger.month.earned, zero)}</span>
          </p>
          {ledger.worth.missingRates.length > 0 && <p className="mt-1 text-[11.5px] text-dimmer">Without {ledger.worth.missingRates.join(", ")}: no exchange rate.</p>}
        </div>
        <Button size="sm" onClick={reload} disabled={busy} icon={<Icon name="refresh" className="size-3.5" />}>
          Refresh
        </Button>
      </header>
      {error && <p className="selectable mb-4 px-1.5 text-[12.5px] text-[var(--bad)]">{error}</p>}

      {ledgerEmpty(ledger) ? (
        <div className="sheet rounded-[14px] px-5 py-8 text-center">
          <p className="text-[14px] font-medium">Nothing in the ledger yet</p>
          <p className="mx-auto mt-1 max-w-[400px] text-[12.5px] text-dim">Tell midna which accounts you keep and what you spend ("5,600원 starbucks"), and it shows here.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-7 lg:grid-cols-2">
          <div className="space-y-7">
            {ledger.budgets.length > 0 && (
              <Section title={`Budgets · ${month}`}>
                <Group>
                  {ledger.budgets.map((b) => (
                    <Budget key={b.name} budget={b} />
                  ))}
                </Group>
              </Section>
            )}
            {assets.length > 0 && (
              <Section title="Accounts">
                <Group>
                  {assets.map((a) => (
                    <Line key={a.name} label={a.name} value={money(a.balance, a.currency)} />
                  ))}
                </Group>
              </Section>
            )}
            {ledger.owed.length + debts.length > 0 && (
              <Section title="Between you and others">
                <Group>
                  {ledger.owed.map((o) => (
                    <Line key={`o${o.person}${o.currency}`} label={o.person} note="owes you" value={money(o.amount, o.currency)} />
                  ))}
                  {debts.map((d) => (
                    <Line key={`d${d.name}`} label={d.person ?? d.name} note="you owe" value={money(Math.abs(d.balance), d.currency)} />
                  ))}
                </Group>
              </Section>
            )}
            {ledger.month.categories.length > 0 && (
              <Section title={`Where it went · ${month}`}>
                <Group>
                  {ledger.month.categories.slice(0, CATEGORIES).map((c) => (
                    <Line key={`${c.name}${c.currency}`} label={c.name} value={money(c.amount, c.currency)} />
                  ))}
                </Group>
              </Section>
            )}
            {(ledger.zakat || hadInterest) && (
              <Section title="Halal" footer="The ledger works these out; the ruling is yours.">
                <Group>
                  {hadInterest && <Line label="Interest to give away" value={toPurify || "All given away"} warn={!!toPurify} />}
                  {ledger.zakat && (
                    <Line label="Zakat" note={ledger.zakat.nisab !== undefined ? `Nisab ${money(ledger.zakat.nisab, ledger.zakat.currency)}` : undefined} value={zakatLine(ledger.zakat)} warn={!!ledger.zakat.due} />
                  )}
                </Group>
              </Section>
            )}
          </div>

          <div className="space-y-7">
            {days.length === 0 && (
              <Section title="Latest">
                <Group>
                  <Empty>No entries yet. Tell midna what you spend and it lands here.</Empty>
                </Group>
              </Section>
            )}
            {days.map((d) => (
              <Section key={d.day} title={dayLabel(d.day, today)} aside={Object.keys(d.spent).length > 0 ? <span className="tabular text-[12px] text-dimmer">{moneySums(d.spent)}</span> : undefined}>
                <Group>
                  {d.entries.map((e) => (
                    <Entry key={e.id} entry={e} />
                  ))}
                </Group>
              </Section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A row: what it is on the left, with a word under it if it needs one, and its figure on the right. */
function Line({ label, note, value, warn }: { label: string; note?: string; value: string; warn?: boolean }) {
  return (
    <div className="flex min-h-[40px] items-center gap-3 px-3.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]">{label}</div>
        {note && <div className="mt-0.5 text-[11.5px] text-dim">{note}</div>}
      </div>
      <span className={`selectable tabular shrink-0 text-[13px] ${warn ? "text-accent" : "text-dim"}`}>{value}</span>
    </div>
  );
}

/** A budget: its name, what is left, and a bar of how much is used. The bar is ink, and the accent once it has run over. */
function Budget({ budget }: { budget: LedgerBudget }) {
  const { used, over } = budgetUse(budget);
  return (
    <div className="px-3.5 pt-2.5 pb-3" aria-label={`${budget.name}, ${budgetLine(budget)}`}>
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-[13px]">{budget.name}</span>
        <span className={`tabular shrink-0 text-[12px] ${over ? "text-accent" : "text-dim"}`}>{budgetLine(budget)}</span>
      </div>
      <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-control">
        <div className={`h-full rounded-full ${over ? "bg-accent" : "bg-dim"}`} style={{ width: `${Math.round(used * 100)}%` }} />
      </div>
    </div>
  );
}

/** One entry: what it was, with its category and account under it, and the amount at the right. */
function Entry({ entry }: { entry: LedgerEntry }) {
  const amount = entryAmount(entry);
  const note = entryNote(entry);
  return (
    <div className="flex min-h-[40px] items-center gap-3 px-3.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="selectable truncate text-[13px]">{entry.description || entry.other}</div>
        {note && <div className="mt-0.5 truncate text-[11.5px] text-dim">{note}</div>}
      </div>
      <span className={`selectable tabular shrink-0 text-[13px] ${amount.tone === "in" ? "text-[var(--ok)]" : amount.tone === "moved" ? "text-dim" : "text-ink"}`}>{amount.text}</span>
    </div>
  );
}
