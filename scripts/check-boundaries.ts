/**
 * The dependency rule that keeps every client deletable: the core never
 * imports a client, and the Telegram bridge — like any future client — sees
 * nothing but the protocol. Checked against real import statements.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ALLOWED: Record<string, string[]> = {
  "packages/protocol": [],
  "packages/core": ["@midna/protocol"],
  "packages/agent": ["@midna/core", "@midna/protocol"],
  "packages/daemon": ["@midna/core", "@midna/agent", "@midna/protocol"],
  "clients/telegram": ["@midna/protocol"],
  "clients/desktop/src": ["@midna/protocol"],
  "clients/cli": ["@midna/protocol", "@midna/daemon", "@midna/telegram"],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules") return [];
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

const root = join(import.meta.dir, "..");
let bad = 0;
for (const [pkg, allowed] of Object.entries(ALLOWED)) {
  for (const file of files(join(root, pkg))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1]!;
      const internal = spec.startsWith("@midna/");
      const escapes = spec.startsWith(".") && !join(file, "..", spec).startsWith(join(root, pkg));
      if ((internal && !allowed.includes(spec)) || escapes) {
        console.error(`${file.slice(root.length + 1)} imports ${spec} — ${pkg} may only use ${allowed.join(", ") || "nothing internal"}`);
        bad++;
      }
    }
  }
}
if (bad) process.exit(1);
console.log("boundaries ok");
