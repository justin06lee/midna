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

test("a fetch passed in carries every call, the event stream included", async () => {
  const urls: string[] = [];
  // Unbound on purpose: MidnaClient must not call it as a method of itself.
  const counting = function (this: unknown, url: string, init?: RequestInit) {
    expect(this).toBeUndefined();
    const path = new URL(url).pathname;
    urls.push(path);
    // The stand-in daemon answers everything with a stream; only the event stream goes to it.
    return path === "/v1/events" ? fetch(url, init) : Promise.resolve(Response.json({ ok: true, service: "midna", version: "0", name: "midna" }));
  };
  const viaOwn = new MidnaClient(`http://localhost:${server.port}`, "t", { fetch: counting });
  for await (const e of viaOwn.events(0)) {
    expect(e.type).toBe("status");
    break;
  }
  expect((await viaOwn.health()).ok).toBe(true);
  await viaOwn.attachment("att_x");
  expect(urls).toEqual(["/v1/events", "/healthz", "/v1/attachments/att_x"]);
  await settle();
});

test("a request on a connection that never answers gives up, and a caller can stop one", async () => {
  // A fetch that never settles unless aborted: what a request looks like on a connection that died under it.
  const hang = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))) as never;
  const client = new MidnaClient("http://midna.test", "t", { fetch: hang });
  const started = Date.now();
  const err = await (client as unknown as { call: (m: string, p: string, b?: unknown, s?: AbortSignal, r?: unknown, t?: number) => Promise<unknown> })
    .call("GET", "/v1/status", undefined, undefined, undefined, 200)
    .catch((e) => e);
  expect((err as Error).message).toBe("midna didn't answer in 0 s");
  expect(Date.now() - started).toBeLessThan(2_000);

  const ctl = new AbortController();
  const stopped = client.status(ctl.signal).catch((e) => e);
  ctl.abort();
  expect(((await stopped) as Error).message).toBe("aborted");
});
