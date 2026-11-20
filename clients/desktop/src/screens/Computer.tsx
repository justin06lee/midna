import { openPermissionSettings, relaunchApp, requestPermission, setHandsPaused, setOffer, type HandsStatus, type PermissionState, type Policy } from "../host";
import { Button, Empty, Group, Icon, Row, Section, Segmented, StateMark } from "../ui";
import { useHands } from "../useHands";

const CAPABILITY: Record<string, { label: string; what: string }> = {
  screen: { label: "See the screen", what: "Screenshots of any display, scaled down" },
  input: { label: "Use the mouse and keyboard", what: "Click, type, press keys, scroll and drag; stops when you touch either" },
  script: { label: "Run AppleScript", what: "AppleScript and JavaScript for Automation, to work other apps" },
  shell: { label: "Run commands", what: "In your login shell, as you" },
  files: { label: "Read and write files", what: "Anywhere macOS lets midna.app reach" },
  clipboard: { label: "Use the clipboard", what: "Read it, and put text, images or files on it" },
  open: { label: "Open things", what: "Links, apps and files, each in its usual app" },
  notify: { label: "Notify you", what: "Notifications here" },
};

const PERMISSION: Record<string, { label: string; what: string }> = {
  screen_recording: { label: "Screen Recording", what: "to see the screen" },
  accessibility: { label: "Accessibility", what: "to use the mouse and keyboard" },
  "automation:com.apple.MobileSMS": { label: "Automation: Messages", what: "to read and send messages" },
  "automation:com.apple.systemevents": { label: "Automation: System Events", what: "to work other apps" },
  full_disk_access: { label: "Full Disk Access", what: "to reach files outside your folders, like Messages' history" },
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
    <div className="mx-auto w-full max-w-[620px] space-y-7 px-8 pt-2 pb-12">
      <div>
        <h1 className="text-[20px] font-semibold">This Computer</h1>
        <p className="mt-0.5 text-[13px] text-dim">What midna may do on {here}, and what it did.</p>
      </div>

      <Section footer={`${mac ? "⌃⌥⌘P" : "Ctrl+Alt+Super+P"} pauses or resumes from anywhere, as does the menu bar icon.`}>
        <Group>
          <Row
            label={
              <span className="flex items-center gap-2">
                <StateMark state={hands.paused ? "offline" : hands.active ? "working" : hands.connected ? "running" : "online"} />
                {hands.paused ? "Paused" : hands.active ? `midna is using ${here}` : hands.connected ? `midna can reach ${here}` : `midna isn't connected to ${here} yet`}
              </span>
            }
            note={
              <>
                {hands.paused ? `midna can't do anything on ${here} until you resume.` : hands.active ? hands.active : hands.connected ? "For what you've turned on below." : null}
                {hands.problem && <span className="block text-ink-2">{hands.problem}</span>}
                {hands.connected && hands.fingerprint && (
                  <span className="block" title="Commands run here only when they're signed with this key, the one this computer trusts for its midna.">
                    midna's key: <span className="font-mono">{hands.fingerprint}</span>
                  </span>
                )}
              </>
            }
          >
            <Button variant={hands.paused ? "primary" : "default"} onClick={() => void setHandsPaused(!hands.paused).then(refresh)} icon={hands.paused ? undefined : <Icon name="pause" className="size-3.5" />}>
              {hands.paused ? "Resume" : "Pause"}
            </Button>
          </Row>
        </Group>
      </Section>

      <Section
        title="What midna may do"
        footer="Ask: midna asks first, each time, here, in the chat and on Telegram; the first answer wins, and none in 2 minutes means no. In ask mode, anything that changes something asks first even when it's On."
      >
        <Group>
          {available.map((c) => {
            const need = permission(c.needs);
            return (
              <Row
                key={c.id}
                label={CAPABILITY[c.id]?.label ?? c.id}
                note={
                  <>
                    {CAPABILITY[c.id]?.what}
                    {c.id === "screen" && hands.displays.length > 1 && ` · ${hands.displays.length} displays`}
                    {need && need.state !== "granted" && need.state !== "unknown" && c.policy !== "off" && <span className="text-ink-2"> · needs {PERMISSION[need.id]?.label}, below</span>}
                  </>
                }
              >
                <Segmented<Policy>
                  value={c.policy}
                  onChange={(p) => void setOffer(c.id, p).then(refresh)}
                  options={[
                    { value: "off", label: "Off" },
                    { value: "ask", label: "Ask" },
                    { value: "on", label: "On" },
                  ]}
                />
              </Row>
            );
          })}
        </Group>
      </Section>

      {hands.permissions.length > 0 && (
        <Section title="Permissions" footer="They belong to midna.app, so you give each one once; updates keep them.">
          <Group>
            {hands.permissions.map((p) => (
              <PermissionRow key={p.id} id={p.id} state={p.state} onChange={refresh} />
            ))}
          </Group>
        </Section>
      )}

      <Section title="Recently">
        <Group>{hands.recent.length ? <Recent entries={hands.recent.slice(0, 30)} /> : <Row label={<span className="text-dim">Nothing yet.</span>} />}</Group>
      </Section>
    </div>
  );
}

function PermissionRow({ id, state, onChange }: { id: string; state: PermissionState; onChange: () => void }) {
  const info = PERMISSION[id] ?? { label: id, what: "" };
  const canAsk = state === "not_asked" || state === "not_running" || (state === "not_granted" && (id === "screen_recording" || id === "accessibility"));
  return (
    <Row
      label={
        <span className="flex items-center gap-2">
          <span className={`flex size-4 items-center justify-center ${state === "granted" ? "text-[var(--ok)]" : "text-dimmer"}`}>
            {state === "granted" ? <Icon name="check" className="size-4" /> : <span className="size-2 rounded-full border border-current" />}
          </span>
          {info.label}
        </span>
      }
      note={
        <span className="block pl-6">
          {STATE[state]} · {info.what}
          {id === "screen_recording" && state !== "granted" && (
            <span className="mt-1 flex items-center gap-2">
              Once it's on in System Settings, it works after a relaunch.
              <Button size="sm" variant="ghost" className="-my-1" onClick={() => void relaunchApp()}>
                Relaunch midna
              </Button>
            </span>
          )}
        </span>
      }
    >
      {canAsk && <Button onClick={() => void requestPermission(id).then(onChange)}>Allow…</Button>}
      <Button variant="ghost" onClick={() => void openPermissionSettings(id)}>
        Open Settings…
      </Button>
    </Row>
  );
}

const OUTCOME: Record<string, string> = {
  paused: "paused",
  off: "turned off",
  locked: "locked",
  asleep: "display asleep",
  user_active: "you were using it",
  permission: "no permission",
  unsupported: "can't yet",
  bad_args: "didn't make sense",
  failed: "failed",
  timeout: "took too long",
  cancelled: "cancelled",
};

function Recent({ entries }: { entries: HandsStatus["recent"] }) {
  return (
    <>
      {entries.map((e) => (
        <div key={e.id + e.at} className="flex items-baseline gap-3 px-3 py-1.5 text-[12.5px]">
          <span className="w-16 shrink-0 text-[11.5px] text-dim tabular">{new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          <span className="min-w-0 flex-1 truncate" title={e.detail}>
            {e.summary}
          </span>
          <span className={`shrink-0 text-[11.5px] ${e.outcome === "ok" ? "text-dim" : "text-ink-2"}`}>{e.outcome === "ok" ? `${e.ms} ms` : (OUTCOME[e.outcome] ?? e.outcome)}</span>
        </div>
      ))}
    </>
  );
}
