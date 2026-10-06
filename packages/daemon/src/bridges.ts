import type { Subprocess } from "bun";
import type { BridgeConfig } from "./config.ts";

/**
 * Bridges (Telegram today) are separate processes that talk to midna only
 * through its public API, exactly like the desktop app. The daemon merely
 * keeps them running; it knows nothing about what they bridge to.
 */
export class Bridges {
  private procs = new Map<string, { proc: Subprocess; stopping: boolean }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private env: Record<string, string>) {}

  sync(bridges: Record<string, BridgeConfig>): void {
    for (const name of [...this.procs.keys()]) this.stop(name);
    for (const [name, b] of Object.entries(bridges)) if (b.enabled) this.start(name, b, 1_000);
  }

  private start(name: string, b: BridgeConfig, backoff: number): void {
    const startedAt = Date.now();
    const proc = Bun.spawn(b.command, {
      env: { ...process.env, ...this.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const entry = { proc, stopping: false };
    this.procs.set(name, entry);
    void pipe(proc.stdout as ReadableStream<Uint8Array>, (l) => console.log(`[${name}] ${l}`));
    void pipe(proc.stderr as ReadableStream<Uint8Array>, (l) => console.error(`[${name}] ${l}`));
    void proc.exited.then((code) => {
      if (entry.stopping || this.procs.get(name) !== entry) return;
      this.procs.delete(name);
      // A bridge that ran for a while gets a fresh backoff; one that dies at once backs off.
      const next = Date.now() - startedAt > 60_000 ? 1_000 : Math.min(backoff * 2, 60_000);
      console.error(`[midna] bridge ${name} exited (${code}); restarting in ${Math.round(next / 1000)}s`);
      this.timers.set(name, setTimeout(() => this.start(name, b, next), next));
    });
  }

  private stop(name: string): void {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    const e = this.procs.get(name);
    if (!e) return;
    e.stopping = true;
    e.proc.kill();
    this.procs.delete(name);
  }

  stopAll(): void {
    for (const name of [...this.procs.keys(), ...this.timers.keys()]) this.stop(name);
  }

  running(): string[] {
    return [...this.procs.keys()];
  }
}

async function pipe(stream: ReadableStream<Uint8Array>, line: (l: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      line(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  if (buf) line(buf);
}
