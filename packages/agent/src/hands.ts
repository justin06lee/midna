import type { Attachment, HandsDevice, Op } from "@midna/protocol";

/**
 * What midna's device tools reach: the user's computers that offer their
 * hands (docs/device-hands.md). The daemon implements it with the live
 * connections, the signing key, the policy and the audit log; the tools
 * only ask and report, so the agent never imports the daemon.
 */
export interface HandsHandle {
  /** Every paired device that offers its hands, online or not. */
  devices(): HandsDevice[];
  /** Have a device do one operation, if everything along the way allows it, and wait for how it went. */
  run(req: HandsRequest): Promise<HandsOutcome>;
}

export interface HandsRequest {
  /** A device's name or id; left out, the one online device that can do this. */
  device?: string;
  op: Op;
  args: Record<string, unknown>;
  /** Up to the operation's cap; its default when left out. */
  timeoutMs?: number;
  episodeId: number | null;
  /** The tool call was cancelled: cancel the command too. */
  signal?: AbortSignal;
}

export type HandsOutcome =
  | { ok: true; device: { id: string; name: string }; commandId: string; data: unknown; attachments: Attachment[]; ms: number }
  /** Refused, denied, failed on the device, timed out or cut off — `message` says which, in words midna can act on. */
  | { ok: false; message: string; code?: string };
