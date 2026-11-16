import { useState } from "react";
import type { Connection, HttpsFound } from "@midna/protocol";
import { macTitleBar, openTerminal } from "../host";
import { Button, Icon, Mark } from "../ui";

/**
 * midna is saved at a plain-http tailnet address and has no HTTPS one: this
 * window can't load it, so say what to run on its host instead of retrying.
 */
export function Insecure({ connection, blocked, onRetry, onDisconnect }: { connection: Connection; blocked: Extract<HttpsFound, { url: null }>; onRetry: () => Promise<void>; onDisconnect: () => void }) {
  const [busy, setBusy] = useState(false);
  const host = connection.host;
  const retry = async () => {
    setBusy(true);
    await onRetry().finally(() => setBusy(false));
  };
  return (
    <div className="flex h-full flex-col">
      <div data-tauri-drag-region className={`h-11 shrink-0 ${macTitleBar ? "pl-[92px]" : ""}`} />
      <div className="flex flex-1 justify-center overflow-y-auto px-8 pb-10">
        <div className="w-full max-w-[520px] pt-8">
          <div className="mb-6 flex items-center gap-3.5">
            <div className="flex size-11 items-center justify-center rounded-[12px] bg-primary text-primary-ink">
              <Mark className="size-6" />
            </div>
            <div>
              <h1 className="text-[19px] font-semibold tracking-[-0.015em]">midna on {host} needs an HTTPS address</h1>
              <p className="selectable text-[12.5px] text-dim">{connection.url}</p>
            </div>
          </div>
          <div className="rise rounded-xl border border-line-2 bg-panel px-4 py-3.5">
            <p className="text-[13.5px] font-medium">This app's window can't use plain http on the tailnet, and midna has no HTTPS address there.</p>
            <p className="selectable mt-1 text-[12.5px] text-dim">
              {blocked.message} Run <code className="font-mono">{blocked.command}</code> on {host} (HTTPS certificates must be on for the tailnet), then try again.
            </p>
            <div className="mt-3 flex gap-2">
              <Button variant="primary" onClick={() => void openTerminal(connection.ssh ? ["ssh", "-t", connection.ssh, blocked.command] : ["sh", "-c", blocked.command])} icon={<Icon name="terminal" className="size-3.5" />}>
                Run it on {host}
              </Button>
              <Button onClick={() => void retry()} busy={busy}>
                Try again
              </Button>
              <Button variant="ghost" onClick={onDisconnect}>
                Use another machine
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
