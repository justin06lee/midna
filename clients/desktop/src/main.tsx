import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./style.css";
import { App } from "./App";
import { applyAppearance, loadAppearance } from "./appearance";
import { HANDS_POLICY } from "@midna/protocol";
import { setHandsDefaults } from "./host";
import { Pill } from "./Pill";

// Before the first paint, so the window never flashes the wrong way. The
// browser preview can force one: ?dark=1 or ?light=1.
const q = new URLSearchParams(location.search);
applyAppearance(q.has("dark") ? "dark" : q.has("light") ? "light" : loadAppearance());

// A file dropped anywhere the chat doesn't take it would replace the page
// with itself: refuse it there (the chat's own handlers run first).
window.addEventListener("dragover", (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
});
window.addEventListener("drop", (e) => e.preventDefault());

// The same page is the pill shown over the screen while midna works it: a transparent window of its own.
const pill = location.hash === "#pill";
if (pill) document.documentElement.classList.add("pill");
else void setHandsDefaults(HANDS_POLICY.defaults);

createRoot(document.getElementById("root")!).render(<StrictMode>{pill ? <Pill /> : <App />}</StrictMode>);
