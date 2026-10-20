import { z } from "zod";

/**
 * Device hands (docs/device-hands.md): the desktop app on a machine of the
 * user's registers as a device that offers capabilities, and midna's daemon
 * drives it with signed commands. The app keeps one outbound connection:
 *
 *   POST /v1/hands/hello            HandsHello → HandsWelcome; a new session, replacing any earlier one
 *   GET  /v1/hands/stream?session=  SSE, one HandsStreamEvent per `data:`; 25 s keepalive comments
 *   POST /v1/hands/state            HandsStateUpdate, on any change
 *   POST /v1/hands/results/:id      HandsResult, once per command
 *   GET  /v1/hands/devices          HandsDevice[], for any paired client
 *   GET  /v1/devices/:id/commands   DeviceCommandRecord[], the audit log
 *
 * all with the device's own token. Mirrored as serde types in the app; the
 * fixture in packages/protocol/fixtures/hands.json keeps the two in step.
 */

export const HANDS_PROTOCOL = 1;

export const CAPABILITIES = ["screen", "input", "script", "shell", "files", "clipboard", "open", "notify"] as const;
export const Capability = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof Capability>;

/** How a device offers a capability: "on" runs (ask mode still asks before acting), "ask" needs a person's yes each time. Not offered = off. */
export const Policy = z.enum(["on", "ask"]);
export type Policy = z.infer<typeof Policy>;
/** A capability's toggle in the app. */
export type Toggle = "off" | Policy;

export const DeviceState = z.enum(["ready", "paused", "locked", "display_asleep"]);
export type DeviceState = z.infer<typeof DeviceState>;

export const Permission = z.enum(["screen_recording", "accessibility", "automation", "full_disk_access", "notifications", "local_network"]);
export type Permission = z.infer<typeof Permission>;
export const PermissionState = z.enum(["granted", "denied", "not_asked", "needs_relaunch", "n/a"]);
export type PermissionState = z.infer<typeof PermissionState>;

/** Every operation, and the capability it needs. Phase 1 builds screenshot, open and notify; the rest route the same way. */
export const OPS = {
  screenshot: "screen",
  click: "input",
  move: "input",
  drag: "input",
  scroll: "input",
  type: "input",
  key: "input",
  script: "script",
  shell: "shell",
  file_read: "files",
  file_list: "files",
  file_write: "files",
  clipboard_read: "clipboard",
  clipboard_write: "clipboard",
  open: "open",
  notify: "notify",
} as const satisfies Record<string, Capability>;
export type Op = keyof typeof OPS;
export const Op = z.enum(Object.keys(OPS) as [Op, ...Op[]]);

/** Each operation's timeout when the brain doesn't say, and the most it may ask for. */
export const OP_TIMEOUTS: Record<Op, { default: number; cap: number }> = {
  screenshot: { default: 10_000, cap: 10_000 },
  click: { default: 5_000, cap: 5_000 },
  move: { default: 5_000, cap: 5_000 },
  drag: { default: 5_000, cap: 5_000 },
  scroll: { default: 5_000, cap: 5_000 },
  type: { default: 5_000, cap: 60_000 },
  key: { default: 5_000, cap: 5_000 },
  script: { default: 30_000, cap: 300_000 },
  shell: { default: 60_000, cap: 600_000 },
  file_read: { default: 30_000, cap: 30_000 },
  file_list: { default: 30_000, cap: 30_000 },
  file_write: { default: 60_000, cap: 60_000 },
  clipboard_read: { default: 5_000, cap: 5_000 },
  clipboard_write: { default: 5_000, cap: 5_000 },
  open: { default: 10_000, cap: 10_000 },
  notify: { default: 5_000, cap: 5_000 },
};

/** What each capability needs granted on macOS before it can run (Linux reports "n/a"). */
export const NEEDS: Partial<Record<Capability, Permission[]>> = {
  screen: ["screen_recording"],
  input: ["accessibility"],
  script: ["automation"],
  notify: ["notifications"],
};

