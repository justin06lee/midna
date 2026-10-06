/**
 * Single-file `midna` binaries — no runtime to install on the host.
 *
 *   bun run build          # this machine
 *   bun run build:all      # Linux and macOS, x64 and arm64, into dist/
 */
const all = process.argv.includes("--all");
const targets = all ? ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"] : [null];
for (const target of targets) {
  const out = target ? `dist/midna-${target}` : "dist/midna";
  const r = Bun.spawnSync(["bun", "build", "clients/cli/src/main.ts", "--compile", "--minify", ...(target ? [`--target=bun-${target}`] : []), "--outfile", out], { stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
  console.log(`built ${out}`);
}
