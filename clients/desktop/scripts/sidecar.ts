/**
 * Put midna inside the app:
 *   - this platform's `midna` as the sidecar (src-tauri/binaries/midna-<triple>) — what the
 *     app runs to find machines and set them up, and what it installs on a machine like this one;
 *   - gzipped builds for other platforms as kits (src-tauri/kits/), for installing midna on a
 *     machine unlike this one. Linux by default, since that's where always-on hosts live;
 *     MIDNA_KITS_FOR="linux-x64,darwin-arm64,…" chooses.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = join(import.meta.dir, "..", "..", "..");
const tauri = join(import.meta.dir, "..", "src-tauri");
const triple = /host: (\S+)/.exec(Bun.spawnSync(["rustc", "-vV"]).stdout.toString())?.[1];
if (!triple) throw new Error("rustc not found — the desktop app needs a Rust toolchain to build");

function build(target: string | null, out: string): void {
  const r = Bun.spawnSync(
    ["bun", "build", join(root, "clients/cli/src/main.ts"), "--compile", "--minify", ...(target ? [`--target=bun-${target}`] : []), "--outfile", out],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
}

mkdirSync(join(tauri, "binaries"), { recursive: true });
const sidecar = join(tauri, "binaries", `midna-${triple}${triple.includes("windows") ? ".exe" : ""}`);
build(null, sidecar);
console.log(`sidecar  ${sidecar}`);

const kitsDir = join(tauri, "kits");
mkdirSync(kitsDir, { recursive: true });
for (const f of readdirSync(kitsDir)) if (f.startsWith("midna-")) rmSync(join(kitsDir, f));
const own = `${process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`;
const wanted = (process.env.MIDNA_KITS_FOR ?? "linux-x64,linux-arm64").split(",").map((s) => s.trim()).filter((p) => p && p !== own);
for (const plat of wanted) {
  const tmp = join(kitsDir, `.midna-${plat}`);
  build(plat, tmp);
  writeFileSync(join(kitsDir, `midna-${plat}.gz`), gzipSync(new Uint8Array(await Bun.file(tmp).arrayBuffer()), { level: 9 }));
  rmSync(tmp);
  console.log(`kit      midna-${plat}.gz`);
}
