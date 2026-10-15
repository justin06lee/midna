import { inApp } from "./host";

/**
 * Light, dark, or whatever the system is set to — a choice for this
 * computer, so it lives here rather than on midna. The page follows a class
 * on <html> (style.css); in the app the window itself is themed too, so its
 * title bar and the web view's own controls match.
 */
export type Appearance = "system" | "light" | "dark";

const KEY = "midna.appearance";

export function loadAppearance(): Appearance {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  root.classList.toggle("dark", a === "dark");
  root.classList.toggle("light", a === "light");
  if (inApp)
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(a === "system" ? null : a))
      .catch(() => {});
}

export function setAppearance(a: Appearance): void {
  localStorage.setItem(KEY, a);
  applyAppearance(a);
}
