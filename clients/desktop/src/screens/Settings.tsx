import { useEffect, useState } from "react";
import { accountChoices, modelName, thinkingWith, type BridgeInfo, type BridgeSetupResult, type Connection, type DeviceInfo, type MidnaClient, type Status } from "@midna/protocol";
import { loadAppearance, setAppearance, type Appearance } from "../appearance";
import { draftKey, useDraft, useSecretDraft } from "../drafts";
import { copy, enableNotifications, inApp, launchAtLogin, openUrl, testNotification } from "../host";
import { ModelMenu, useModels } from "../ModelMenu";
import { Button, Group, Icon, Row, Section, Segmented, StateMark, Switch } from "../ui";
import { useNotifications } from "../useNotifications";

/** "codex, claude:sonnet" as the list it names. */
const models = (text: string): string[] => text.split(",").map((m) => m.trim()).filter(Boolean);

const KIND: Record<string, string> = { desktop: "Computer", mobile: "Phone", cli: "Command line", bridge: "Bridge", host: "Host", service: "Service" };

/** Saves a change; says whether it took, so a draft goes only then. */
type Save = (what: string, patch: Parameters<MidnaClient["updateSettings"]>[0]) => Promise<boolean>;

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
  // The brains' own lists, so a stand-in and the fallbacks are called what their brains call them.
  const { brains, catalogues } = useModels(client, status, false);
  const [bridges, setBridges] = useState<BridgeInfo[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const drafts = draftKey(connection);
  const other = useDraft(`${drafts}:model`, "");
  const fallback = useDraft(`${drafts}:fallback`, status?.fallback?.join(", ") ?? "");
  const timezone = useDraft(`${drafts}:timezone`, status?.timezone ?? "");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [atLogin, setAtLogin] = useState<boolean | null>(null);
  const [appearance, setAppearanceState] = useState<Appearance>(loadAppearance);

  useEffect(() => {
    void client.bridges().then(setBridges, () => {});
    void client.devices().then(setDevices, () => {});
    void launchAtLogin().then(setAtLogin, () => setAtLogin(null));
  }, [client]);
  const save: Save = async (what, patch) => {
    setSaving(what);
    setError(null);
    try {
      onStatus(await client.updateSettings(patch));
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setSaving(null);
    }
  };

  const telegram = bridges.find((b) => b.name === "telegram");
  const installed = brains.filter((b) => b.installed).map((b) => b.id);
  const brain = status?.brain;
  const host = status?.host.name ?? connection.host;
  const accounts = status ? accountChoices(status) : [];
  const account = accounts.find((a) => a.selected);
  const now = status ? thinkingWith(status, brains, catalogues) : null;
  const fallbacks = (status?.fallback ?? []).map((m) => modelName(m, brains, catalogues));

  return (
    <div className="mx-auto w-full max-w-[620px] space-y-7 px-8 pt-2 pb-12">
      <h1 className="text-[20px] font-semibold">Settings</h1>
      {error && (
        <div role="alert" className="rise selectable rounded-[10px] bg-fill px-3.5 py-2.5 text-[12.5px]">
          {error}
        </div>
      )}

      <Section title="Model">
        <Group>
          <Row label="Thinks with" note={now?.standIn ? `${now.standIn}, so ${now.name} is thinking meanwhile.` : "A change holds from midna's next turn, on every device."}>
            <ModelMenu client={client} status={status} onStatus={onStatus} look="button" drop="down" />
          </Row>
          {account && (
            <Row label="Claude account" note={account.note}>
              <Segmented value={account.account} disabled={saving === "account"} onChange={(a) => void save("account", { account: a })} options={accounts.map((a) => ({ value: a.account, label: a.name }))} />
            </Row>
          )}
          {status?.fallback && (
            <Row label="When it runs out of usage" note={`${fallbacks.length ? `Now ${fallbacks.join(", then ")}. ` : ""}Think with these meanwhile, in order, as provider:model. Empty, midna waits for the reset.`}>
              <input className="field h-7 w-52 px-2 font-mono text-[12px]" value={fallback.value} onChange={(e) => fallback.set(e.target.value)} placeholder="none" spellCheck={false} />
              {models(fallback.value).join(",") !== status.fallback.join(",") && (
                <Button onClick={async () => (await save("fallback", { fallback: models(fallback.value) })) && fallback.clear()} busy={saving === "fallback"}>
                  Save
                </Button>
              )}
            </Row>
          )}
          <Row label="Another model" note={`One the menu doesn't list, as provider:model. On ${host}: ${installed.length ? installed.join(", ") : "…"}.`}>
            <input className="field h-7 w-52 px-2 font-mono text-[12px]" value={other.value} onChange={(e) => other.set(e.target.value)} placeholder={status?.model} spellCheck={false} />
            {other.value.trim() && other.value.trim() !== status?.model && (
              <Button onClick={async () => (await save("model", { model: other.value.trim() })) && other.clear()} busy={saving === "model"}>
                Use
              </Button>
            )}
          </Row>
          <Row
            label={
              <span className="flex items-center gap-2">
                <StateMark state={brain?.ok === false ? "offline" : brain?.ok ? "running" : "online"} />
                {brain?.ok === false ? (brain.reason === "signed_out" ? `Not signed in on ${host}` : brain.message) : brain?.ok ? "Answering" : "Not tried yet"}
              </span>
            }
          >
            {brain?.ok === false && brain.reason === "signed_out" && (
              <Button variant="primary" onClick={onSignIn} icon={<Icon name="terminal" className="size-3.5" />}>
                Sign In on {host}
              </Button>
            )}
            <Button
              busy={checking}
              onClick={async () => {
                setChecking(true);
                await onCheckBrain().finally(() => setChecking(false));
              }}
            >
              Check
            </Button>
          </Row>
        </Group>
      </Section>

      <Section
        title="How midna acts"
        footer={
          status?.mode === "ask"
            ? "midna reads and keeps its records freely, but asks before running commands, changing files or acting for you."
            : `midna has the run of ${host} and acts without asking, judged against your objectives. Everything it does is logged.`
        }
      >
        <Group>
          <Row label="Ask before acting">
            <Switch label="Ask before acting" on={status?.mode === "ask"} disabled={!status || saving === "mode"} onChange={(ask) => void save("mode", { mode: ask ? "ask" : "autonomous" })} />
          </Row>
        </Group>
      </Section>

      <Section title="Time">
        <Group>
          <Row label="Timezone">
            <input className="field h-7 w-52 px-2 text-[12.5px]" value={timezone.value} onChange={(e) => timezone.set(e.target.value)} spellCheck={false} />
            {timezone.value.trim() && timezone.value !== status?.timezone && (
              <Button onClick={async () => (await save("tz", { timezone: timezone.value })) && timezone.clear()} busy={saving === "tz"}>
                Save
              </Button>
            )}
          </Row>
          {status && <QuietHours saved={status.quietHours} drafts={drafts} save={save} />}
        </Group>
      </Section>

      <Section title="Your phone">
        <Group>
          {telegram?.enabled ? (
            <Row
              label={
                <span className="flex items-center gap-2">
                  <StateMark state="running" /> Telegram is connected
                </span>
              }
              note="midna messages you there when you're away from here."
            />
          ) : (
            <div className="px-3 py-2.5">
              <TelegramSetup client={client} drafts={drafts} onDone={() => void client.bridges().then(setBridges)} />
            </div>
          )}
        </Group>
      </Section>

      <Section title="This computer">
        <Group>
          <Row label="Appearance">
            <Segmented
              value={appearance}
              onChange={(a) => {
                setAppearance(a);
                setAppearanceState(a);
              }}
              options={[
                { value: "system", label: "Auto" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </Row>
          {inApp && <NotificationsRow />}
          {inApp && (
            <Row label="Open at login" note="So midna can reach you from the menu bar.">
              <Switch label="Open at login" on={atLogin === true} disabled={atLogin === null} onChange={async (on) => setAtLogin(await launchAtLogin(on))} />
            </Row>
          )}
        </Group>
      </Section>

      <Section title="Where midna lives">
        <Group>
          <Row label={connection.host} note={<span className="selectable">{[connection.url, `midna ${status?.version ?? "…"}`, status?.host.platform].filter(Boolean).join(" · ")}</span>}>
            <Button onClick={onDisconnect}>Use Another Machine…</Button>
          </Row>
        </Group>
      </Section>

      {devices.length > 0 && (
        <Section title="Paired with it">
          <Group>
            {devices.map((d) => (
              <Row
                key={d.id}
                label={
                  <>
                    {d.name}
                    {d.id === connection.device && <span className="text-dim"> (this app)</span>}
                  </>
                }
                note={`${KIND[d.kind] ?? d.kind} · ${d.last_seen_at ? `seen ${new Date(d.last_seen_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "never seen"}`}
              >
                {d.id !== connection.device && d.kind !== "host" && !d.name.endsWith("(host)") && (
                  <Button variant="ghost" onClick={async () => setDevices(await client.revokeDevice(d.id).then(() => client.devices()))}>
                    Unpair
                  </Button>
                )}
              </Row>
            ))}
          </Group>
        </Section>
      )}
    </div>
  );
}

/** Whether midna's notifications reach the user here, a way to turn them on, and one to try. */
function NotificationsRow() {
  const [asked, setAsked] = useState(false);
  const { notifications, refresh } = useNotifications(asked);
  const [tried, setTried] = useState<string | null>(null);
  if (!notifications) return null;
  const on = notifications.state === "on";
  const test = async () => {
    setTried(null);
    await testNotification().then(
      () => setTried("Sent. Nothing came? This computer may be in a Focus, or midna is set to no banners in System Settings."),
      (err: unknown) => setTried(`macOS didn't take it: ${String(err)}`),
    );
    refresh();
  };
  return (
    <Row label="Notifications" note={tried ?? notifications.problem ?? (on ? "Replies and alerts, with a sound and a Dock badge." : "So you hear when midna replies or needs you.")}>
      <span className="text-[12.5px] text-dim">{on ? "On" : notifications.state === "unknown" ? "Unknown" : "Off"}</span>
      {on ? (
        <Button onClick={() => void test()}>Send a Test</Button>
      ) : (
        <Button
          variant="primary"
          onClick={() => {
            setAsked(true);
            void enableNotifications();
          }}
        >
          Turn On
        </Button>
      )}
    </Row>
  );
}

function QuietHours({ saved, drafts, save }: { saved: Status["quietHours"]; drafts: string; save: Save }) {
  const [on, setOn] = useState(saved !== null);
  const start = useDraft(`${drafts}:quiet-start`, saved?.start ?? "23:00");
  const end = useDraft(`${drafts}:quiet-end`, saved?.end ?? "08:00");
  const commit = async (next: { on: boolean; start: string; end: string }) => {
    if (!(await save("quiet", { quietHours: next.on ? { start: next.start, end: next.end } : null }))) return;
    if (next.on) {
      start.clear();
      end.clear();
    }
  };
  return (
    <Row label="Quiet hours" note="What can wait is held until they end.">
      {on && (
        <>
          <input type="time" aria-label="From" className="field h-7 px-1.5 text-[12.5px]" value={start.value} onChange={(e) => start.set(e.target.value)} onBlur={() => void commit({ on, start: start.value, end: end.value })} />
          <span className="text-dim">to</span>
          <input type="time" aria-label="To" className="field h-7 px-1.5 text-[12.5px]" value={end.value} onChange={(e) => end.set(e.target.value)} onBlur={() => void commit({ on, start: start.value, end: end.value })} />
        </>
      )}
      <Switch
        label="Quiet hours"
        on={on}
        onChange={(v) => {
          setOn(v);
          void commit({ on: v, start: start.value, end: end.value });
        }}
      />
    </Row>
  );
}

function TelegramSetup({ client, drafts, onDone }: { client: MidnaClient; drafts: string; onDone: () => void }) {
  const [token, setToken] = useSecretDraft(`${drafts}:telegram-token`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BridgeSetupResult | null>(null);
  const [copied, setCopied] = useState(false);

  if (result) {
    return (
      <div className="rise">
        <p className="text-[13px]">{result.instructions}</p>
        <div className="mt-3 flex items-center gap-2">
          <code className="selectable rounded-[7px] bg-control px-2.5 py-1 font-mono text-[13px]">{result.code}</code>
          <Button
            onClick={async () => {
              await copy(result.code!);
              setCopied(true);
            }}
            icon={<Icon name={copied ? "check" : "copy"} className="size-3.5" />}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          {result.link && (
            <Button variant="primary" onClick={() => void openUrl(result.link!)} icon={<Icon name="external" className="size-3.5" />}>
              Open the Bot
            </Button>
          )}
        </div>
        <Button variant="ghost" className="mt-2 -ml-3" onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }
  return (
    <div>
      <p className="text-[12.5px] text-dim">
        Until midna has its own phone app, it reaches you through a Telegram bot of your own. In Telegram, message{" "}
        <a className="cursor-pointer text-accent" onClick={() => void openUrl("https://t.me/BotFather")}>
          @BotFather
        </a>
        , send <span className="font-mono text-[11.5px]">/newbot</span>, and paste the token it gives you.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input className="field h-7 flex-1 px-2 font-mono text-[12px]" placeholder="123456789:AA…" value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} />
        <Button
          variant="primary"
          busy={busy}
          disabled={!token.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setResult(await client.setupBridge("telegram", { token: token.trim() }));
              setToken("");
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
