import { useCallback, useEffect, useState } from "react";
import { handsStatus, onHands, type HandsStatus } from "./host";

/**
 * midna's hands on this computer, as the app sees them: redrawn whenever a
 * command starts or ends or a choice changes, and — while `watch` is on, as
 * on the screen that shows permissions — checked every two seconds, since
 * a permission granted in System Settings sends no event.
 */
export function useHands(watch = false): { hands: HandsStatus | null; refresh: () => void } {
  const [hands, setHands] = useState<HandsStatus | null>(null);
  const refresh = useCallback(() => void handsStatus().then(setHands, () => {}), []);

  useEffect(() => {
    refresh();
    let off = () => {};
    let gone = false;
    void onHands(refresh).then((f) => (gone ? f() : (off = f)));
    return () => {
      gone = true;
      off();
    };
  }, [refresh]);

  useEffect(() => {
    if (!watch) return;
    const t = setInterval(refresh, 2000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", refresh);
    };
  }, [watch, refresh]);

  return { hands, refresh };
}
