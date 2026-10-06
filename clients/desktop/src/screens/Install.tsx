import { useEffect, useRef, useState } from "react";
import { INSTALL_STEPS, type Connection, type DiscoveredDevice, type InstallEvent, type InstallStepId } from "@midna/protocol";
import { installOn, openTerminal, type InstallChoices } from "../host";
import { Button, Icon, Mark, Spinner } from "../ui";

type StepState = { status: "waiting" | "running" | "done" | "skipped" | "failed"; detail?: string; progress?: { done: number; total: number } };
type Failure = Extract<InstallEvent, { type: "failed" }>;

const ORDER = Object.keys(INSTALL_STEPS) as InstallStepId[];

/** Making a machine midna's home, one visible step at a time. */
export function Install({ device, choices, onDone, onBack }: { device: DiscoveredDevice; choices: InstallChoices; onDone: (c: Connection) => void; onBack: () => void }) {
  const [steps, setSteps] = useState<Record<InstallStepId, StepState>>(() => Object.fromEntries(ORDER.map((id) => [id, { status: "waiting" }])) as Record<InstallStepId, StepState>);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [finished, setFinished] = useState<Connection | null>(null);
  const started = useRef(-1);

  useEffect(() => {
    if (started.current === attempt) return; // React's double effect in development
    started.current = attempt;
    setFailure(null);
    setSteps(Object.fromEntries(ORDER.map((id) => [id, { status: "waiting" }])) as Record<InstallStepId, StepState>);
    void installOn(device, choices, (e) => {
      if (e.type === "step") setSteps((s) => ({ ...s, [e.id]: { status: e.status, detail: e.detail } }));
      else if (e.type === "progress") setSteps((s) => ({ ...s, [e.id]: { ...s[e.id], progress: { done: e.done, total: e.total } } }));
      else if (e.type === "failed") setFailure(e);
      else if (e.type === "done") setFinished(e.connection);
    }).catch((err) => setFailure({ type: "failed", id: "reach", message: (err as Error).message }));
  }, [attempt, device, choices]);

  // A breath on the finished state, then into the app.
  useEffect(() => {
    if (!finished) return;
    const t = setTimeout(() => onDone(finished), 900);
    return () => clearTimeout(t);
  }, [finished, onDone]);

  const busy = !failure && !finished;
  const verb = device.midna.running ? "Connecting to" : "Setting up midna on";

  return (
    <div className="flex h-full flex-col">
      <div className="drag flex h-10 shrink-0 items-center px-3 pl-20">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={busy} icon={<Icon name="back" className="size-3.5" />}>
          Machines
        </Button>
      </div>
      <div className="flex flex-1 justify-center overflow-y-auto px-8 pb-10">
        <div className="w-full max-w-[520px] pt-8">
          <div className="mb-6 flex items-center gap-3.5">
            <div className="flex size-11 items-center justify-center rounded-[12px] bg-primary text-primary-ink">
              {finished ? <Icon name="check" className="size-5" /> : <Mark className="size-6" />}
            </div>
            <div>
              <h1 className="text-[19px] font-semibold tracking-[-0.015em]">{finished ? `midna lives on ${device.name}` : `${verb} ${device.name}`}</h1>
              <p className="text-[12.5px] text-dim">{device.self ? "this computer" : `${device.via} · ${device.address}`}</p>
            </div>
          </div>

          <ol className="sheet overflow-hidden rounded-xl">
            {ORDER.map((id, i) => (
              <StepRow key={id} title={INSTALL_STEPS[id]} state={steps[id]} first={i === 0} />
            ))}
          </ol>

          {failure && (
            <div className="rise mt-4 rounded-xl border border-line-2 bg-panel px-4 py-3.5">
              <p className="text-[13.5px] font-medium">{failure.message}</p>
              {failure.hint && <p className="selectable mt-1 text-[12.5px] text-dim">{failure.hint}</p>}
              <div className="mt-3 flex gap-2">
                {failure.action && (
                  <Button variant="primary" onClick={() => void openTerminal(failure.action!.terminal)} icon={<Icon name="terminal" className="size-3.5" />}>
                    {failure.action.label}
                  </Button>
                )}
                <Button variant={failure.action ? "default" : "primary"} onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </Button>
                <Button variant="ghost" onClick={onBack}>
                  Pick another machine
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepRow({ title, state, first }: { title: string; state: StepState; first: boolean }) {
  const mark = {
    waiting: <span className="size-3 rounded-full border border-line-2" />,
    running: <Spinner className="size-3.5" />,
    done: <Icon name="check" className="size-3.5" />,
    skipped: <span className="h-px w-2.5 bg-dimmer" />,
    failed: <Icon name="cross" className="size-3.5" />,
  }[state.status];
  const pct = state.progress && state.status === "running" ? Math.round((state.progress.done / state.progress.total) * 100) : null;
  return (
    <li className={`flex items-center gap-3 px-4 py-3 ${first ? "" : "border-t border-line"}`}>
      <span className="flex size-4 items-center justify-center">{mark}</span>
      <span className={`flex-1 text-[13px] ${state.status === "waiting" ? "text-dimmer" : state.status === "failed" ? "font-medium" : ""}`}>{title}</span>
      {pct !== null ? (
        <span className="flex items-center gap-2 text-[12px] text-dim tabular">
          <span className="h-1 w-24 overflow-hidden rounded-full bg-active">
            <span className="block h-full bg-primary transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </span>
          {(state.progress!.done / 1_048_576).toFixed(0)} / {(state.progress!.total / 1_048_576).toFixed(0)} MB
        </span>
      ) : (
        state.detail && <span className="max-w-[55%] truncate text-right text-[12px] text-dim">{state.detail}</span>
      )}
    </li>
  );
}
