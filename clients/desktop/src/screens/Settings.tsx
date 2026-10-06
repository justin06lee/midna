import { useEffect, useState } from "react";
import type { BrainInfo, BridgeInfo, BridgeSetupResult, Connection, DeviceInfo, MidnaClient, Status } from "@midna/protocol";
import { copy, inApp, launchAtLogin, openUrl } from "../host";
import { Button, Icon, Section, Segmented, StateMark } from "../ui";

const SUGGESTED = ["claude:opus", "claude:sonnet", "claude:haiku", "codex", "gemini", "opencode"];

/** Everything about how midna runs, and where. */
export function Settings({
  client,
  status,
  connection,
  onStatus,
  onCheckBrain,
  onSignIn,
  onDisconnect,
}: {
  client: MidnaClient;
  status: Status | null;
  connection: Connection;
  onStatus: (s: Status) => void;
  onCheckBrain: () => Promise<void>;
  onSignIn: () => void;
  onDisconnect: () => void;
}) {
  const [brains, setBrains] = useState<BrainInfo[]>([]);
  const [bridges, setBridges] = useState<BridgeInfo[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [model, setModel] = useState(status?.model ?? "");
  const [timezone, setTimezone] = useState(status?.timezone ?? "");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [atLogin, setAtLogin] = useState<boolean | null>(null);

  useEffect(() => {
    void client.brains().then(setBrains, () => {});
    void client.bridges().then(setBridges, () => {});
    void client.devices().then(setDevices, () => {});
    void launchAtLogin().then(setAtLogin, () => setAtLogin(null));
  }, [client]);
  useEffect(() => {
    if (status) {
      setModel(status.model);
      setTimezone(status.timezone);
    }
  }, [status?.model, status?.timezone]);

  const save = async (what: string, patch: Parameters<MidnaClient["updateSettings"]>[0]) => {
    setSaving(what);
    setError(null);
    try {
      onStatus(await client.updateSettings(patch));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const telegram = bridges.find((b) => b.name === "telegram");
  const installed = brains.filter((b) => b.installed).map((b) => b.id);
  const brain = status?.brain;

  return (
    <div className="mx-auto w-full max-w-[680px] space-y-8 px-8 pt-4 pb-12">
      <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Settings</h1>
      {error && <div className="rise rounded-lg border border-line-2 bg-panel px-3.5 py-2.5 text-[12.5px]">{error}</div>}

      <Section title="Brain">
        <Card>
          <p className="text-[12.5px] text-dim">
            The agent CLI midna thinks with, as <span className="font-mono text-[11.5px]">provider:model</span>. Installed on {status?.host.name ?? "the host"}: {installed.length ? installed.join(", ") : "…"}.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input list="models" className="field h-8 w-56 px-2.5 font-mono text-[12px]" value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
            <datalist id="models">
              {SUGGESTED.filter((s) => installed.includes(s.split(":")[0]!)).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <Button onClick={() => void save("model", { model })} busy={saving === "model"} disabled={!model.trim() || model === status?.model}>
              Use this
            </Button>
          </div>
          <div className="mt-3 flex items-center gap-2 border-t border-line pt-3 text-[12.5px]">
            <StateMark state={brain?.ok === false ? "offline" : brain?.ok ? "running" : "online"} />
            <span className="flex-1 text-ink-2">
              {brain?.ok === false ? (brain.reason === "signed_out" ? `Not signed in on ${status?.host.name}` : brain.message) : brain?.ok ? "Answering" : "Not tried yet"}
            </span>
            {brain?.ok === false && brain.reason === "signed_out" && (
              <Button size="sm" variant="primary" onClick={onSignIn} icon={<Icon name="terminal" className="size-3.5" />}>
                Sign in on {status?.host.name}
              </Button>
            )}
            <Button
              size="sm"
              busy={checking}
              onClick={async () => {
                setChecking(true);
                await onCheckBrain().finally(() => setChecking(false));
              }}
            >
              Check
            </Button>
          </div>
        </Card>
      </Section>

      <Section title="How midna acts">
        <Card>
          <Segmented
            value={status?.mode ?? "autonomous"}
            disabled={!status || saving === "mode"}
            onChange={(mode) => void save("mode", { mode })}
            options={[
              { value: "autonomous", label: "On its own" },
              { value: "ask", label: "Ask first" },
            ]}
          />
          <p className="mt-2.5 text-[12.5px] text-dim">
            {status?.mode === "ask"
              ? "midna reads and keeps its records freely, but asks before running commands, changing files or acting for you."
              : `midna has the run of ${status?.host.name ?? "its machine"} and acts without asking, judged against your objectives. Everything it does is logged.`}
          </p>
        </Card>
      </Section>

      <Section title="Time">
        <Card>
          <Row label="Timezone">
            <input className="field h-8 w-56 px-2.5 text-[12.5px]" value={timezone} onChange={(e) => setTimezone(e.target.value)} spellCheck={false} />
            <Button onClick={() => void save("tz", { timezone })} busy={saving === "tz"} disabled={!timezone.trim() || timezone === status?.timezone}>
              Save
            </Button>
          </Row>
          {status && <QuietHours client={client} initial={status.quietHours} onStatus={onStatus} />}
        </Card>
      </Section>

      <Section title="Your phone">
        <Card>
          {telegram?.enabled ? (
            <div className="flex items-center gap-2 text-[13px]">
              <StateMark state="running" /> Telegram is connected. midna messages you there when you're away from here.
            </div>
          ) : (
            <TelegramSetup client={client} onDone={() => void client.bridges().then(setBridges)} />
          )}
        </Card>
      </Section>

      {inApp && (
        <Section title="This computer">
          <Card>
            <Row label="Open at login">
              <Segmented
                value={atLogin ? "on" : "off"}
                disabled={atLogin === null}
                onChange={async (v) => setAtLogin(await launchAtLogin(v === "on"))}
                options={[
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]}
              />
              <span className="text-[12px] text-dimmer">so midna can reach you from the tray</span>
            </Row>
          </Card>
        </Section>
      )}

      <Section title="Where midna lives">
        <Card>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium">{connection.host}</div>
              <div className="selectable mt-0.5 font-mono text-[11.5px] text-dim">
                {connection.url} · midna {status?.version ?? "…"} · {status?.host.platform}
              </div>
            </div>
            <Button onClick={onDisconnect}>Use another machine</Button>
          </div>
          {devices.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <div className="mb-1.5 text-[12px] text-dim">Paired with it</div>
              {devices.map((d) => (
                <div key={d.id} className="flex items-center gap-2 py-1 text-[12.5px]">
                  <span className="w-14 text-[11.5px] text-dimmer">{d.kind}</span>
                  <span className="flex-1 truncate">
                    {d.name}
                    {d.id === connection.device && <span className="text-dimmer"> · this app</span>}
                  </span>
                  <span className="text-[11.5px] text-dimmer">{d.last_seen_at ? `seen ${new Date(d.last_seen_at).toLocaleDateString()}` : "never seen"}</span>
                  {d.id !== connection.device && d.kind !== "host" && !d.name.endsWith("(host)") && (
                    <Button size="sm" variant="ghost" onClick={async () => setDevices(await client.revokeDevice(d.id).then(() => client.devices()))}>
                      Unpair
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </Section>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="sheet rounded-xl px-4 py-3.5">{children}</div>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="w-28 shrink-0 text-[12.5px] text-dim">{label}</span>
      <div className="flex flex-1 items-center gap-2">{children}</div>
    </div>
  );
}

function QuietHours({ client, initial, onStatus }: { client: MidnaClient; initial: Status["quietHours"]; onStatus: (s: Status) => void }) {
  const [on, setOn] = useState(initial !== null);
  const [start, setStart] = useState(initial?.start ?? "23:00");
  const [end, setEnd] = useState(initial?.end ?? "08:00");
  const [saved, setSaved] = useState(false);
  const commit = async (next: { on: boolean; start: string; end: string }) => {
    setSaved(false);
    onStatus(await client.updateSettings({ quietHours: next.on ? { start: next.start, end: next.end } : null }));
    setSaved(true);
  };
  return (
    <Row label="Quiet hours">
      <Segmented
        value={on ? "on" : "off"}
        onChange={(v) => {
          setOn(v === "on");
          void commit({ on: v === "on", start, end });
        }}
        options={[
          { value: "on", label: "On" },
          { value: "off", label: "Off" },
        ]}
      />
      {on && (
        <>
          <input type="time" className="field h-8 px-2 text-[12.5px]" value={start} onChange={(e) => setStart(e.target.value)} onBlur={() => void commit({ on, start, end })} />
          <span className="text-dimmer">–</span>
          <input type="time" className="field h-8 px-2 text-[12.5px]" value={end} onChange={(e) => setEnd(e.target.value)} onBlur={() => void commit({ on, start, end })} />
        </>
      )}
      {saved && <Icon name="check" className="size-3.5 text-dim" />}
    </Row>
  );
}

function TelegramSetup({ client, onDone }: { client: MidnaClient; onDone: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BridgeSetupResult | null>(null);
  const [copied, setCopied] = useState(false);

  if (result) {
    return (
      <div className="rise">
        <p className="text-[13px]">{result.instructions}</p>
        <div className="mt-3 flex items-center gap-2">
          <code className="selectable rounded-md border border-line-2 bg-sunken px-2.5 py-1.5 font-mono text-[13px]">{result.code}</code>
          <Button
            size="sm"
            onClick={async () => {
              await copy(result.code!);
              setCopied(true);
            }}
            icon={<Icon name={copied ? "check" : "copy"} className="size-3.5" />}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          {result.link && (
            <Button size="sm" variant="primary" onClick={() => void openUrl(result.link!)} icon={<Icon name="external" className="size-3.5" />}>
              Open the bot
            </Button>
          )}
        </div>
        <Button size="sm" variant="ghost" className="mt-2 -ml-2" onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }
  return (
    <div>
      <p className="text-[12.5px] text-dim">
        Until midna has its own phone app, it reaches you through a Telegram bot of your own. In Telegram, message{" "}
        <a className="cursor-pointer text-ink underline decoration-dimmer underline-offset-2" onClick={() => void openUrl("https://t.me/BotFather")}>
          @BotFather
        </a>
        , send <span className="font-mono text-[11.5px]">/newbot</span>, and paste the token it gives you.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input className="field h-8 flex-1 px-2.5 font-mono text-[12px]" placeholder="123456789:AA…" value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} />
        <Button
          variant="primary"
          busy={busy}
          disabled={!token.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setResult(await client.setupBridge("telegram", { token: token.trim() }));
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Connect
        </Button>
      </div>
      {error && <p className="mt-2 text-[12px] text-ink-2">{error}</p>}
    </div>
  );
}
