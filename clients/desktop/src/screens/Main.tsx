import { useCallback, useEffect, useState } from "react";
import type { Connection, Overview } from "@midna/protocol";
import { draftKey } from "../drafts";
import { inApp, macTitleBar, openTerminal, setHandsPaused } from "../host";
import { useHands } from "../useHands";
import { Button, Icon, Loading, Mark, Spinner, StateMark } from "../ui";
import { useMidna } from "../useMidna";
import { Chat } from "./Chat";
import { Computer } from "./Computer";
import { Objectives } from "./Objectives";
import { Settings } from "./Settings";
import { Today } from "./Today";
import { Vault } from "./Vault";

type View = "chat" | "today" | "goals" | "vault" | "computer" | "settings";

const NAV: Array<{ id: View; label: string; icon: "chat" | "today" | "goals" | "key" | "computer" | "settings"; key: string }> = [
  { id: "chat", label: "Chat", icon: "chat", key: "1" },
  { id: "today", label: "Today", icon: "today", key: "2" },
  { id: "goals", label: "Objectives", icon: "goals", key: "3" },
  // What midna may do on this computer: only the app can offer that.
  ...(inApp ? [{ id: "computer" as const, label: "This computer", icon: "computer" as const, key: "4" }] : []),
  { id: "vault", label: "Vault", icon: "key", key: "5" },
  { id: "settings", label: "Settings", icon: "settings", key: "," },
];

