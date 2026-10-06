/**
 * midna's mark — a crescent, the twilight it's named for — drawn as SVG and
 * rasterised into the app icon set and the tray icon.
 *
 *   bun run icons
 */
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "src-tauri", "icons");
mkdirSync(dir, { recursive: true });

// A crescent: a disc with a second disc bitten out of it, upper right.
const crescent = (cx: number, cy: number, r: number, fill: string) => `
  <mask id="bite"><rect width="100%" height="100%" fill="white"/><circle cx="${cx + r * 0.42}" cy="${cy - r * 0.3}" r="${r * 0.86}" fill="black"/></mask>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" mask="url(#bite)"/>`;

export const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1b1f"/><stop offset="1" stop-color="#0b0b0c"/></linearGradient></defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#g)"/>
  <rect x="64.5" y="64.5" width="895" height="895" rx="200" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>
  ${crescent(500, 532, 268, "#ededf0")}
  <circle cx="700" cy="330" r="22" fill="#ededf0"/>
</svg>`;

export const trayIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">
  ${crescent(21, 23, 15, "#000000")}
  <circle cx="33" cy="11" r="2.4" fill="#000000"/>
</svg>`;

const png = (svg: string, width: number) => new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
writeFileSync(join(dir, "icon-source.svg"), appIcon);
writeFileSync(join(dir, "icon-source.png"), png(appIcon, 1024));
writeFileSync(join(dir, "tray.png"), png(trayIcon, 44));
// The project's own Tauri CLI — `bunx tauri` would fetch an unrelated npm package by that name.
const r = Bun.spawnSync(["bun", "run", "tauri", "icon", join(dir, "icon-source.png"), "-o", dir], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
if (r.exitCode !== 0) {
  console.error(r.stderr.toString());
  process.exit(1);
}
console.log(`icons written to ${dir}`);
