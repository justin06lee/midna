import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModel, resolveModel } from "../src/brain.ts";
import { hermesBrain, hermesInput, isHermes } from "../src/hermes.ts";

/**
 * The Hermes brain against a stand-in api_server: runs, their SSE events, approvals and stop,
 * as Hermes 0.22's /v1/runs speaks them.
 */

type Run = { id: string; body: Record<string, unknown>; stopped: boolean; approvals: unknown[]; events: (send: (e: object) => void, run: Run) => Promise<void> };
const runs: Run[] = [];
let script: Run["events"] = async (send) => send({ event: "run.completed", output: "hi" });
let server: ReturnType<typeof Bun.serve>;
let dir: string;
const KEY = "test-key";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "midna-hermes-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${KEY}`) return new Response("{}", { status: 401 });
      const url = new URL(req.url);
      const m = /^\/v1\/runs(?:\/([^/]+))?(?:\/(\w+))?$/.exec(url.pathname);
      if (url.pathname === "/v1/capabilities") return Response.json({ ok: true });
      if (!m) return new Response("{}", { status: 404 });
      const [, id, action] = m;
      if (!id && req.method === "POST") {
        const run: Run = { id: `run_${runs.length + 1}`, body: (await req.json()) as Record<string, unknown>, stopped: false, approvals: [], events: script };
        runs.push(run);
        return Response.json({ run_id: run.id, status: "started" }, { status: 202 });
      }
      const run = runs.find((r) => r.id === id);
      if (!run) return new Response("{}", { status: 404 });
      if (action === "events") {
        const stream = new ReadableStream({
          async start(c) {
            const send = (e: object) => c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ run_id: run.id, ...e })}\n\n`));
            c.enqueue(new TextEncoder().encode(": open\n\n"));
            await run.events(send, run);
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (action === "stop") {
        run.stopped = true;
        return Response.json({ status: "stopping" });
      }
      if (action === "approval") {
        run.approvals.push(await req.json());
        return Response.json({ resolved: 1 });
      }
      return Response.json({ run_id: run.id, status: "running", execution_generation: 3, pending_controls: [{ prompt_id: "p1", kind: "approval" }] });
    },
  });
  process.env.MIDNA_HERMES_URL = `http://127.0.0.1:${server.port}`;
  process.env.MIDNA_HERMES_KEY = KEY;
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MIDNA_HERMES_URL;
  delete process.env.MIDNA_HERMES_KEY;
});

const base = { systemPrompt: "", model: "hermes", cwd: "/tmp", mcp: { url: "", token: "" }, mode: "autonomous" as const };

