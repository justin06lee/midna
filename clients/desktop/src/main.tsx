import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./style.css";
import { App } from "./App";

// The browser preview can force an appearance: ?dark=1 or ?light=1.
const q = new URLSearchParams(location.search);
if (q.has("dark")) document.documentElement.classList.add("dark");
if (q.has("light")) document.documentElement.classList.add("light");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
