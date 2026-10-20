import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "@midna/daemon";

/** `midna event`, exactly as ruri runs it, against a daemon with a stand-in brain. */

// Each test starts the real CLI a few times, and a cold start takes a second or two.
const SPAWNS = 30_000;

const prompts: string[] = [];
let home: string;
let daemon: RunningDaemon;
let env: Record<string, string>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "midna-cli-event-"));
  daemon = await startDaemon({
    home,
    port: 17000 + Math.floor(Math.random() * 20000),
    tickMs: 50,
    introDelayMs: -1,
    brain: async (run) => {
      prompts.push(run.prompt);
      return { text: "ok" };
    },
  });
  env = { ...(process.env as Record<string, string>), MIDNA_URL: daemon.url, MIDNA_TOKEN: readFileSync(join(home, "host.token"), "utf8").trim() };
});

afterAll(async () => {
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
});

async function midna(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), ...args], { env, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out.trim(), err: err.trim() };
}

const idle = {
  id: "evt-42",
  source: "ruri",
  kind: "project.idle",
  project: { id: "p-umi", name: "umi", path: "/work/umi" },
  chats: [{ id: "c1", name: "Lead", role: "lead", lastSummary: "Shipped the onboarding flow" }],
  costUsd: 3.5,
  at: "2026-10-19T22:00:00Z",
};

describe("midna event", () => {
  test("the event's JSON on stdin: midna hears it in the background, and the receipt prints as JSON", async () => {
    const r = await midna(["event", "--source", "ruri", "--title", "umi went idle", "--json", "-"], JSON.stringify(idle));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, status: "queued" });
    for (const end = Date.now() + 5_000; !prompts.length && Date.now() < end; ) await Bun.sleep(20);
    expect(prompts[0]).toContain("umi went idle (project.idle)");
    expect(prompts[0]).toContain("Shipped the onboarding flow");
    // Its id is the one in the JSON: sending it again is a duplicate.
    const again = await midna(["event", "--source", "ruri", "--title", "umi went idle", "--json", "-"], JSON.stringify(idle));
    expect(JSON.parse(again.out)).toMatchObject({ ok: true, status: "duplicate" });
  }, SPAWNS);

  test("from a file, or with no JSON at all", async () => {
    const file = join(home, "event.json");
    writeFileSync(file, JSON.stringify({ ...idle, id: "evt-43", project: { id: "p-una", name: "una", path: "/work/una" } }));
    expect(JSON.parse((await midna(["event", "--source", "ruri", "--title", "una went idle", "--json", file])).out)).toMatchObject({ status: "queued" });
    const plain = await midna(["event", "--source", "ci", "--title", "nightly build passed"]);
    expect(plain.code).toBe(0);
    expect(plain.out).toMatch(/^midna hears it/);
  }, SPAWNS);

  test("usage and bad input are refused", async () => {
    expect((await midna(["event", "--title", "no source"])).code).toBe(1);
    expect((await midna(["event", "--source", "ruri"])).code).toBe(1);
    const bad = await midna(["event", "--source", "ruri", "--title", "x", "--json", "-"], "{not json");
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out)).toMatchObject({ ok: false });
    expect((await midna(["event", "--source", "ruri", "--title", "x", "--json", join(home, "missing.json")])).code).toBe(1);
  }, SPAWNS);
});
