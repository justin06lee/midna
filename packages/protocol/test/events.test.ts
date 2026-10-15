import { afterAll, expect, test } from "bun:test";
import { MidnaClient, type StreamEvent } from "../src/index.ts";

// A stand-in daemon: one event, then either keepalives or silence, counting
// the streams that are still open.
let open = 0;
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const quiet = new URL(req.url).searchParams.get("since") === "1";
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        open++;
        const enc = new TextEncoder();
        c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "status", conversationId: null, state: "idle" })}\n\n`));
        if (!quiet) timer = setInterval(() => c.enqueue(enc.encode(": keepalive\n\n")), 20);
      },
      cancel() {
        open--;
        clearInterval(timer);
      },
    });
    req.signal.addEventListener("abort", () => clearInterval(timer));
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});
afterAll(() => server.stop(true));

const client = new MidnaClient(`http://localhost:${server.port}`, "t");
const settle = async () => {
  for (let i = 0; i < 50 && open > 0; i++) await Bun.sleep(10);
};

test("leaving the loop closes the connection", async () => {
  const seen: StreamEvent[] = [];
  for await (const e of client.events(0)) {
    seen.push(e);
    break;
  }
  expect(seen).toEqual([{ type: "status", conversationId: null, state: "idle" }]);
  await settle();
  expect(open).toBe(0);
});

test("keepalives keep a stream alive", async () => {
  const abort = new AbortController();
  const done = (async () => {
    for await (const _ of client.events(0, abort.signal, 100)) {
      /* the one event */
    }
  })().catch((err: Error) => err);
  await Bun.sleep(300);
  expect(open).toBe(1);
  abort.abort();
  expect(await done).toBeInstanceOf(Error);
  await settle();
  expect(open).toBe(0);
});

test("a stream that goes silent is closed and reported", async () => {
  const err = await (async () => {
    for await (const _ of client.events(1, undefined, 100)) {
      /* the one event */
    }
  })().catch((e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("nothing from midna");
  await settle();
  expect(open).toBe(0);
});
