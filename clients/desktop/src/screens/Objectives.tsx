import type { Overview } from "@midna/protocol";
import { Button, Icon, Section } from "../ui";
import { Loading } from "./Today";

type Goal = Overview["goals"][number];
type Task = Overview["tasks"][number];

const HORIZON: Record<Goal["horizon"], string> = { life: "Life", years: "Years", year: "This year", quarter: "This quarter", month: "This month", week: "This week" };

/**
 * The objective tree everything else hangs from. Read-only on purpose: a
 * goal changes by talking it through with midna, which keeps the reason.
 */
export function Objectives({ overview, onDiscuss }: { overview: Overview | null; onDiscuss: (text: string) => void }) {
  if (!overview) return <Loading />;
  const goals = overview.goals;
  const ids = new Set(goals.map((g) => g.id));
  const roots = goals.filter((g) => g.parent_id === null || !ids.has(g.parent_id));
  const children = (id: number) => goals.filter((g) => g.parent_id === id);
  const tasksFor = (id: number) => overview.tasks.filter((t) => t.goal_id === id);
  const orphans = overview.tasks.filter((t) => t.goal_id === null && t.owner === "user");

  return (
    <div className="mx-auto w-full max-w-[760px] px-8 pt-4 pb-10">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Objectives</h1>
          <p className="mt-0.5 max-w-[460px] text-[13px] text-dim">What everything midna does is for. Goals change by talking them through — every change keeps its reason.</p>
        </div>
        <Button onClick={() => onDiscuss(goals.length ? "Let's review my objectives." : "Let's set my objectives — interview me.")} icon={<Icon name="chat" className="size-3.5" />}>
          {goals.length ? "Review with midna" : "Set them with midna"}
        </Button>
      </header>

      {goals.length === 0 ? (
        <div className="sheet rounded-xl px-5 py-8 text-center">
          <p className="text-[14px] font-medium">No objectives yet.</p>
          <p className="mx-auto mt-1 max-w-[380px] text-[12.5px] text-dim">midna works best when it knows what you're aiming for — for your life, this year, this quarter. It'll interview you and draft them with you.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {roots.map((g) => (
            <GoalCard key={g.id} goal={g} depth={0} childrenOf={children} tasksFor={tasksFor} />
          ))}
        </div>
      )}

      {orphans.length > 0 && (
        <Section title="Tasks that serve no goal" className="mt-8" aside={<span className="text-[11.5px] text-dimmer">midna will ask about these</span>}>
          <div className="sheet overflow-hidden rounded-xl">
            {orphans.map((t) => (
              <div key={t.id} className="border-b border-line px-3.5 py-2 text-[13px] last:border-b-0">
                {t.title}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function GoalCard({ goal: g, depth, childrenOf, tasksFor }: { goal: Goal; depth: number; childrenOf: (id: number) => Goal[]; tasksFor: (id: number) => Task[] }) {
  const kids = childrenOf(g.id);
  const tasks = tasksFor(g.id);
  return (
    <div className={depth === 0 ? "sheet rounded-xl px-4 py-3.5" : "mt-3 border-l border-line-2 pl-4"}>
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-[10.5px] font-medium tracking-wide text-dimmer uppercase">{HORIZON[g.horizon]}</span>
        {g.status === "paused" && <span className="text-[10.5px] text-dimmer uppercase">· paused</span>}
        {g.target_at && <span className="ml-auto text-[11.5px] text-dimmer tabular">by {new Date(g.target_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>}
      </div>
      <div className={`selectable mt-0.5 font-medium ${depth === 0 ? "text-[15px]" : "text-[13.5px]"}`}>{g.title}</div>
      {(g.why || g.success) && (
        <div className="selectable mt-1 space-y-0.5 text-[12.5px] text-dim">
          {g.why && <p>Why: {g.why}</p>}
          {g.success && <p>Done when: {g.success}</p>}
        </div>
      )}
      {tasks.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[12.5px] text-ink-2">
          {tasks.slice(0, 4).map((t) => (
            <li key={t.id} className="flex gap-2">
              <span className="text-dimmer">{t.owner === "midna" ? "midna" : "you"}</span>
              <span className="selectable">{t.title}</span>
            </li>
          ))}
          {tasks.length > 4 && <li className="text-dimmer">and {tasks.length - 4} more</li>}
        </ul>
      )}
      {kids.map((k) => (
        <GoalCard key={k.id} goal={k} depth={depth + 1} childrenOf={childrenOf} tasksFor={tasksFor} />
      ))}
    </div>
  );
}