describe("hermes brain", () => {
  test("the model ref", () => {
    expect(isHermes("hermes")).toBe(true);
    expect(isHermes("hermes:anything")).toBe(true);
    expect(isHermes("hermes-agent")).toBe(false);
    expect(resolveModel("hermes")).toEqual({ provider: "hermes" });
    expect(checkModel("hermes")).toBeNull(); // the key is there
  });

  test("a turn: the reply after the last tool call, activity, usage, and the session to resume", async () => {
    script = async (send) => {
      send({ event: "message.delta", delta: "Let me look." });
      send({ event: "tool.started", tool: "mcp_midna_body_device_shell", preview: "pmset -g batt" });
      send({ event: "tool.completed", tool: "mcp_midna_body_device_shell" });
      send({ event: "message.delta", delta: "Battery " });
      send({ event: "message.delta", delta: "70%." });
      send({ event: "run.completed", output: "Battery 70%.", usage: { input_tokens: 100, output_tokens: 5, cache_read_tokens: 80 } });
    };
    const activity: string[] = [];
    const r = await hermesBrain({ ...base, prompt: "battery?", systemPrompt: "from the app", onActivity: (t, d) => activity.push(`${t}: ${d}`) });
    expect(r.text).toBe("Battery 70%.");
    expect(r.sessionId).toMatch(/^midna-/);
    expect(r.usage).toEqual({ input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 });
    expect(activity).toEqual(["device_shell: pmset -g batt"]);
    const sent = runs.at(-1)!.body;
    expect(sent).toEqual({ input: "battery?", session_id: r.sessionId, instructions: "from the app" });

    script = async (send) => send({ event: "run.completed", output: "again" });
    const again = await hermesBrain({ ...base, prompt: "and now?", resume: r.sessionId });
    expect(again.sessionId).toBe(r.sessionId!);
    expect(runs.at(-1)!.body.session_id).toBe(r.sessionId);
  });

  test("an approval goes to the user, and their answer back to the run it waits on", async () => {
    let asked: { summary: string; tool?: string } | undefined;
    script = async (send, run) => {
      send({ event: "approval.request", description: "run `rm -rf build` on the Mac", tool: "mcp_midna_body_device_shell" });
      for (let i = 0; i < 100 && !run.approvals.length; i++) await Bun.sleep(10);
      send({ event: "run.completed", output: "Done." });
    };
    const r = await hermesBrain({ ...base, prompt: "clean it", onApproval: async (a) => ((asked = a), "once") });
    expect(r.text).toBe("Done.");
    expect(asked).toEqual({ summary: "run `rm -rf build` on the Mac", tool: "mcp_midna_body_device_shell" });
    expect(runs.at(-1)!.approvals).toEqual([{ request_id: "p1", execution_generation: 3, choice: "once" }]);
  });

  test("with nobody to ask, an approval is denied", async () => {
    script = async (send, run) => {
      send({ event: "approval.request", command: "sudo reboot" });
      for (let i = 0; i < 100 && !run.approvals.length; i++) await Bun.sleep(10);
      send({ event: "run.completed", output: "Not done." });
    };
    await hermesBrain({ ...base, prompt: "reboot" });
    expect(runs.at(-1)!.approvals).toEqual([{ request_id: "p1", execution_generation: 3, choice: "deny" }]);
  });

  test("an interrupt stops the run; the session survives for the next turn", async () => {
    script = async (send, run) => {
      for (let i = 0; i < 300 && !run.stopped; i++) await Bun.sleep(10);
      send({ event: "run.cancelled" });
    };
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const err = await hermesBrain({ ...base, prompt: "long one", signal: abort.signal }).catch((e) => e);
    expect(String(err.message)).toBe("hermes turn interrupted");
    expect(err.sessionId).toMatch(/^midna-/);
    expect(runs.at(-1)!.stopped).toBe(true);
  });

  test("a failed run is a BrainError; one that ran out of steps still answers", async () => {
    script = async (send) => send({ event: "run.failed", error: "provider down" });
    expect(String((await hermesBrain({ ...base, prompt: "x" }).catch((e) => e)).message)).toBe("hermes turn failed: provider down");
    script = async (send) => send({ event: "run.failed", output: "Here's what I found so far.", turn_exit_reason: "iteration_budget_exhausted" });
    expect((await hermesBrain({ ...base, prompt: "x" })).text).toBe("Here's what I found so far.");
  });

  test("what the user sent: images as images, short text as text, the rest named", () => {
    const png = join(dir, "a.png");
    writeFileSync(png, Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0)));
    const txt = join(dir, "notes.md");
    writeFileSync(txt, "# hi\n");
    const bin = join(dir, "x.zip");
    writeFileSync(bin, new Uint8Array([0, 1, 2, 0]));
    expect(hermesInput("plain")).toBe("plain");
    const input = hermesInput("look", [
      { name: "a.png", mime: "image/png", kind: "image", path: png },
      { name: "notes.md", mime: "text/markdown", kind: "file", path: txt },
      { name: "x.zip", mime: "application/zip", kind: "file", path: bin },
    ]) as Array<{ content: Array<Record<string, string>> }>;
    const [text, image] = input[0]!.content;
    expect(image!.type).toBe("input_image");
    expect(image!.image_url).toStartWith("data:image/png;base64,");
    expect(text!.text).toContain('"a.png": attached as an image.');
    expect(text!.text).toContain('"notes.md" (its text):\n<<<\n# hi\n');
    expect(text!.text).toContain('"x.zip" (application/zip, 4 bytes): kept on midna\'s side only');
  });
});
