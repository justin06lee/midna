import { useCallback, useEffect, useState } from "react";
import type { Connection, DiscoveredDevice, HttpsFound } from "@midna/protocol";
import { clearConnection, inApp, loadConnection, saveConnection, secured, type InstallChoices } from "./host";
import { Boundary } from "./Boundary";
import { dropDraft, loadDraft, saveDraft } from "./drafts";
import { Insecure } from "./screens/Insecure";
import { Install } from "./screens/Install";
import { Main } from "./screens/Main";
import { Welcome } from "./screens/Welcome";
import { Spinner } from "./ui";

type Screen =
  | { at: "loading" }
  | { at: "welcome"; notice?: string }
  | { at: "install"; device: DiscoveredDevice }
  | { at: "main"; connection: Connection }
  | { at: "insecure"; connection: Connection; blocked: Extract<HttpsFound, { url: null }> };

/** The setup choices once changed, until a machine is set up with them. */
const SETUP_DRAFT = "midna.draft:setup";

/**
 * Not connected: pick the machine midna lives on. Picking one sets it up
 * there and pairs this computer. Connected: talk to it.
 */
export function App() {
  const [screen, setScreen] = useState<Screen>({ at: "loading" });
  const [choices, setChoices] = useState<InstallChoices>(() => ({
    model: "claude:opus",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    mode: "autonomous",
    deviceName: "",
    ...loadDraft<Partial<InstallChoices>>(SETUP_DRAFT),
  }));
  const choose = useCallback((c: InstallChoices) => {
    saveDraft(SETUP_DRAFT, c);
    setChoices(c);
  }, []);

  /** Talk to `c`, by HTTPS when it was saved with plain http on the tailnet (the preview, a plain browser tab, can use http). */
  const open = useCallback(async (c: Connection) => {
    const s = inApp ? await secured(c) : { connection: c };
    setScreen("blocked" in s ? { at: "insecure", connection: s.connection, blocked: s.blocked } : { at: "main", connection: s.connection });
  }, []);

  useEffect(() => {
    void loadConnection().then(
      (c) => (c ? open(c) : setScreen({ at: "welcome" })),
      () => setScreen({ at: "welcome" }),
    );
  }, [open]);

  const connected = useCallback(async (c: Connection) => {
    await saveConnection(c);
    dropDraft(SETUP_DRAFT);
    await open(c);
  }, [open]);

  const disconnect = useCallback(async (notice?: string) => {
    await clearConnection();
    setScreen({ at: "welcome", ...(notice ? { notice } : {}) });
  }, []);

  switch (screen.at) {
    case "loading":
      return (
        <div className="flex h-full items-center justify-center text-dim">
          <Spinner />
        </div>
      );
    case "welcome":
      return <Welcome choices={choices} onChoices={choose} notice={screen.notice} onPick={(device) => setScreen({ at: "install", device })} />;
    case "install":
      return <Install device={screen.device} choices={choices} onDone={(c) => void connected(c)} onBack={() => setScreen({ at: "welcome" })} />;
    case "insecure":
      return <Insecure connection={screen.connection} blocked={screen.blocked} onRetry={() => open(screen.connection)} onDisconnect={() => void disconnect()} />;
    case "main":
      return (
        <Boundary onReset={() => void disconnect()}>
          <Main
            connection={screen.connection}
            onDisconnect={() => void disconnect()}
            onUnpaired={() => void disconnect(`This computer was unpaired from midna on ${screen.connection.host}. Connect again to pair it.`)}
          />
        </Boundary>
      );
  }
}
