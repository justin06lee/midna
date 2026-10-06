import { useEffect, useState } from "react";
import type { DiscoveredDevice } from "@midna/protocol";
import { discoverDevices, type InstallChoices } from "../host";
import { Button, Icon, Mark, Segmented, Spinner, StateMark } from "../ui";

/** Best home first: where midna already runs, then other machines that are up, then this one, then whatever is off. */
function rank(d: DiscoveredDevice): number {
  if (!d.online) return 3;
  if (d.midna.running) return 0;
  return d.self ? 2 : 1;
}

const viaLabel = (d: DiscoveredDevice) => (d.self ? "this computer" : `${d.via} · ${d.address}`);

/**
 * "Where should midna live?" — every machine this computer can see, one
 * click from being midna's home.
 */
export function Welcome({ choices, onChoices, onPick, notice }: { choices: InstallChoices; onChoices: (c: InstallChoices) => void; onPick: (d: DiscoveredDevice) => void; notice?: string | null }) {
  const [devices, setDevices] = useState<DiscoveredDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [showOptions, setShowOptions] = useState(false);

  const look = async () => {
    setLooking(true);
    setError(null);
    try {
      setDevices((await discoverDevices()).sort((a, b) => rank(a) - rank(b)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLooking(false);
    }
  };
  useEffect(() => void look(), []);

  const remote = devices?.filter((d) => !d.self).length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-10 shrink-0" />
      <div className="flex flex-1 justify-center overflow-y-auto px-8 pb-10">
        <div className="w-full max-w-[560px] pt-6">
          <div className="mb-7 flex flex-col items-center text-center">
            <div className="mb-4 flex size-12 items-center justify-center rounded-[14px] bg-primary text-primary-ink shadow-[0_8px_24px_-10px_rgba(0,0,0,0.5)]">
              <Mark className="size-7" />
            </div>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Where should midna live?</h1>
            <p className="mt-1.5 max-w-[420px] text-[13.5px] text-dim">
              Pick the computer that stays on. midna runs there, keeps track of everything, and reaches you wherever you are.
            </p>
          </div>

          {notice && <div className="rise mb-4 rounded-lg border border-line-2 bg-panel px-3.5 py-2.5 text-[12.5px] text-ink-2">{notice}</div>}

          <div className="sheet overflow-hidden rounded-xl">
            {!devices && !error && (
              <div className="flex items-center gap-2.5 px-4 py-5 text-dim">
                <Spinner /> Looking for your machines…
              </div>
            )}
            {error && <div className="px-4 py-4 text-[12.5px] text-ink-2">Couldn't look for machines: {error}</div>}
            {devices?.map((d, i) => (
              <DeviceRow key={d.id} device={d} first={i === 0} onPick={() => onPick(d)} />
            ))}
          </div>

          <div className="mt-2.5 flex items-center justify-between px-1 text-[12px] text-dimmer">
            <span>
              {devices && remote === 0
                ? "No other machines found. midna finds them over makima or Tailscale."
                : "Found over makima and Tailscale. Setting up a machine reaches it over SSH."}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void look()} busy={looking} icon={<Icon name="refresh" className="size-3.5" />}>
              Look again
            </Button>
          </div>

          <div className="mt-6 rounded-xl border border-line px-4 py-3">
            <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setShowOptions((v) => !v)}>
              <span className="text-[12.5px] text-dim">
                Starts with <span className="text-ink-2">{choices.model}</span> · <span className="text-ink-2">{choices.timezone}</span> ·{" "}
                <span className="text-ink-2">{choices.mode === "autonomous" ? "acts on its own" : "asks first"}</span>
              </span>
              <span className="text-[12px] text-dimmer">{showOptions ? "Done" : "Change"}</span>
            </button>
            {showOptions && (
              <div className="rise mt-3 grid grid-cols-[110px_1fr] items-center gap-x-4 gap-y-3 border-t border-line pt-3">
                <label className="text-[12.5px] text-dim">Brain</label>
                <div className="flex items-center gap-2">
                  <input className="field h-8 w-52 px-2.5 font-mono text-[12px]" value={choices.model} onChange={(e) => onChoices({ ...choices, model: e.target.value })} spellCheck={false} />
                  <span className="text-[11.5px] text-dimmer">claude:opus, claude:sonnet, codex, gemini…</span>
                </div>
                <label className="text-[12.5px] text-dim">Timezone</label>
                <input className="field h-8 w-52 px-2.5 text-[12.5px]" value={choices.timezone} onChange={(e) => onChoices({ ...choices, timezone: e.target.value })} spellCheck={false} />
                <label className="text-[12.5px] text-dim">Acting</label>
                <Segmented
                  value={choices.mode}
                  onChange={(mode) => onChoices({ ...choices, mode })}
                  options={[
                    { value: "autonomous", label: "On its own" },
                    { value: "ask", label: "Ask first" },
                  ]}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DeviceRow({ device: d, first, onPick }: { device: DiscoveredDevice; first: boolean; onPick: () => void }) {
  const state = !d.online ? "offline" : d.midna.running ? "running" : "online";
  return (
    <div className={`group flex items-center gap-3.5 px-4 py-3.5 ${first ? "" : "border-t border-line"} ${d.online ? "" : "opacity-50"}`}>
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-[10px] border ${d.midna.running ? "border-transparent bg-primary text-primary-ink" : "border-line-2 bg-sunken text-ink-2"}`}>
        {d.midna.running ? <Mark className="size-[18px]" /> : <span className="text-[14px] font-semibold uppercase">{d.name.slice(0, 1)}</span>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium">{d.name}</span>
          {d.self && <span className="rounded-full border border-line-2 px-1.5 text-[10.5px] text-dim">this computer</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-dim">
          <StateMark state={state} />
          <span className="truncate">
            {!d.online ? "offline" : d.midna.running ? `midna ${d.midna.version} is running here` : d.self ? "midna would run on this computer" : viaLabel(d)}
          </span>
        </div>
      </div>
      <Button variant={first && d.online ? "primary" : "default"} disabled={!d.online} onClick={onPick}>
        {d.midna.running ? "Connect" : "Set up here"}
      </Button>
    </div>
  );
}