/**
 * The policy table — every value here is Justin's call (forks 1, 2 and 5
 * in docs/device-hands.md), so his answers change this table and nothing
 * else. `defaults`: what each capability starts as in the app before anyone
 * touches its toggle. `observe`: operations that only look (and notify,
 * which only tells him something), so they run in ask mode when their
 * capability is On; every other operation is acting, and needs a yes.
 */
export const HANDS_POLICY: { defaults: Record<Capability, Toggle>; observe: readonly Op[] } = {
  defaults: { screen: "on", open: "on", notify: "on", input: "ask", script: "ask", files: "ask", clipboard: "ask", shell: "ask" },
  observe: ["screenshot", "file_read", "file_list", "clipboard_read", "notify"],
};

export const Display = z.object({
  id: z.string(),
  name: z.string(),
  primary: z.boolean(),
  /** Points, in the global layout. */
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  scale: z.number(),
});
export type Display = z.infer<typeof Display>;

/** Device → daemon, on every (re)connect: POST /v1/hands/hello. */
export const HandsHello = z.object({
  protocol: z.literal(HANDS_PROTOCOL),
  app: z.object({ version: z.string() }),
  os: z.object({
    family: z.enum(["macos", "linux"]),
    version: z.string(),
    arch: z.string(),
    hostname: z.string(),
    session: z.enum(["quartz", "x11", "wayland"]).optional(),
    /** "GNOME", "Hyprland", … */
    desktop: z.string().optional(),
  }),
  displays: z.array(Display),
  /** What it offers, and how. A capability left out is off. */
  offers: z.partialRecord(Capability, Policy),
  permissions: z.partialRecord(Permission, PermissionState),
  /** Automation per target bundle id ("com.apple.MobileSMS"). */
  automation: z.record(z.string(), PermissionState).optional(),
  state: DeviceState,
  /** Fresh and random for every connection: every command on it is signed over it. */
  nonce: z.string().min(16).max(128),
});
export type HandsHello = z.infer<typeof HandsHello>;

/** Daemon → device, answering hello. */
export interface HandsWelcome {
  /** The session the stream, state updates and results belong to. */
  session: string;
  /** The daemon's Ed25519 public key: 32 raw bytes, base64url. Pin it at pairing, or on the first hello of a device paired before 0.8. */
  daemonKey: string;
  /** SHA-256 of the raw key, for people to compare: "ab12 cd34 …" (16 bytes, hex). */
  fingerprint: string;
}

/** Device → daemon, whenever something changes: POST /v1/hands/state. Only what changed. */
export const HandsStateUpdate = z.object({
  session: z.string(),
  state: DeviceState.optional(),
  offers: z.partialRecord(Capability, Policy).optional(),
  permissions: z.partialRecord(Permission, PermissionState).optional(),
  automation: z.record(z.string(), PermissionState).optional(),
  displays: z.array(Display).optional(),
});
export type HandsStateUpdate = z.infer<typeof HandsStateUpdate>;

/**
 * A command, as signed. On the stream it travels as a SignedCommand: the
 * canonical JSON of this object (keys sorted, no whitespace) as a string,
 * and an Ed25519 signature over that string's UTF-8 bytes. The device
 * checks the signature against the pinned key over the bytes as received,
 * then parses them, and refuses unless `nonce` is its connection's, `seq`
 * is above every seq it has seen on it, and `id` is new.
 */
export const HandsCommand = z.object({
  /** "cmd_…"; the device runs an id at most once. */
  id: z.string(),
  nonce: z.string(),
  /** Strictly increasing within the session, from 1. */
  seq: z.number().int().positive(),
  op: Op,
  args: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().positive(),
  /** For the app's activity list. */
  episodeId: z.number().int().nullable(),
  /** Present when a person approved it. */
  approval: z.object({ by: z.string(), at: z.number() }).optional(),
  issuedAt: z.number(),
});
export type HandsCommand = z.infer<typeof HandsCommand>;

