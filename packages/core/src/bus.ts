import type { StreamEvent } from "@midna/protocol";

type Listener = (event: StreamEvent) => void;

/** In-process fan-out of everything clients should see live. */
export class Bus {
  private listeners = new Set<Listener>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: StreamEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error("[bus] listener failed:", err);
      }
    }
  }
}
