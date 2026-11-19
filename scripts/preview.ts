import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Brain, BrainRun } from "@midna/agent";
import { startDaemon } from "@midna/daemon";
import { MidnaClient, type Connection } from "@midna/protocol";

/**
 * A throwaway midna to look at the interface against: its own home in a
 * temp folder, a stand-in brain that never spends a token, and a
 * conversation, a day and some objectives already in it. Prints a link that
 * opens the dev server's preview (`bun run dev`) connected to it:
 *
 *   bun run preview                   # then open the link it prints
 *
 * Nothing here touches the real midna. Ctrl-C stops it and removes its home.
 */

const PORT = Number(process.env.PREVIEW_PORT ?? 17719);
const SITE = process.env.PREVIEW_SITE ?? "http://localhost:5190";

const REPLY = `Here's where the week stands.

**Done** — the alarm work shipped, and Monday's 04:30 alarm is on your phone.

**Still open**
- Build 8 from the Air: \`make testflight\`
- The Family Controls request (Huiyun has to send it)
- Reading: *Justice*, chapter 4

| Day | Focus | Hours |
| --- | --- | --- |
| Sat | caveira prep | 3 |
| Sun | reading, early night | 2 |

\`\`\`sh
git pull && make update
\`\`\`

The long path wraps instead of pushing the window sideways: /Users/justin/code/github.com/justin06lee/midna/clients/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos`;

async function tools(run: BrainRun): Promise<Client> {
  const client = new Client({ name: "preview-brain", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(run.mcp.url), { requestInit: { headers: { authorization: `Bearer ${run.mcp.token}` } } }));
  return client;
}

let turn = 0;
/** What midna does and says each turn, in the order the seeded messages come. */
async function act(run: BrainRun, call: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<string> {
  if (run.prompt.includes("First run")) {
    await call("message_user", { text: "Hi, I'm midna. Tell me what you're aiming for this year, and what's on your plate this week." });
    return "introduced";
  }
  turn++;
  if (turn === 1) {
    await call("goal_save", { title: "Ship midna to the people around me", horizon: "year", why: "It should carry the day for more than one person.", success: "Five people use it daily." });
    await call("goal_save", { title: "Read one serious book a month", horizon: "quarter", why: "The hours lost to scrolling go here instead." });
    await call("goal_save", { title: "Wake at 04:30 on weekdays", horizon: "month" });
    await call("task_save", { title: "Build 8 to TestFlight from the Air", priority: 1, due: "today 18:00", estimate_min: 30 });
    await call("task_save", { title: "Read Justice, chapter 4", priority: 2, estimate_min: 45 });
    await call("task_save", { title: "Draft the caveira agenda", priority: 2, owner: "midna", status: "doing" });
    await call("event_save", { title: "caveira team call", start: "tomorrow 05:00", end: "tomorrow 06:00", location: "Zoom" });
    await call("event_save", { title: "Dinner with Huiyun", start: "today 19:00", location: "Seongsu" });
    return "Noted. I've put those down as objectives, with this week's tasks under them.";
  }
  if (turn === 2) return REPLY;
  if (turn === 3) {
    await call("ask_user", { question: "Want me to hold Instagram and YouTube until the reading is done?", options: ["Yes, hold them", "Just tonight", "No"] });
    return "";
  }
  await Bun.sleep(Number(process.env.PREVIEW_THINK_MS ?? 400));
  // Says what it was asked to think with, so a change of model can be seen to hold from the next turn.
  return `Okay. (This turn ran as ${run.model}${run.account ? ` on the ${run.account} account` : ""}.)`;
}

const brain: Brain = async (run) => {
  const t = await tools(run);
  try {
    const text = await act(run, (name, args) => t.callTool({ name, arguments: args }));
    return { text, sessionId: `preview-${turn}`, sessionCostUsd: 0.02 * (turn + 1) };
  } finally {
    run.inbox?.close();
    await t.close();
  }
};

const home = mkdtempSync(join(tmpdir(), "midna-preview-"));
const daemon = await startDaemon({ home, port: PORT, brain, tickMs: 200, introDelayMs: 50, coalesceMs: 100, https: null, vault: null });
daemon.store.updateSettings({ quietHours: null });
const host = new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim());

const wait = async (what: string, ok: () => Promise<boolean>) => {
  for (const end = Date.now() + 15_000; Date.now() < end; await Bun.sleep(100)) if (await ok()) return;
  throw new Error(`preview: timed out waiting for ${what}`);
};
const settled = async (n: number) => wait(`reply ${n}`, async () => !(await host.status()).busy && (await host.history()).filter((h) => h.role === "midna").length >= n);

await settled(1);
const said = ["This year: get midna into other people's hands. This week: build 8, the caveira call on Monday, and I want to actually read.", "Where does the week stand?", "I keep losing the evening to my phone."];
for (const [i, text] of said.entries()) {
  await host.send({ text, client: "desktop" });
  await settled(i + 2);
}

const { code } = await host.pairingCode();
const paired = await host.pair({ code, deviceName: "Preview", kind: "desktop" });
const connection: Connection = { url: daemon.url, token: paired.token, name: "midna", host: "preview", ssh: null, device: paired.deviceId };
const link = `${SITE}/?connect=${encodeURIComponent(btoa(JSON.stringify(connection)))}`;
writeFileSync(join(home, "connection.json"), JSON.stringify(connection));
console.log(`preview midna at ${daemon.url} (home ${home})`);
console.log(`open ${link}`);

const stop = async () => {
  await daemon.stop().catch(() => {});
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
