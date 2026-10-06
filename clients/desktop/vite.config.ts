import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * The browser preview's stand-in for the app's `midna` command: the same
 * CLI, run from source, its output streamed back line by line. Dev only —
 * the built app runs the binary it carries, through Rust.
 */
function midnaFromSource(): Plugin {
  const cli = join(__dirname, "..", "cli", "src", "main.ts");
  return {
    name: "midna-from-source",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/dev/midna", (req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const args = JSON.parse(body || "[]") as string[];
          const child = spawn("bun", [cli, ...args], { env: { ...process.env, MIDNA_KITS: join(__dirname, "src-tauri", "kits") } });
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          let stderr = "";
          child.stdout.on("data", (d) => res.write(d));
          child.stderr.on("data", (d) => (stderr += d));
          let done = false;
          child.on("close", (code) => {
            done = true;
            res.end(`\n\u0000${JSON.stringify({ code, stderr })}`);
          });
          // The page went away mid-run (a request's own "close" fires once its body is read).
          res.on("close", () => !done && child.kill());
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), midnaFromSource()],
  clearScreen: false,
  server: { port: 5190, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "safari15" },
});
