import { createRoot } from "react-dom/client";
import { Main } from "@phone/screens/Main";

// One phone screen, paired with the throwaway midna (`bun run preview` in the repo prints the link's connect value).
// ?open=settings|vault|approvals|model picks what it shows; ?scheme=dark|light its appearance.
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
  if (open === "model") tap("header-model");
  else if (open) tap(`tab-${open}`);
}, 1500);
