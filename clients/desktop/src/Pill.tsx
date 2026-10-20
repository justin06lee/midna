import { setHandsPaused } from "./host";
import { Icon, Mark } from "./ui";
import { useHands } from "./useHands";

/**
 * The pill at the top of the display while midna looks at or works the
 * screen: what it's doing, and Pause. Its window is kept out of screen
 * captures, so midna never sees it in its own screenshots.
 */
export function Pill() {
  const { hands } = useHands();
  const what = hands?.active ?? "working";
  return (
    <div className="flex h-screen items-center justify-center p-1">
      <div className="flex h-9 max-w-full items-center gap-2 rounded-full border border-line-2 bg-panel pr-1.5 pl-3 text-[12.5px] shadow-[0_6px_20px_-8px_rgba(0,0,0,0.45)]">
        <Mark className="size-3.5 shrink-0" />
        <span className="truncate">midna is {what}</span>
        <button
          type="button"
          className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-primary px-2.5 text-[11.5px] font-medium text-primary-ink"
          onClick={() => void setHandsPaused(true)}
        >
          <Icon name="pause" className="size-3" />
          Pause
        </button>
      </div>
    </div>
  );
}
