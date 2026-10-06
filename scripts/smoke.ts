/**
 * Live end-to-end check through a real brain (small token cost): a throwaway
 * midna sends one message and must answer using its own tools.
 *
 *   bun run smoke                  # default brain, claude:sonnet
 *   bun run smoke codex            # any yagami model ref
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MidnaClient } from "@midna/protocol";
import { startDaemon, updateHostSettings } from "@midna/daemon";

const model = process.argv[2] ?? "claude:sonnet";
const home = mkdtempSync(join(tmpdir(), "midna-smoke-"));
updateHostSettings({ model, quietHours: null }, home);
const daemon = await startDaemon({ home, port: 17000 + Math.floor(Math.random() * 20000), introDelayMs: 3_600_000 });
const client = new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim());

const abort = new AbortController();
const started = Date.now();
let reply = "";
const done = (async () => {
  for await (const e of client.events(0, abort.signal)) {
    if (e.type === "activity") console.log(`  · ${e.tool}`);
    if (e.type === "outbox" && e.item.kind === "message") {
      reply = e.item.text;
      return;
    }
  }
})();

await client.send({
  text: "Quick setup test: one of my goals this quarter is to ship the first version of you (midna). Record it, and remember that I prefer short messages. Then reply in one sentence.",
  client: "smoke",
});
await Promise.race([done, Bun.sleep(240_000)]);
abort.abort();

const tools = daemon.store.log.actions(0).map((a) => a.tool);
const goals = daemon.store.planning.goals().map((g) => g.title);
const facts = daemon.store.memory.strongest(5).map((f) => f.content);
console.log(`\nbrain:   ${model}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
console.log(`reply:   ${reply || "(none)"}`);
console.log(`tools:   ${tools.join(", ") || "(none)"}`);
console.log(`goals:   ${goals.join(" | ") || "(none)"}`);
console.log(`memory:  ${facts.join(" | ") || "(none)"}`);
await daemon.stop();
rmSync(home, { recursive: true, force: true });
const ok = reply && !reply.startsWith("I couldn't") && tools.includes("goal_save") && tools.includes("remember");
console.log(ok ? "\nsmoke ok" : "\nsmoke FAILED");
process.exit(ok ? 0 : 1);
