import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import { arch, hostname, platform } from "node:os";
import { HOUR, MAIN, DAY, fmt, type Device, type Store } from "@midna/core";
import { QUEUE_PREFIX, checkModel, handleMcp, installedBrains, type Assistant, type JobsHandle } from "@midna/agent";
import {
  AnswerApproval,
  HandsHello,
  HandsResult,
  HandsStateUpdate,
  MAX_ATTACHMENT_BYTES,
  MAX_EVENT_DATA_BYTES,
  PairRequest,
  SendEvent,
  SendMessage,
  SettingsPatch,
  SERVICE,
  type BridgeInfo,
  type BridgeSetupResult,
  type HandsStreamEvent,
  type Health,
  type MessageReceipt,
  type PairResponse,
  type StreamEvent,
  type Status,
} from "@midna/protocol";
import { answerIn } from "./approvals.ts";
import type { HandsHub } from "./hands.ts";
import { VERSION } from "./version.ts";

export interface ServerDeps {
  store: Store;
  assistant: Assistant;
  /** Per-run secret that opens /mcp — only midna's own brain sessions hold it. */
  mcpToken: string;
  /** Re-read config and restart bridges. */
  reloadBridges: () => void;
  bridges: () => BridgeInfo[];
  /** Connect a bridge by name; throws with a message the user can act on. */
  setupBridge: (name: string, input: Record<string, string>) => Promise<BridgeSetupResult>;
  onSettingsChanged: (changed: SettingsPatch) => void;
  /** The user's computers that offer midna their hands. */
  hands: HandsHub;
  /** Long work midna runs detached from its turns. */
  jobs?: JobsHandle;
  /** midna's working directory, where its tools put files for the brain. */
  workspace: string;
}

type Env = { Variables: { device: Device } };

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bearer = (c: Context) => c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";

