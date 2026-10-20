import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MidnaClient, MidnaError, type Approval, type ApprovalAnswer, type Attachment, type Connection, type HistoryItem, type OutboxItem, type Priority, type Status, type StreamEvent } from "@midna/protocol";
import { notify } from "./host";

/** One line of the conversation, however it arrived. */
export interface Line {
  /** "m:<message id>" for the user's lines, "o:<outbox id>" for midna's, "p:<n>" while sending. */
  key: string;
  role: "user" | "midna";
  text: string;
  client: string | null;
  at: number;
  kind?: OutboxItem["kind"];
  priority?: Priority;
  options?: string[] | null;
  answered?: boolean;
  outboxId?: number;
  /** Images and files that went with it. */
  attachments?: Attachment[];
  /** The message id, for lines that came from history — where older pages continue from. */
  messageId?: number;
  pending?: boolean;
}

export type Link = "connecting" | "live" | "lost" | "unpaired";

/**
 * A host can be older than this app (it is upgraded on the next connect):
 * fill in what an older midna doesn't report rather than fall over.
 */
export function normalizeStatus(s: Partial<Status> & Pick<Status, "version" | "name" | "mode" | "model">): Status {
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    quietHours: null,
    busy: false,
    pendingWakeups: 0,
    modes: ["autonomous", "ask"],
    outboxSeq: 0,
    host: { name: "", platform: "" },
    ...s,
    brain: s.brain ?? { ok: null, checkedAt: null },
  } as Status;
}

// A host older than 0.4 sends no attachments at all.
function fromHistory(h: HistoryItem): Line {
  const attachments = h.attachments ?? [];
  if (h.role === "user") return { key: `m:${h.id}`, role: "user", text: h.text, client: h.client, at: h.createdAt, messageId: h.id, attachments };
  const o = h.outbox;
  return {
    key: o ? `o:${o.id}` : `m:${h.id}`,
    messageId: h.id,
    role: "midna",
    text: h.text,
    client: h.client,
    at: h.createdAt,
    attachments,
    ...(o ? { kind: o.kind, priority: o.priority, options: o.options, answered: o.answered, outboxId: o.id } : { kind: "message" as const }),
  };
}

function fromOutbox(item: OutboxItem): Line {
  return { key: `o:${item.id}`, role: "midna", text: item.text, client: null, at: item.createdAt, kind: item.kind, priority: item.priority, options: item.options, answered: false, outboxId: item.id, attachments: item.attachments ?? [] };
}

const files = (l: Line) => (l.attachments ?? []).map((a) => a.id).join();

/** What a notification says about a line that may be only an image. */
function gist(text: string, attachments: Attachment[] = []): string {
  if (text.trim()) return text.slice(0, 240);
  const images = attachments.filter((a) => a.kind === "image").length;
  return images ? (images === 1 ? "sent an image" : `sent ${images} images`) : attachments.length === 1 ? `sent ${attachments[0]!.name}` : `sent ${attachments.length} files`;
}

/**
 * The live connection to midna: its status, the conversation (history plus
 * whatever arrives), whether it is thinking and with which tool, and a way
 * to talk to it.
 */
