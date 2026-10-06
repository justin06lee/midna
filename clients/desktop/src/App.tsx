import { useCallback, useEffect, useState } from "react";
import type { Connection, DiscoveredDevice } from "@midna/protocol";
import { clearConnection, loadConnection, saveConnection, type InstallChoices } from "./host";
import { Boundary } from "./Boundary";
import { Install } from "./screens/Install";
import { Main } from "./screens/Main";
import { Welcome } from "./screens/Welcome";
import { Spinner } from "./ui";

type Screen = { at: "loading" } | { at: "welcome"; notice?: string } | { at: "install"; device: DiscoveredDevice } | { at: "main"; connection: Connection };

/**
 * Not connected: pick the machine midna lives on. Picking one sets it up
 * there and pairs this computer. Connected: talk to it.
 */
export function App() {
  const [screen, setScreen] = useState<Screen>({ at: "loading" });
  const [choices, setChoices] = useState<InstallChoices>({
    model: "claude:opus",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    mode: "autonomous",
    deviceName: "",
  });

  useEffect(() => {
    void loadConnection().then(
      (c) => setScreen(c ? { at: "main", connection: c } : { at: "welcome" }),
      () => setScreen({ at: "welcome" }),
    );
  }, []);

  const connected = useCallback(async (c: Connection) => {
    await saveConnection(c);
    setScreen({ at: "main", connection: c });
  }, []);

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
      return <Welcome choices={choices} onChoices={setChoices} notice={screen.notice} onPick={(device) => setScreen({ at: "install", device })} />;
    case "install":
      return <Install device={screen.device} choices={choices} onDone={(c) => void connected(c)} onBack={() => setScreen({ at: "welcome" })} />;
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
