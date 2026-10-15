import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./style.css";
import { App } from "./App";
import { applyAppearance, loadAppearance } from "./appearance";

// Before the first paint, so the window never flashes the wrong way. The
// browser preview can force one: ?dark=1 or ?light=1.
const q = new URLSearchParams(location.search);
applyAppearance(q.has("dark") ? "dark" : q.has("light") ? "light" : loadAppearance());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
