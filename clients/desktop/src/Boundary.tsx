import { Component, type ReactNode } from "react";
import { Button, Mark } from "./ui";

/** Whatever goes wrong while drawing, the window says so and offers a way back — never a blank. */
export class Boundary extends Component<{ children: ReactNode; onReset?: () => void }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error("[midna] the window hit an error:", error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <Mark className="mb-3 size-8 text-dimmer" />
        <p className="text-[14px] font-medium">Something in this window broke.</p>
        <p className="selectable mt-1 max-w-[440px] font-mono text-[11.5px] text-dim">{this.state.error.message}</p>
        <div className="mt-4 flex gap-2">
          <Button variant="primary" onClick={() => location.reload()}>
            Reload
          </Button>
          {this.props.onReset && (
            <Button
              onClick={() => {
                this.setState({ error: null });
                this.props.onReset!();
              }}
            >
              Pick another machine
            </Button>
          )}
        </div>
      </div>
    );
  }
}