export function useMidna(connection: Connection) {
  const client = useMemo(() => new MidnaClient(connection.url, connection.token), [connection.url, connection.token]);
  const [status, setRawStatus] = useState<Status | null>(null);
  const setStatus = useCallback((s: Status | null | ((prev: Status | null) => Status | null)) => {
    setRawStatus((prev) => {
      const next = typeof s === "function" ? s(prev) : s;
      return next ? normalizeStatus(next) : next;
    });
  }, []);
  const [lines, setLines] = useState<Line[]>([]);
  const [link, setLink] = useState<Link>("connecting");
  const [thinking, setThinking] = useState<{ tool: string | null } | null>(null);
  const [olderExhausted, setOlderExhausted] = useState(false);
  const [changed, setChanged] = useState(0); // bumps when midna touched its records
  /** Device hands approvals, by the chat question that asks each one. */
  const [approvals, setApprovals] = useState<Map<number, Approval>>(new Map());
  const noteApproval = useCallback((a: Approval) => {
    if (a.outboxId === null) return;
    setApprovals((cur) => new Map(cur).set(a.outboxId!, a));
  }, []);
  const pending = useRef(0);

  const merge = useCallback((incoming: Line[], where: "append" | "prepend" = "append") => {
    setLines((cur) => {
      const seen = new Map(cur.map((l, i) => [l.key, i]));
      const next = [...cur];
      const fresh: Line[] = [];
      for (const l of incoming) {
        const at = seen.get(l.key);
        if (at !== undefined) next[at] = { ...next[at]!, ...l };
        else {
          // The echo of something this window sent replaces its placeholder.
          const p = l.role === "user" ? next.findIndex((x) => x.pending && x.text === l.text && files(x) === files(l)) : -1;
          if (p >= 0) next[p] = l;
          else fresh.push(l);
        }
      }
      return where === "prepend" ? [...fresh, ...next] : [...next, ...fresh];
    });
  }, []);

  // Status now, and every half minute.
  useEffect(() => {
    let alive = true;
    const load = () =>
      client.status().then(
        (s) => alive && setStatus(s),
        (err) => {
          if (alive && err instanceof MidnaError && err.status === 401) setLink("unpaired");
        },
      );
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [client, setStatus]);

  // History, then the stream from where it left off; reconnecting with backoff.
  useEffect(() => {
    const abort = new AbortController();
    setLines([]);
    setOlderExhausted(false);
    void (async () => {
      let since: number | null = null;
      for (let backoff = 1_000; !abort.signal.aborted; ) {
        try {
          if (since === null) {
            const s = await client.status();
            setStatus(s);
            since = s.outboxSeq;
            const history = await client.history({ limit: 60 });
            merge(history.map(fromHistory));
            if (history.length < 60) setOlderExhausted(true);
          } else {
            // Reconnecting: "live" once midna answers, not merely because we're trying.
            setStatus(await client.status());
          }
          setLink("live");
          backoff = 1_000;
          for await (const e of client.events(since, abort.signal)) {
            if (e.type === "outbox") since = e.item.seq;
            onEvent(e);
          }
        } catch (err) {
          if (abort.signal.aborted) return;
          if (err instanceof MidnaError && err.status === 401) return setLink("unpaired");
        }
        setLink("lost");
        setThinking(null);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    })();

    function onEvent(e: StreamEvent) {
      if (e.type === "outbox") {
        merge([fromOutbox(e.item)]);
        setChanged((n) => n + 1);
        if (e.item.kind !== "message" || !document.hasFocus()) void notify(e.item.kind === "question" ? "midna asks" : "midna", gist(e.item.text, e.item.attachments));
      } else if (e.type === "user_message") {
        merge([{ key: `m:${e.id}`, role: "user", text: e.text, client: e.client, at: e.createdAt, attachments: e.attachments ?? [] }]);
        if (e.replyTo) setLines((cur) => cur.map((l) => (l.outboxId === e.replyTo ? { ...l, answered: true } : l)));
      } else if (e.type === "status") {
        setThinking(e.state === "thinking" ? { tool: null } : null);
        if (e.state === "idle") setChanged((n) => n + 1);
      } else if (e.type === "activity") {
        setThinking({ tool: e.tool });
      } else if (e.type === "approval") {
        noteApproval(e.approval);
      }
    }
    return () => abort.abort();
  }, [client, merge, setStatus, noteApproval]);

  // What waits for a yes now (a host before 0.9 has no approvals).
  useEffect(() => {
    setApprovals(new Map());
    client.approvals().then((all) => all.forEach(noteApproval), () => {});
  }, [client, noteApproval]);

  /** Answer an approval from the chat; when it's already over, show how it ended. */
  const answerApproval = useCallback(
    async (a: Approval, answer: ApprovalAnswer) => {
      try {
        noteApproval(await client.answerApproval(a.id, { answer, client: "desktop" }));
      } catch (err) {
        if (!(err instanceof MidnaError && err.status === 409)) throw err;
        // Over already; the stream says how, unless it hasn't yet.
        setApprovals((cur) => {
          const known = cur.get(a.outboxId!);
          if (known && known.state !== "pending") return cur;
          return new Map(cur).set(a.outboxId!, { ...a, state: a.expiresAt <= Date.now() ? "expired" : "cancelled" });
        });
      }
    },
    [client, noteApproval],
  );

  const loadOlder = useCallback(async () => {
    const ids = lines.flatMap((l) => (l.messageId ? [l.messageId] : []));
    if (!ids.length || olderExhausted) return;
    const page = await client.history({ limit: 60, before: Math.min(...ids) });
    if (page.length < 60) setOlderExhausted(true);
    merge(page.map(fromHistory), "prepend");
  }, [client, lines, merge, olderExhausted]);

  /** Say something — with files uploaded first, in the order they should arrive. */
  const send = useCallback(
    async (text: string, replyTo?: number, attachments: Attachment[] = []) => {
      const key = `p:${++pending.current}`;
      merge([{ key, role: "user", text, client: "desktop", at: Date.now(), pending: true, attachments }]);
      if (replyTo) setLines((cur) => cur.map((l) => (l.outboxId === replyTo ? { ...l, answered: true } : l)));
      try {
        await client.send({ text, client: "desktop", ...(replyTo ? { replyTo } : {}), ...(attachments.length ? { attachments: attachments.map((a) => a.id) } : {}) });
      } catch (err) {
        setLines((cur) => cur.filter((l) => l.key !== key));
        throw err;
      }
    },
    [client, merge],
  );

  const refreshStatus = useCallback(async () => setStatus(await client.status()), [client, setStatus]);
  const loadAttachment = useCallback((id: string) => client.attachment(id), [client]);

  /**
   * Put a file on the host to send with a message, reporting bytes as they
   * go. The same request as MidnaClient.upload, made with XMLHttpRequest:
   * WebKit's fetch can't say how much of an upload has gone.
   */
  const upload = useCallback(
    (file: File, onProgress: (sent: number) => void, signal?: AbortSignal) =>
      new Promise<Attachment>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${client.baseUrl}/v1/attachments?name=${encodeURIComponent(file.name)}`);
        xhr.setRequestHeader("authorization", `Bearer ${connection.token}`);
        xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
        xhr.upload.onprogress = (e) => onProgress(e.loaded);
        xhr.onload = () => {
          let data: { error?: string } | undefined;
          try {
            data = JSON.parse(xhr.responseText);
          } catch {
            /* not JSON */
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data as Attachment);
          else reject(new MidnaError(xhr.status, data?.error ?? (xhr.statusText || `upload failed (${xhr.status})`)));
        };
        xhr.onerror = () => reject(new Error("couldn't reach midna"));
        xhr.onabort = () => reject(new DOMException("upload stopped", "AbortError"));
        signal?.addEventListener("abort", () => xhr.abort());
        xhr.send(file);
      }),
    [client, connection.token],
  );

  const discardUpload = useCallback((id: string) => client.deleteAttachment(id), [client]);

  return { client, status, setStatus, refreshStatus, lines, link, thinking, send, loadOlder, olderExhausted, changed, loadAttachment, upload, discardUpload, approvals, answerApproval };
}