/** A request body, read no further than `max` bytes: null when it is longer (a chunked upload has no length to check first). */
async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export function createApp(deps: ServerDeps): Hono<Env> {
  const { store, assistant } = deps;
  const app = new Hono<Env>();

  app.onError((err, c) => {
    console.error("[midna] request failed:", err);
    return c.json({ error: err.message }, 500);
  });

  // The desktop app's web view calls from its own origin. Auth is a bearer
  // token, never a cookie, so allowing any origin hands nothing to a page
  // that doesn't already hold a token.
  const crossOrigin = cors({ origin: (o) => o || "*", allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PATCH", "DELETE"], maxAge: 600 });
  app.use("/healthz", crossOrigin);
  app.use("/v1/*", crossOrigin);

  // ── open: liveness and pairing ───────────────────────────────────────
  app.get("/healthz", (c) => c.json<Health>({ ok: true, service: SERVICE, version: VERSION, name: store.settings().name }));

  app.post("/v1/pair", async (c) => {
    const req = PairRequest.safeParse(await c.req.json().catch(() => null));
    if (!req.success) return c.json({ error: "code, deviceName and kind are required" }, 400);
    const paired = store.devices.pair(req.data.code, req.data.deviceName, req.data.kind, Date.now(), req.data.replaces);
    if (!paired) return c.json({ error: "that pairing code is wrong or expired" }, 403);
    if (paired.replaced) deps.hands.disconnect(paired.replaced);
    console.log(`[midna] paired ${req.data.kind} "${req.data.deviceName}" (${paired.device.id})${paired.replaced ? `, retiring ${paired.replaced}` : ""}`);
    return c.json<PairResponse>({ deviceId: paired.device.id, token: paired.token, name: store.settings().name, daemonKey: deps.hands.publicKey, replaced: paired.replaced });
  });

  // ── midna's own tools, for its brain sessions only ───────────────────
  app.all("/mcp/:episode", async (c) => {
    if (!safeEqual(bearer(c), deps.mcpToken)) return c.json({ error: "unauthorized" }, 401);
    const episodeId = Number(c.req.param("episode"));
    if (!store.log.episodeExists(episodeId)) return c.json({ error: "unknown episode" }, 404);
    const episode = store.db.query("SELECT kind, conversation_id FROM episodes WHERE id = $id").get({ id: episodeId }) as { kind: "chat" | "wakeup"; conversation_id: string | null };
    return handleMcp(c.req.raw, { store, episodeId, episodeKind: episode.kind, conversationId: episode.conversation_id ?? MAIN, hands: deps.hands, ...(deps.jobs ? { jobs: deps.jobs } : {}), signal: c.req.raw.signal, workspace: deps.workspace });
  });

  // ── everything else needs a paired device ────────────────────────────
  app.use("/v1/*", async (c, next) => {
    const device = store.devices.authenticate(bearer(c));
    if (!device) return c.json({ error: "unauthorized — pair this device first" }, 401);
    c.set("device", device);
    await next();
  });

  const status = (): Status => {
    const s = store.settings();
    return {
      version: VERSION,
      name: s.name,
      mode: s.mode,
      model: s.model,
      timezone: s.timezone,
      quietHours: s.quietHours,
      busy: assistant.busy,
      pendingWakeups: store.schedule.pending(1000).filter((w) => w.kind !== "system").length,
      modes: ["autonomous", "ask"],
      outboxSeq: store.outbox.head(),
      host: { name: hostname(), platform: `${platform()} ${arch()}` },
      brain: assistant.brainHealth,
      hands: s.hands,
      spend: store.log.spendByDay(7, s.timezone),
      wakeups: store.log.wakeupsToday(s.timezone),
      fallback: s.fallback,
      activeModel: assistant.activeModel() ?? s.model,
      caps: assistant.caps(),
    };
  };

  app.get("/v1/status", (c) => c.json(status()));

  app.patch("/v1/settings", async (c) => {
    const patch = SettingsPatch.safeParse(await c.req.json().catch(() => null));
    if (!patch.success) return c.json({ error: patch.error.message }, 400);
    for (const model of [patch.data.model ?? [], patch.data.fallback ?? []].flat()) {
      const problem = checkModel(model);
      if (problem) return c.json({ error: problem }, 400);
    }
    if (patch.data.timezone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: patch.data.timezone });
      } catch {
        return c.json({ error: `unknown timezone "${patch.data.timezone}"` }, 400);
      }
    }
    store.updateSettings(patch.data);
    console.log(`[midna] settings changed by ${c.get("device").name}: ${JSON.stringify(patch.data)}`);
    deps.onSettingsChanged(patch.data);
    return c.json(status());
  });

  app.post("/v1/pairing-codes", (c) => c.json(store.devices.pairingCode()));

  app.get("/v1/devices", (c) => c.json(store.devices.list()));
  app.delete("/v1/devices/:id", (c) => {
    store.devices.revoke(c.req.param("id"));
    deps.hands.disconnect(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/v1/devices/:id/commands", (c) => c.json(store.hands.commands(c.req.param("id"), Math.min(500, Number(c.req.query("limit") ?? 200) || 200))));

  app.get("/v1/brains", (c) => c.json(installedBrains()));
  app.post("/v1/brains/check", async (c) => c.json(await assistant.checkBrain()));

  app.get("/v1/history", (c) =>
    c.json(
      store.log.history(c.req.query("conversation") ?? MAIN, {
        before: Number(c.req.query("before") ?? 0) || undefined,
        limit: Math.min(200, Number(c.req.query("limit") ?? 50) || 50),
      }),
    ),
  );

  app.get("/v1/bridges", (c) => c.json(deps.bridges()));

  app.post("/v1/bridges/:name/setup", async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as Record<string, string>;
    try {
      const result = await deps.setupBridge(c.req.param("name"), input);
      console.log(`[midna] bridge ${c.req.param("name")} set up by ${c.get("device").name}`);
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post("/v1/bridges/reload", (c) => {
    deps.reloadBridges();
    return c.json({ ok: true });
  });

  app.post("/v1/messages", async (c) => {
    const msg = SendMessage.safeParse(await c.req.json().catch(() => null));
    if (!msg.success) return c.json({ error: msg.error.message }, 400);
    // A reply to an approval's question that answers it ("Allow", a tapped button) is that answer, not a message for midna.
    if (msg.data.replyTo !== undefined && store.hands.approvalAsked(msg.data.replyTo) && !msg.data.attachments?.length) {
      const refused = fromHost(c);
      const r = refused ? null : deps.hands.approvals.reply({ replyTo: msg.data.replyTo, text: msg.data.text, client: msg.data.client }, { name: c.get("device").name });
      if (refused && answerIn(msg.data.text)) return refused;
      if (r === "over") return c.json({ error: "that approval is already over: answered, timed out or dropped" }, 409);
      if (r) return c.json({ conversationId: MAIN, approval: r }, 202);
    }
    if (!msg.data.text.replace(QUEUE_PREFIX, "").trim() && !msg.data.attachments?.length) return c.json({ error: "a message needs text or an attachment" }, 400);
    const unknown = msg.data.attachments?.find((id) => !store.attachments.get(id));
    if (unknown) return c.json({ error: `no attachment ${unknown} — upload it first` }, 400);
    const receipt = assistant.receive({
      text: msg.data.text,
      client: msg.data.client,
      ...(msg.data.conversationId ? { conversationId: msg.data.conversationId } : {}),
      ...(msg.data.replyTo ? { replyTo: msg.data.replyTo } : {}),
      ...(msg.data.attachments?.length ? { attachments: msg.data.attachments } : {}),
      ...(msg.data.inReplyTo ? { inReplyTo: msg.data.inReplyTo } : {}),
    });
    return c.json<MessageReceipt>(receipt, 202);
  });

  // ── inbound events: what other programs tell midna, heard in the background ──
  app.post("/v1/inbound", async (c) => {
    const e = SendEvent.safeParse(await c.req.json().catch(() => null));
    if (!e.success) return c.json({ error: e.error.message }, 400);
    if (e.data.data !== undefined && new TextEncoder().encode(JSON.stringify(e.data.data)).byteLength > MAX_EVENT_DATA_BYTES) {
      return c.json({ error: `an event's data can be at most ${MAX_EVENT_DATA_BYTES / 1024} KB of JSON` }, 413);
    }
    return c.json(assistant.hear(e.data), 202);
  });

  // ── attachments: the bytes behind images and files in the conversation ──
  // Any type, up to MAX_ATTACHMENT_BYTES; ?name= is required, ?caption= and ?as=file optional.
  app.post("/v1/attachments", async (c) => {
    const tooBig = () => c.json({ error: `the most midna keeps is ${MAX_ATTACHMENT_BYTES / 1048576} MB` }, 413);
    if (Number(c.req.header("content-length") ?? 0) > MAX_ATTACHMENT_BYTES) return tooBig();
    const data = await readCapped(c.req.raw, MAX_ATTACHMENT_BYTES);
    if (!data) return tooBig();
    const as = c.req.query("as") as "image" | "file" | undefined;
    if (as !== undefined && as !== "image" && as !== "file") return c.json({ error: 'as is "image" or "file"' }, 400);
    try {
      const file = { data, name: c.req.query("name") ?? "", mime: c.req.header("content-type") ?? null, source: `upload from ${c.get("device").name}` };
      return c.json(store.attachments.add({ ...file, caption: c.req.query("caption") ?? null, ...(as ? { as } : {}) }), 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.delete("/v1/attachments/:id", (c) => {
    const r = store.attachments.remove(c.req.param("id"));
    if (r === "missing") return c.json({ error: "no such attachment" }, 404);
    if (r === "sent") return c.json({ error: "that attachment was sent with a message; it stays with it" }, 409);
    return c.json({ ok: true });
  });

  app.get("/v1/attachments/:id", (c) => {
    const file = store.attachments.read(c.req.param("id"));
    if (!file) return c.json({ error: "no such attachment" }, 404);
    const { attachment: a, data } = file;
    return c.body(data as Uint8Array<ArrayBuffer>, 200, {
      "content-type": a.mime,
      "content-length": String(data.byteLength),
      // An attachment never changes; the name is for a save dialog, and nothing in it runs.
      "cache-control": "private, max-age=31536000, immutable",
      "content-disposition": `${a.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
  });

  // ── device hands: the desktop app on the user's computers, as midna's hands ──
  // Only the app offers them; commands go out solely from midna's tools, never from a /v1 route.
  // midna's own host token is on the machine midna runs on, where its brain could reach it: a yes comes from a person's device.
  const fromHost = (c: Context<Env>) =>
    c.get("device").kind === "host" ? c.json({ error: "approvals are answered from the user's own devices, not from midna's host" }, 403) : null;
  const handsDevice = (c: Context<Env>) => (c.get("device").kind === "desktop" ? null : c.json({ error: "only the midna desktop app offers its hands" }, 403));

  app.post("/v1/hands/hello", async (c) => {
    const refused = handsDevice(c);
    if (refused) return refused;
    const hello = HandsHello.safeParse(await c.req.json().catch(() => null));
    if (!hello.success) return c.json({ error: hello.error.message }, 400);
    const welcome = deps.hands.hello(c.get("device").id, hello.data);
    if ("error" in welcome) return c.json(welcome, 400);
    const { os, app: a } = hello.data;
    console.log(`[midna] hands: ${c.get("device").name} said hello (${os.family} ${os.version}, app ${a.version})`);
    return c.json(welcome);
  });

  app.get("/v1/hands/stream", (c) => {
    const refused = handsDevice(c);
    if (refused) return refused;
    const queue: HandsStreamEvent[] = [];
    let wake: (() => void) | null = null;
    let closing = false;
    const detach = deps.hands.attach(c.get("device").id, c.req.query("session") ?? "", {
      send: (e) => {
        queue.push(e);
        wake?.();
      },
      close: () => {
        closing = true;
        wake?.();
      },
    });
    if (!detach) return c.json({ error: "that session is over — say hello again" }, 409);
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => wake?.());
      try {
        // Headers go out with the first bytes: say something at once, so the device knows it's connected.
        await stream.write(": connected\n\n");
        while (!stream.aborted) {
          const e = queue.shift();
          if (e) {
            await stream.writeSSE({ data: JSON.stringify(e) });
            continue;
          }
          if (closing) break;
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(25_000)]);
          wake = null;
          if (!queue.length && !closing && !stream.aborted) await stream.write(": keepalive\n\n");
        }
      } finally {
        detach();
      }
    });
  });

  app.post("/v1/hands/state", async (c) => {
    const refused = handsDevice(c);
    if (refused) return refused;
    const update = HandsStateUpdate.safeParse(await c.req.json().catch(() => null));
    if (!update.success) return c.json({ error: update.error.message }, 400);
    if (!deps.hands.state(c.get("device").id, update.data)) return c.json({ error: "that session is over — say hello again" }, 409);
    return c.json({ ok: true });
  });

  app.post("/v1/hands/results/:id", async (c) => {
    const refused = handsDevice(c);
    if (refused) return refused;
    const result = HandsResult.safeParse(await c.req.json().catch(() => null));
    if (!result.success) return c.json({ error: result.error.message }, 400);
    if (result.data.id !== c.req.param("id")) return c.json({ error: "the result's id isn't the one in its path" }, 400);
    const r = deps.hands.result(c.get("device").id, result.data);
    if (r === "unknown") return c.json({ error: "no such command" }, 404);
    if (r === "other") return c.json({ error: "that command was sent to another device" }, 403);
    if (r === "done") return c.json({ error: "that command is already over: answered, timed out or cancelled" }, 409);
    return c.json({ ok: true });
  });

  app.get("/v1/hands/devices", (c) => c.json(deps.hands.devices()));

  // ── approvals: what waits for the user's yes; the first answer wins ──
  app.get("/v1/approvals", (c) => c.json(deps.hands.approvals.pending()));

  app.post("/v1/approvals/:id", async (c) => {
    const refused = fromHost(c);
    if (refused) return refused;
    const body = AnswerApproval.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const r = deps.hands.approvals.answer(c.req.param("id"), body.data.answer, { name: c.get("device").name, via: body.data.client });
    if (r === "unknown") return c.json({ error: "no such approval" }, 404);
    if (r === "over") return c.json({ error: "that approval is already over: answered, timed out or dropped", approval: store.hands.approval(c.req.param("id")) }, 409);
    return c.json(r);
  });

  app.get("/v1/outbox", (c) => c.json(store.outbox.since(Number(c.req.query("since") ?? 0))));

  /** A read-only snapshot for dashboards: objectives, today, what's open. */
  app.get("/v1/overview", (c) => {
    const now = Date.now();
    const tz = store.settings().timezone;
    const p = store.planning;
    return c.json({
      now: fmt(now, tz),
      goals: p.goals(),
      tasks: p.tasks(),
      commitments: p.commitments(),
      events: p.events(now - 2 * HOUR, now + 7 * DAY),
      wakeups: store.schedule.pending(100).filter((w) => w.kind !== "system"),
      memory: store.memory.count(),
      spendLast7DaysUsd: store.log.spend(now - 7 * DAY),
    });
  });

  app.get("/v1/events", (c) => {
    const since = Number(c.req.query("since") ?? 0);
    return streamSSE(c, async (stream) => {
      // Subscribe before replaying so nothing released in between is lost.
      const queue: StreamEvent[] = [];
      let wake: (() => void) | null = null;
      const off = store.bus.on((e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        off();
        wake?.();
      });
      let last = since;
      try {
        for (const item of store.outbox.since(since)) {
          await stream.writeSSE({ id: String(item.seq), data: JSON.stringify({ type: "outbox", item } satisfies StreamEvent) });
          last = item.seq;
        }
        while (!stream.aborted) {
          const e = queue.shift();
          if (!e) {
            await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(25_000)]);
            wake = null;
            if (!queue.length && !stream.aborted) await stream.write(": keepalive\n\n");
            continue;
          }
          if (e.type === "outbox") {
            if (e.item.seq <= last) continue;
            last = e.item.seq;
            await stream.writeSSE({ id: String(e.item.seq), data: JSON.stringify(e) });
          } else {
            await stream.writeSSE({ data: JSON.stringify(e) });
          }
        }
      } finally {
        off();
      }
    });
  });

  return app;
}
