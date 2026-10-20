import type { ReactNode } from "react";
import { openPermissionSettings, relaunchApp, requestPermission, setHandsPaused, setOffer, type HandsStatus, type PermissionState, type Policy } from "../host";
import { Button, Empty, Icon, Section, Segmented, StateMark } from "../ui";
import { useHands } from "../useHands";

const CAPABILITY: Record<string, { label: string; what: string }> = {
  screen: { label: "See the screen", what: "Screenshots of any display, scaled down" },
  open: { label: "Open things", what: "Links, apps and files, each in its usual app" },
  notify: { label: "Notify you", what: "Notifications here" },
};

const PERMISSION: Record<string, { label: string; what: string }> = {
  screen_recording: { label: "Screen Recording", what: "to see the screen" },
  accessibility: { label: "Accessibility", what: "to use the mouse and keyboard, later" },
  "automation:com.apple.MobileSMS": { label: "Automation: Messages", what: "to read and send messages, later" },
  "automation:com.apple.systemevents": { label: "Automation: System Events", what: "to work other apps, later" },
  full_disk_access: { label: "Full Disk Access", what: "to read files outside your folders, later" },
  notifications: { label: "Notifications", what: "to notify you" },
};

const STATE: Record<PermissionState, string> = {
  granted: "Allowed",
  not_granted: "Not allowed",
  not_asked: "Not asked yet",
  not_running: "Ask to check",
  unknown: "Unknown",
  not_applicable: "Not needed",
};

