import { useCallback, useEffect, useState } from "react";
import type { Connection, Overview } from "@midna/protocol";
import { openTerminal } from "../host";
import { Button, Icon, Mark, StateMark } from "../ui";
import { useMidna } from "../useMidna";
import { Chat } from "./Chat";
import { Objectives } from "./Objectives";
import { Settings } from "./Settings";
import { Today } from "./Today";

type View = "chat" | "today" | "goals" | "settings";

const NAV: Array<{ id: View; label: string; icon: "chat" | "today" | "goals" | "settings"; key: string }> = [
  { id: "chat", label: "Chat", icon: "chat", key: "1" },
  { id: "today", label: "Today", icon: "today", key: "2" },
  { id: "goals", label: "Objectives", icon: "goals", key: "3" },
  { id: "settings", label: "Settings", icon: "settings", key: "," },
];

/** Connected: the conversation, the day, the objectives, the settings. */
export function Main({ connection, onDisconnect, onUnpaired }: { connection: Connection; onDisconnect: () => void; onUnpaired: () => void }) {
  const m = useMidna(connection);
  const [view, setView] = useState<View>("chat");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    if (m.link === "unpaired") onUnpaired();
  }, [m.link, onUnpaired]);

  // The dashboards refresh when shown, and whenever midna has just done something.
  useEffect(() => {
    if (view !== "today" && view !== "goals") return;
    void m.client.overview().then(setOverview, () => {});
  }, [view, m.client, m.changed]);

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

  const brain = m.status?.brain;
  const host = m.status?.host.name ?? connection.host;

  return (
    <div className="flex h-full">
      <aside className="flex w-[208px] shrink-0 flex-col border-r border-line">
        <div className="drag h-10 shrink-0" />
        <div className="flex items-center gap-2.5 px-4 pb-4">
          <div className="flex size-8 items-center justify-center rounded-[9px] bg-primary text-primary-ink">
            <Mark className="size-[18px]" />
          </div>
          <div className="min-w-0">
            <div className="text-[14px] leading-tight font-semibold tracking-[-0.01em]">{m.status?.name ?? connection.name}</div>
            <div className="truncate text-[11.5px] text-dim">on {host}</div>
          </div>
        </div>
        <nav className="space-y-0.5 px-2">
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
        <div className="mt-auto space-y-1 px-4 pb-4 text-[11.5px] text-dim">
          <div className="flex items-center gap-1.5">
            <StateMark state={m.link === "live" ? "running" : m.link === "connecting" ? "working" : "offline"} />
            {m.link === "live" ? "connected" : m.link === "connecting" ? "connecting…" : `can't reach ${host}`}
          </div>
          {m.status && (
            <div className="flex items-center gap-1.5">
              <StateMark state={brain?.ok === false ? "offline" : "running"} />
              <span className="truncate">{m.status.model} · {m.status.mode === "autonomous" ? "on its own" : "asks first"}</span>
            </div>
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="drag h-10 shrink-0" />
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
          {view === "chat" && (
            <Chat lines={m.lines} thinking={m.thinking} canSend={m.link === "live"} send={m.send} loadOlder={m.loadOlder} olderExhausted={m.olderExhausted} draft={draft} onDraftUsed={() => setDraft(null)} />
          )}
          {view === "today" && <Today overview={overview} />}
          {view === "goals" && <Objectives overview={overview} onDiscuss={discuss} />}
          {view === "settings" && (
            <Settings client={m.client} status={m.status} connection={connection} onStatus={(s) => m.setStatus(s)} onCheckBrain={checkBrain} onSignIn={signIn} onDisconnect={onDisconnect} />
          )}
        </div>
      </main>
    </div>
  );
}