/** Daemon → device on the stream. A cancel or bye needs no signature: all it can do is stop. */
export type HandsStreamEvent =
  | { type: "command"; /** canonical JSON of a HandsCommand */ signed: string; /** Ed25519 over signed's UTF-8 bytes, base64url */ sig: string }
  | { type: "cancel"; id: string }
  /** The session is over (a newer hello, the device revoked): stop, and say hello again if it wasn't a revoke. */
  | { type: "bye"; reason: "replaced" | "revoked" | "shutdown" };

export const HandsErrorCode = z.enum(["off", "paused", "locked", "permission", "user_active", "timeout", "cancelled", "unsupported", "bad_args", "failed"]);
export type HandsErrorCode = z.infer<typeof HandsErrorCode>;

/** Device → daemon: POST /v1/hands/results/:id, exactly once per command. */
export const HandsResult = z.discriminatedUnion("ok", [
  z.object({
    id: z.string(),
    ok: z.literal(true),
    data: z.unknown(),
    /** Ids of attachments uploaded first (POST /v1/attachments): a screenshot's PNG, long output. */
    attachments: z.array(z.string()).max(20).optional(),
    ms: z.number(),
  }),
  z.object({
    id: z.string(),
    ok: z.literal(false),
    ms: z.number(),
    error: z.object({ code: HandsErrorCode, message: z.string(), permission: Permission.optional() }),
  }),
]);
export type HandsResult = z.infer<typeof HandsResult>;

/** The arguments of the operations built so far. */
export const ScreenshotArgs = z.object({
  /** A display id from the hello; the primary one when left out. */
  display: z.string().optional(),
  /** Native resolution; otherwise scaled so the long edge is at most 1568 px. */
  full: z.boolean().optional(),
  /** Wake a sleeping display to take it. */
  wake: z.boolean().optional(),
});
/** What a screenshot's result data holds; the PNG is its one attachment. */
export const ScreenshotData = z.object({
  width: z.number(),
  height: z.number(),
  display: z.string(),
  scale: z.number(),
  cursor: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
});
export const OpenArgs = z
  .object({ url: z.string().optional(), app: z.string().optional(), path: z.string().optional() })
  .refine((a) => [a.url, a.app, a.path].filter(Boolean).length === 1, { message: "open takes exactly one of url, app or path" });
export const NotifyArgs = z.object({ title: z.string().min(1).max(200), body: z.string().max(2000) });
export const OP_ARGS: Partial<Record<Op, z.ZodType>> = { screenshot: ScreenshotArgs, open: OpenArgs, notify: NotifyArgs };

/** A device as midna and every client see it: GET /v1/hands/devices, and the device_list tool. */
export interface HandsDevice {
  id: string;
  name: string;
  online: boolean;
  /** When the daemon last heard from it. */
  lastSeenAt: number | null;
  state: DeviceState | null;
  os: HandsHello["os"] | null;
  app: HandsHello["app"] | null;
  displays: Display[];
  /** Each capability the app knows: its toggle, and the permissions it still needs. */
  capabilities: Array<{ capability: Capability; policy: Toggle; missing: Permission[] }>;
}

/** How a command was decided: by the policy, by a person, or refused before it went out. */
export type CommandDecision = "allowed" | "approved" | "denied" | "refused";
export type CommandOutcome = "ok" | "error" | "timeout" | "cancelled" | "disconnected";

/** One row of a device's audit log: GET /v1/devices/:id/commands. */
export interface DeviceCommandRecord {
  id: string;
  deviceId: string;
  episodeId: number | null;
  op: Op;
  /** As sent, with secrets redacted. */
  args: Record<string, unknown>;
  decision: CommandDecision;
  /** "policy", or who approved it from which client. */
  decidedBy: string | null;
  /** Why it was refused or denied, or what went wrong. */
  reason: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: CommandOutcome | null;
  /** The result, capped at 4 KB. */
  summary: string | null;
  errorCode: string | null;
  attachments: string[];
}

/** JSON with every object's keys sorted and no whitespace: the text a command is signed as. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
