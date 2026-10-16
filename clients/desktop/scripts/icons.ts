/**
 * midna's mark — Midna's helmet as a flat black silhouette — drawn as SVG
 * and rasterised into the app icon set and the tray icon, plus the macOS 26
 * icon: an Icon Composer document (icons/midna.icon) compiled into
 * icons/Assets.car, which the bundle carries beside icon.icns.
 *
 *   bun run icons
 */
import { Resvg } from "@resvg/resvg-js";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELMET, HELMET_STROKE } from "../src/helmet";

const dir = join(import.meta.dir, "..", "src-tauri", "icons");
mkdirSync(dir, { recursive: true });

// The helmet, `scale` times its 100-unit grid, centred on (cx, cy).
const helmet = (cx: number, cy: number, scale: number, fill: string) => `
  <g transform="translate(${cx} ${cy}) scale(${scale}) translate(-50 -48.25)">
    <path d="${HELMET}" fill="${fill}" stroke="${fill}" stroke-width="${HELMET_STROKE}" stroke-linejoin="round"/>
  </g>`;

// The helmet on a `size`-wide card at (x, y), sitting a touch low: the open U makes the top read lighter.
const onCard = (x: number, y: number, size: number) => helmet(x + size / 2, y + (size * 115) / 224, size / 140, "#000000");

// Black on a flat white card, for every platform and for macOS before 26.
export const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="64" y="64" width="896" height="896" rx="200" fill="#ffffff"/>
  ${onCard(64, 64, 896)}
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

// macOS 26 gives an app without an Assets.car icon the legacy treatment: it
// lightens and shades the .icns. The Icon Composer document fills the whole
// 1024pt canvas (the system cuts the shape and sets the margin) and turns the
// glass off, so the helmet stays flat black on white; the dark, clear and
// tinted icon styles draw it white.
const white = "srgb:1.00000,1.00000,1.00000,1.00000";
const doc = join(dir, "midna.icon");
rmSync(doc, { recursive: true, force: true });
mkdirSync(join(doc, "Assets"), { recursive: true });
writeFileSync(join(doc, "Assets", "helmet.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${onCard(0, 0, 1024)}
</svg>
`);
writeFileSync(join(doc, "icon.json"), `${JSON.stringify({
  "fill-specializations": [
    { value: { solid: white } },
    { appearance: "dark", value: { solid: "srgb:0.07059,0.07059,0.07843,1.00000" } },
  ],
  groups: [
    {
      layers: [
        {
          "fill-specializations": [{ appearance: "dark", value: { solid: white } }, { appearance: "tinted", value: { solid: white } }],
          glass: false,
          "image-name": "helmet.svg",
          name: "helmet",
        },
      ],
      shadow: { kind: "none", opacity: 0.5 },
      specular: false,
      translucency: { enabled: false, value: 0.5 },
    },
  ],
  "supported-platforms": { squares: ["macOS"] },
}, null, 2)}\n`);

// actool comes with Xcode, not the command line tools, and xcrun won't reach
// it until Xcode is selected and its licence accepted; run it directly.
const xcodes = Bun.spawnSync(["mdfind", "kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'"]).stdout.toString().split("\n").filter(Boolean);
const developer = [process.env.DEVELOPER_DIR, Bun.spawnSync(["xcode-select", "-p"]).stdout.toString().trim(), ...xcodes.map((x) => join(x, "Contents", "Developer"))]
  .find((d) => d && existsSync(join(d, "usr", "bin", "actool")));
if (!developer) {
  console.warn("Assets.car not rebuilt: it needs Xcode 26's actool. macOS 26 will show the old one until it is.");
} else {
  const out = mkdtempSync(join(tmpdir(), "midna-icon-"));
  const actool = Bun.spawnSync([
    join(developer, "usr", "bin", "actool"), doc, "--compile", out,
    "--output-format", "human-readable-text", "--notices", "--warnings",
    "--output-partial-info-plist", join(out, "partial.plist"),
    "--app-icon", "midna", "--include-all-app-icons", "--enable-on-demand-resources", "NO",
    "--development-region", "en", "--target-device", "mac", "--minimum-deployment-target", "26.0", "--platform", "macosx",
  ], { env: { ...process.env, DEVELOPER_DIR: developer }, stdout: "pipe", stderr: "pipe" });
  if (actool.exitCode !== 0 || !existsSync(join(out, "Assets.car"))) {
    console.error(actool.stdout.toString(), actool.stderr.toString());
    process.exit(1);
  }
  cpSync(join(out, "Assets.car"), join(dir, "Assets.car"));
  rmSync(out, { recursive: true });
}
console.log(`icons written to ${dir}`);
