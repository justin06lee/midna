import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
// The phone's tab icons: the desktop's own line icons, drawn at 3x as template images (the tab bar tints them).
const icons: Record<string, string> = {
  chat: `<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z"/>`,
  today: `<rect x="3.5" y="4.5" width="13" height="12" rx="2.5"/><path d="M3.5 8.5h13M7 3v3M13 3v3"/>`,
  approvals: `<circle cx="10" cy="10" r="6.75"/><path d="m7 10.3 2.1 2.1 4-4.3"/>`,
  vault: `<circle cx="7" cy="12.5" r="3.25"/><path d="m9.4 10.2 6.1-6.1M13.5 6.1l1.9 1.9M11.6 8l1.4 1.4"/>`,
  settings: `<path d="M4 6h7M14 6h2M4 14h2M9 14h7"/><circle cx="12.5" cy="6" r="1.5"/><circle cx="7.5" cy="14" r="1.5"/>`,
};
for (const [name, body] of Object.entries(icons)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  writeFileSync(`${process.argv[2]}/tab-${name}.png`, new Resvg(svg, { fitTo: { mode: "width", value: 84 } }).render().asPng());
}
