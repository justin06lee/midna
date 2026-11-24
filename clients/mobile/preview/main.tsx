import { createRoot } from "react-dom/client";
import { Main } from "@phone/screens/Main";

// One phone screen, paired with the throwaway midna (`bun run preview` in the repo prints the link's connect value).
// ?open=today|vault|settings|approvals|model picks what it shows; ?scheme=dark|light its appearance.
// The app's typeface, which the iPhone build embeds (app.json): here, three faces of one family.
const faces = { 400: new URL("../assets/fonts/SpaceGrotesk-Regular.ttf", import.meta.url).href, 500: new URL("../assets/fonts/SpaceGrotesk-Medium.ttf", import.meta.url).href, 700: new URL("../assets/fonts/SpaceGrotesk-Bold.ttf", import.meta.url).href };
document.head.append(Object.assign(document.createElement("style"), { textContent: Object.entries(faces).map(([w, url]) => `@font-face{font-family:"Space Grotesk";font-weight:${w};src:url(${url})}`).join("") }));

const q = new URLSearchParams(location.search);
const c = JSON.parse(atob(q.get("connect")!)) as { url: string; token: string; device: string; name: string };
createRoot(document.getElementById("root")!).render(<Main connection={c} onPairAgain={() => {}} onUnpaired={() => {}} />);

// react-native-web presses on mouse down and up, not on a bare click().
const tap = (id: string) => {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  for (const type of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0, view: window }));
};
const open = q.get("open");
setTimeout(() => {
  // The model's sheet opens from Settings; in the composer it is the system's menu, which a browser has none of.
  if (open === "model") (tap("open-settings"), setTimeout(() => tap("settings-model"), 600));
  else if (open === "settings" || open === "approvals") tap(`open-${open}`);
  else if (open) tap(`tab-${open}`);
}, 1500);
