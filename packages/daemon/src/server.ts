import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import { arch, hostname, platform } from "node:os";
import { HOUR, MAIN, DAY, fmt, type Device, type Store } from "@midna/core";
import { checkModel, handleMcp, installedBrains, type Assistant } from "@midna/agent";
import {
  PairRequest,
  SendMessage,
  SettingsPatch,
  SERVICE,
  type BridgeInfo,
  type BridgeSetupResult,
  type Health,
  type StreamEvent,
  type Status,
} from "@midna/protocol";
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
}

type Env = { Variables: { device: Device } };

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bearer = (c: Context) => c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";

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
    const paired = store.devices.pair(req.data.code, req.data.deviceName, req.data.kind);
    if (!paired) return c.json({ error: "that pairing code is wrong or expired" }, 403);
    console.log(`[midna] paired ${req.data.kind} "${req.data.deviceName}" (${paired.device.id})`);
    return c.json({ deviceId: paired.device.id, token: paired.token, name: store.settings().name });
  });

  // ── midna's own tools, for its brain sessions only ───────────────────
  app.all("/mcp/:episode", async (c) => {
    if (!safeEqual(bearer(c), deps.mcpToken)) return c.json({ error: "unauthorized" }, 401);
    const episodeId = Number(c.req.param("episode"));
    if (!store.log.episodeExists(episodeId)) return c.json({ error: "unknown episode" }, 404);
    const episode = store.db.query("SELECT kind, conversation_id FROM episodes WHERE id = $id").get({ id: episodeId }) as { kind: "chat" | "wakeup"; conversation_id: string | null };
    return handleMcp(c.req.raw, { store, episodeId, episodeKind: episode.kind, conversationId: episode.conversation_id ?? MAIN });
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
    };
  };

  app.get("/v1/status", (c) => c.json(status()));

  app.patch("/v1/settings", async (c) => {
    const patch = SettingsPatch.safeParse(await c.req.json().catch(() => null));
    if (!patch.success) return c.json({ error: patch.error.message }, 400);
    if (patch.data.model) {
      const problem = checkModel(patch.data.model);
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
    return c.json({ ok: true });
  });

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
    const conversationId = assistant.receive({
      text: msg.data.text,
      client: msg.data.client,
      ...(msg.data.conversationId ? { conversationId: msg.data.conversationId } : {}),
      ...(msg.data.replyTo ? { replyTo: msg.data.replyTo } : {}),
    });
    return c.json({ conversationId }, 202);
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