/** Connected: the conversation, the day, the objectives, the vault, the settings. */
export function Main({ connection, onDisconnect, onUnpaired }: { connection: Connection; onDisconnect: () => void; onUnpaired: () => void }) {
  const m = useMidna(connection);
  const [view, setView] = useState<View>("chat");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewTry, setOverviewTry] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const { hands } = useHands();

  useEffect(() => {
    if (m.link === "unpaired") onUnpaired();
  }, [m.link, onUnpaired]);

  // The dashboards refresh when shown, and whenever midna has just done something.
  // A request that never answers gives up, so the screen can say so rather than spin.
  useEffect(() => {
    if (view !== "today" && view !== "goals") return;
    let live = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    setOverviewError(null);
    m.client
      .overview(abort.signal)
      .then(
        (o) => live && setOverview(o),
        (err: Error) => live && setOverviewError(abort.signal.aborted ? `midna on ${connection.host} didn't answer.` : `Couldn't load this: ${err.message}`),
      )
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [view, m.client, m.changed, overviewTry, connection.host]);

  // ⌘/Ctrl + 1, 2, 3, comma.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const hit = NAV.find((n) => n.key === e.key);
      if (hit) {
        e.preventDefault();
        setView(hit.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const signIn = useCallback(() => {
    const login = (m.status?.brain.loginCommand ?? "claude").split(" ")[0]!;
    void openTerminal(connection.ssh ? ["ssh", "-t", connection.ssh, login] : [login]);
  }, [connection.ssh, m.status?.brain.loginCommand]);

  const checkBrain = useCallback(async () => {
    const brain = await m.client.checkBrain();
    m.setStatus((s) => (s ? { ...s, brain } : s));
  }, [m]);

  const discuss = useCallback((text: string) => {
    setDraft(text);
    setView("chat");
  }, []);

  // Only a link that stays down (or never comes up) is news: a stream that reconnects in a second isn't.
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    if (m.link === "live" || m.link === "unpaired") return setUnreachable(false);
    const t = setTimeout(() => setUnreachable(true), 3_000);
    return () => clearTimeout(t);
  }, [m.link]);

  const brain = m.status?.brain;
  const host = m.status?.host.name ?? connection.host;

  return (
    <div className="flex h-full">
      <aside className="flex w-[208px] shrink-0 flex-col border-r border-line">
        {/* The title bar: midna's mark beside the traffic lights; which machine it's on, in its tooltip. */}
        <div data-tauri-drag-region="deep" title={`${m.status?.name ?? connection.name} on ${host}`} className={`flex h-11 shrink-0 items-center pr-3 ${macTitleBar ? "pl-[92px]" : "pl-4"}`}>
          <Mark className="size-[18px] text-ink" />
        </div>
        <nav className="space-y-0.5 px-2 pt-1.5">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setView(n.id)}
              className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors ${view === n.id ? "bg-active font-medium text-ink" : "text-ink-2 hover:bg-hover"}`}
            >
              <Icon name={n.icon} className="size-[17px]" />
              {n.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div data-tauri-drag-region className="h-11 shrink-0" />
        {unreachable && (
          <div className="rise mx-6 mb-2 flex items-center gap-2.5 rounded-xl border border-line-2 bg-panel px-4 py-2.5 text-[12.5px]">
            <Spinner className="text-dim" />
            <span>
              <span className="font-medium">Can't reach midna on {host}.</span> <span className="text-dim">Trying again…</span>
            </span>
          </div>
        )}
        {hands?.active && !hands.paused && (
          <div className="rise mx-6 mb-2 flex items-center gap-2.5 rounded-xl border border-line-2 bg-panel px-4 py-2.5 text-[12.5px]">
            <StateMark state="working" />
            <span className="flex-1">
              <span className="font-medium">midna is using this computer:</span> <span className="text-dim">{hands.active}</span>
            </span>
            <Button size="sm" onClick={() => void setHandsPaused(true)} icon={<Icon name="pause" className="size-3.5" />}>
              Pause
            </Button>
          </div>
        )}
        {brain?.ok === false && (
          <div className="rise mx-6 mb-2 flex items-center gap-3 rounded-xl border border-line-2 bg-panel px-4 py-2.5">
            <span className="flex-1 text-[12.5px]">
              <span className="font-medium">midna can't think right now.</span>{" "}
              <span className="text-dim">
                {brain.reason === "signed_out" ? `${m.status?.model.split(":")[0]} isn't signed in on ${host}.` : brain.reason === "not_installed" ? `Its brain isn't installed on ${host}: ${brain.installHint}` : brain.message}
              </span>
            </span>
            {brain.reason === "signed_out" && (
              <Button size="sm" variant="primary" onClick={signIn} icon={<Icon name="terminal" className="size-3.5" />}>
                Sign in on {host}
              </Button>
            )}
            <Button size="sm" onClick={() => void checkBrain()}>
              Check again
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Hidden, never unmounted: a half-written message and its uploads wait here. */}
          <div className={view === "chat" ? "h-full" : "hidden"}>
            <Chat
              lines={m.lines}
              thinking={m.thinking}
              canSend={m.link === "live"}
              send={m.send}
              loadOlder={m.loadOlder}
              olderExhausted={m.olderExhausted}
              draft={draft}
              onDraftUsed={() => setDraft(null)}
              loadAttachment={m.loadAttachment}
              upload={m.upload}
              discardUpload={m.discardUpload}
              approvals={m.approvals}
              answerApproval={m.answerApproval}
              shown={view === "chat"}
              draftKey={draftKey(connection)}
            />
          </div>
          {(view === "today" || view === "goals") && !overview && <Loading error={overviewError} onRetry={() => setOverviewTry((n) => n + 1)} />}
          {view === "today" && overview && <Today overview={overview} />}
          {view === "goals" && overview && <Objectives overview={overview} onDiscuss={discuss} />}
          {view === "computer" && <Computer />}
          {view === "vault" && <Vault client={m.client} draftKey={draftKey(connection)} />}
          {view === "settings" && (
            <Settings client={m.client} status={m.status} connection={connection} onStatus={(s) => m.setStatus(s)} onCheckBrain={checkBrain} onSignIn={signIn} onDisconnect={onDisconnect} />
          )}
        </div>
      </main>
    </div>
  );
}
