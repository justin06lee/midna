import type { Overview } from "@midna/protocol";
import { Empty, Section, Spinner } from "../ui";

const DAY = 86_400_000;
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const when = (ms: number, now: number) => {
  const d = new Date(ms);
  const today = new Date(now).toDateString();
  const tomorrow = new Date(now + DAY).toDateString();
  const label = d.toDateString() === today ? "today" : d.toDateString() === tomorrow ? "tomorrow" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `${label} ${time(ms)}`;
};

/** The day at a glance: what's on, what's due, who's owed what, and what midna will do on its own. */
export function Today({ overview }: { overview: Overview | null }) {
  if (!overview) return <Loading />;
  const now = Date.now();
  const endOfTomorrow = new Date(new Date(now + DAY).toDateString()).getTime() + DAY;
  const events = overview.events.filter((e) => e.starts_at < endOfTomorrow);
  const due = overview.tasks.filter((t) => t.owner === "user" && (t.priority === 1 || (t.due_at !== null && t.due_at < now + 2 * DAY)));
  const mine = overview.commitments.filter((c) => c.direction === "mine");
  const theirs = overview.commitments.filter((c) => c.direction === "theirs");
  const midnaWill = [...overview.tasks.filter((t) => t.owner === "midna").map((t) => ({ key: `t${t.id}`, at: t.due_at, text: t.title })), ...overview.wakeups.map((w) => ({ key: `w${w.id}`, at: w.due_at, text: w.reason }))]
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
    .slice(0, 8);
  const overdue = due.filter((t) => t.due_at !== null && t.due_at < now).length;

  return (
    <div className="mx-auto w-full max-w-[880px] px-8 pt-4 pb-10">
      <header className="mb-6">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</h1>
        <p className="mt-0.5 text-[13px] text-dim">
          {[
            events.length ? `${events.length} on the calendar` : "nothing on the calendar",
            due.length ? `${due.length} to do${overdue ? `, ${overdue} overdue` : ""}` : "nothing due",
            overview.commitments.length ? `${overview.commitments.length} open promise${overview.commitments.length === 1 ? "" : "s"}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-7 lg:grid-cols-2">
        <Section title="Today and tomorrow">
          <List empty="Nothing scheduled.">
            {events.map((e) => (
              <Row key={e.id} lead={e.all_day ? "all day" : when(e.starts_at, now)} text={e.title} sub={[e.location, e.source !== "midna" ? e.source : null].filter(Boolean).join(" · ")} />
            ))}
          </List>
        </Section>

        <Section title="Due">
          <List empty="Nothing due in the next two days.">
            {due.map((t) => (
              <Row key={t.id} lead={t.due_at ? (t.due_at < now ? "overdue" : when(t.due_at, now)) : `P${t.priority}`} strong={t.due_at !== null && t.due_at < now} text={t.title} sub={t.goal_id ? null : "serves no goal yet"} />
            ))}
          </List>
        </Section>

        <Section title="Promises">
          <List empty="No open promises.">
            {mine.map((c) => (
              <Row key={c.id} lead="you owe" text={`${c.counterparty ?? "someone"}: ${c.what}`} sub={c.due_at ? `by ${when(c.due_at, now)}` : null} strong={c.due_at !== null && c.due_at < now} />
            ))}
            {theirs.map((c) => (
              <Row key={c.id} lead="owed to you" text={`${c.counterparty ?? "someone"}: ${c.what}`} sub={c.due_at ? `by ${when(c.due_at, now)}` : null} />
            ))}
          </List>
        </Section>

        <Section title="midna will">
          <List empty="Nothing scheduled.">
            {midnaWill.map((m) => (
              <Row key={m.key} lead={m.at ? when(m.at, now) : "soon"} text={m.text} />
            ))}
          </List>
        </Section>
      </div>
    </div>
  );
}

function List({ children, empty }: { children: React.ReactNode[] | React.ReactNode; empty: string }) {
  const items = (Array.isArray(children) ? children.flat() : [children]).filter(Boolean);
  return <div className="sheet overflow-hidden rounded-xl">{items.length ? items : <Empty>{empty}</Empty>}</div>;
}

function Row({ lead, text, sub, strong }: { lead: string; text: string; sub?: string | null; strong?: boolean }) {
  return (
    <div className="flex gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0">
      <span className={`w-[124px] shrink-0 pt-px text-[12px] tabular ${strong ? "font-semibold text-ink" : "text-dim"}`}>{lead}</span>
      <div className="min-w-0 flex-1">
        <div className="selectable text-[13px] leading-[1.4]">{text}</div>
        {sub && <div className="mt-0.5 text-[11.5px] text-dimmer">{sub}</div>}
      </div>
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-dim">
      <Spinner /> Loading…
    </div>
  );
}
