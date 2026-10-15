/**
 * midna's mark — Midna's helmet as a flat black silhouette — drawn as SVG
 * and rasterised into the app icon set and the tray icon.
 *
 *   bun run icons
 */
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELMET, HELMET_STROKE } from "../src/helmet";

const dir = join(import.meta.dir, "..", "src-tauri", "icons");
mkdirSync(dir, { recursive: true });

// The helmet, `scale` times its 100-unit grid, centred on (cx, cy).
const helmet = (cx: number, cy: number, scale: number, fill: string) => `
  <g transform="translate(${cx} ${cy}) scale(${scale}) translate(-50 -48.25)">
    <path d="${HELMET}" fill="${fill}" stroke="${fill}" stroke-width="${HELMET_STROKE}" stroke-linejoin="round"/>
  </g>`;

// Black on a pale card, sitting a touch low: the open U makes the top read lighter.
export const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#ececef"/></linearGradient></defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#g)"/>
  <rect x="64.5" y="64.5" width="895" height="895" rx="200" fill="none" stroke="#000000" stroke-opacity="0.08"/>
  ${helmet(512, 524, 6.4, "#0c0c0e")}
</svg>`;

export const trayIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 100 100">
  ${helmet(50, 50, 1.08, "#000000")}
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
// It also writes Windows Store, Android and iOS sets; the bundle uses none of them.
for (const f of readdirSync(dir)) if (/^(Square\d+x\d+Logo|StoreLogo)\.png$|^(android|ios)$/.test(f)) rmSync(join(dir, f), { recursive: true });
console.log(`icons written to ${dir}`);
