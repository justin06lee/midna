import { useCallback, useEffect, useState } from "react";
import { notificationSetup, type NotificationSetup } from "./host";

/**
 * Whether midna's notifications reach the user on this computer: read when
 * shown and each time the window is looked at again, and — while `watch` is
 * on, as after asking to turn them on — every two seconds, since allowing
 * them in the system's prompt or its settings sends no event. Null in the
 * browser, where the app's notifications don't apply.
 */
export function useNotifications(watch = false): { notifications: NotificationSetup | null; refresh: () => void } {
  const [notifications, setNotifications] = useState<NotificationSetup | null>(null);
  const refresh = useCallback(() => void notificationSetup().then(setNotifications, () => {}), []);

  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  useEffect(() => {
    if (!watch) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [watch, refresh]);

  return { notifications, refresh };
}