/** What midna may do on this computer, the permissions behind it, and what it did. */
export function Computer() {
  const { hands, refresh } = useHands(true);
  if (!hands) return <Empty>This screen is part of the desktop app.</Empty>;
  const mac = hands.platform === "macos";
  const here = mac ? "this Mac" : "this computer";
  const available = hands.capabilities.filter((c) => c.available);
  const permission = (id: string | null) => hands.permissions.find((p) => p.id === id);

  return (
    <div className="mx-auto w-full max-w-[680px] space-y-8 px-8 pt-4 pb-12">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">This computer</h1>
        <p className="mt-1 text-[13px] text-dim">What midna may do on {here}, and what it did.</p>
      </div>

      <Card>
        <div className="flex items-center gap-3">
          <StateMark state={hands.paused ? "offline" : hands.active ? "working" : hands.connected ? "running" : "online"} />
          <div className="min-w-0 flex-1 text-[13px]">
            {hands.paused ? (
              <>Paused. midna can't do anything on {here} until you resume.</>
            ) : hands.active ? (
              <>midna is using {here}: {hands.active}</>
            ) : hands.connected ? (
              <>midna can reach {here}, for what you've turned on below.</>
            ) : (
              <>midna isn't connected to {here} yet.</>
            )}
            {hands.problem && <div className="mt-1 text-[12.5px] text-ink-2">{hands.problem}</div>}
            <div className="mt-0.5 text-[12px] text-dimmer">{mac ? "⌃⌥⌘P" : "Ctrl+Alt+Super+P"} pauses or resumes from anywhere, as does the menu bar icon.</div>
          </div>
          <Button variant={hands.paused ? "primary" : "default"} onClick={() => void setHandsPaused(!hands.paused).then(refresh)} icon={hands.paused ? undefined : <Icon name="pause" className="size-3.5" />}>
            {hands.paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </Card>

      <Section title="What midna may do">
        <Card>
          {available.map((c, i) => {
            const need = permission(c.needs);
            return (
              <div key={c.id} className={`flex items-center gap-3 py-2.5 ${i ? "border-t border-line" : ""}`}>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{CAPABILITY[c.id]?.label ?? c.id}</div>
                  <div className="text-[12px] text-dim">
                    {CAPABILITY[c.id]?.what}
                    {c.id === "screen" && hands.displays.length > 1 && ` · ${hands.displays.length} displays`}
                    {need && need.state !== "granted" && need.state !== "unknown" && c.policy !== "off" && (
                      <span className="text-ink-2"> · needs {PERMISSION[need.id]?.label}, below</span>
                    )}
                  </div>
                </div>
                <Segmented<Policy>
                  value={c.policy}
                  onChange={(p) => void setOffer(c.id, p).then(refresh)}
                  options={[
                    { value: "off", label: "Off" },
                    { value: "ask", label: "Ask" },
                    { value: "on", label: "On" },
                  ]}
                />
              </div>
            );
          })}
          <p className="mt-2 border-t border-line pt-3 text-[12px] text-dimmer">
            Ask: midna asks you first, each time. Mouse and keyboard, AppleScript, the shell, files and the clipboard come later.
          </p>
        </Card>
      </Section>

      {hands.permissions.length > 0 && (
        <Section title="Permissions">
          <Card>
            {hands.permissions.map((p, i) => (
              <PermissionRow key={p.id} id={p.id} state={p.state} first={i === 0} onChange={refresh} />
            ))}
            <p className="mt-2 border-t border-line pt-3 text-[12px] text-dimmer">
              They belong to midna.app, so you give each one once; updates keep them.
            </p>
          </Card>
        </Section>
      )}

      <Section title="Recently">
        <Card>{hands.recent.length ? <Recent entries={hands.recent.slice(0, 30)} /> : <p className="py-1 text-[12.5px] text-dim">Nothing yet.</p>}</Card>
      </Section>
    </div>
  );
}

function PermissionRow({ id, state, first, onChange }: { id: string; state: PermissionState; first: boolean; onChange: () => void }) {
  const info = PERMISSION[id] ?? { label: id, what: "" };
  const canAsk = state === "not_asked" || state === "not_running" || (state === "not_granted" && (id === "screen_recording" || id === "accessibility"));
  return (
    <div className={`py-2.5 ${first ? "" : "border-t border-line"}`}>
      <div className="flex items-center gap-3">
        <span className={`flex size-4 items-center justify-center ${state === "granted" ? "text-ink" : "text-dimmer"}`}>
          {state === "granted" ? <Icon name="check" className="size-3.5" /> : <span className="size-2 rounded-full border border-current" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">{info.label}</div>
          <div className="text-[12px] text-dim">
            {STATE[state]} · {info.what}
          </div>
        </div>
        {canAsk && (
          <Button size="sm" onClick={() => void requestPermission(id).then(onChange)}>
            Ask
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void openPermissionSettings(id)} icon={<Icon name="external" className="size-3.5" />}>
          Settings
        </Button>
      </div>
      {id === "screen_recording" && state !== "granted" && (
        <div className="mt-1.5 ml-7 flex items-center gap-2 text-[12px] text-dimmer">
          macOS lets midna use it only after a relaunch.
          <Button size="sm" variant="ghost" className="-my-1" onClick={() => void relaunchApp()}>
            Relaunch midna
          </Button>
        </div>
      )}
    </div>
  );
}

const OUTCOME: Record<string, string> = {
  paused: "paused",
  off: "turned off",
  locked: "locked",
  permission: "no permission",
  unsupported: "can't yet",
  bad_args: "didn't make sense",
  failed: "failed",
};

function Recent({ entries }: { entries: HandsStatus["recent"] }) {
  return (
    <div>
      {entries.map((e, i) => (
        <div key={e.id + e.at} className={`flex items-baseline gap-3 py-1.5 text-[12.5px] ${i ? "border-t border-line" : ""}`}>
          <span className="w-16 shrink-0 text-[11.5px] text-dimmer tabular">{new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          <span className="min-w-0 flex-1 truncate" title={e.detail}>
            {e.summary}
          </span>
          <span className={`shrink-0 text-[11.5px] ${e.outcome === "ok" ? "text-dimmer" : "text-ink-2"}`}>{e.outcome === "ok" ? `${e.ms} ms` : (OUTCOME[e.outcome] ?? e.outcome)}</span>
        </div>
      ))}
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="sheet rounded-xl px-4 py-3.5">{children}</div>;
}
