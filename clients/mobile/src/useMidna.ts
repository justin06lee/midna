import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import { MidnaError, type Approval, type ApprovalAnswer, type Attachment, type Status, type StreamEvent, type UploadInfo } from "@midna/protocol";
import { clientFor, type PhoneConnection } from "./connection";
import { fromHistory, fromOutbox, mergeLines, type Line } from "./lines";
import { clearDelivered, onTokenChange, registerForPush, type PushSetup } from "./push";

export type Link = "connecting" | "live" | "lost" | "unpaired";

/** Newest last; a line still sending sits where it was typed. */
const byTime = (lines: Line[]) => [...lines].sort((a, b) => a.at - b.at);

/**
 * The live connection to midna, as the desktop's useMidna has it: status,
 * the conversation (history plus whatever arrives), whether midna is
 * thinking, what waits for a yes, and a way to talk. A phone spends most of
 * its time asleep, so coming back to the foreground reconnects at once and
 * catches up on what was said meanwhile.
 */
export function useMidna(connection: PhoneConnection) {
  const client = useMemo(() => clientFor(connection.url, connection.token), [connection.url, connection.token]);
  const auth = useMemo(() => ({ authorization: `Bearer ${connection.token}` }), [connection.token]);
  const [status, setStatus] = useState<Status | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [link, setLink] = useState<Link>("connecting");
  const [thinking, setThinking] = useState<{ tool: string | null } | null>(null);
  const [olderExhausted, setOlderExhausted] = useState(false);
  /** Device hands approvals by id: pending ones, and how the ones seen here ended. */
  const [approvals, setApprovals] = useState<Map<string, Approval>>(new Map());
  const pending = useRef(0);
  const kick = useRef<() => void>(() => {});

  const merge = useCallback((incoming: Line[], where: "append" | "prepend" = "append") => setLines((cur) => byTime(mergeLines(cur, incoming, where))), []);
  const noteApproval = useCallback((a: Approval) => setApprovals((cur) => new Map(cur).set(a.id, a)), []);

  /** What waits now. One pending here but not there ended while the phone slept, nobody here knows how: it goes. */
  const loadApprovals = useCallback(async () => {
    const now = await client.approvals().catch(() => null);
    if (!now) return;
    setApprovals((cur) => {
      const next = new Map([...cur].filter(([, a]) => a.state !== "pending"));
      for (const a of now) next.set(a.id, a);
      return next;
    });
  }, [client]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => s === "active" && kick.current());
    return () => sub.remove();
  }, []);

  // Push notifications: registered now, again on each return to the foreground and when iOS changes the token.
  const [push, setPush] = useState<PushSetup>("unknown");
  useEffect(() => {
    let live = true;
    const register = () => {
      clearDelivered();
      void registerForPush(client).then((p) => live && setPush(p));
    };
    register();
    const fg = AppState.addEventListener("change", (s) => s === "active" && register());
    const token = onTokenChange(register);
    return () => {
      live = false;
      fg.remove();
      token.remove();
    };
  }, [client]);

  // History, then the stream from where it left off; reconnecting with backoff, or at once when the app comes back.
  useEffect(() => {
    const abort = new AbortController();
    let attempt = new AbortController();
    let wakeUp: (() => void) | null = null;
    kick.current = () => {
      attempt.abort();
      wakeUp?.();
    };
    setLines([]);
    setApprovals(new Map());
    setOlderExhausted(false);
    setLink("connecting");

    function onEvent(e: StreamEvent) {
      if (e.type === "outbox") merge([fromOutbox(e.item)]);
      else if (e.type === "user_message") {
        merge([{ key: `m:${e.id}`, role: "user", text: e.text, client: e.client, at: e.createdAt, attachments: e.attachments ?? [] }]);
        if (e.replyTo) setLines((cur) => cur.map((l) => (l.outboxId === e.replyTo ? { ...l, answered: true } : l)));
      } else if (e.type === "status") setThinking(e.state === "thinking" ? { tool: null } : null);
      else if (e.type === "activity") setThinking({ tool: e.tool });
      else if (e.type === "approval") noteApproval(e.approval);
    }

    void (async () => {
      let since: number | null = null;
      for (let backoff = 1_000; !abort.signal.aborted; ) {
        attempt = new AbortController();
        const stop = () => attempt.abort();
        abort.signal.addEventListener("abort", stop, { once: true });
        try {
          const s = await client.status();
          setStatus(s);
          // The first time from where midna is now; after, from the last line seen, so nothing is missed.
          if (since === null) since = s.outboxSeq;
          // Whatever was said while away — from the other clients too, which the stream doesn't replay.
          const history = await client.history({ limit: 60 });
          merge(history.map(fromHistory));
          setOlderExhausted((done) => done || history.length < 60);
          void loadApprovals();
          setLink("live");
          backoff = 1_000;
          for await (const e of client.events(since, attempt.signal)) {
            if (e.type === "outbox") since = e.item.seq;
            onEvent(e);
          }
        } catch (err) {
          if (abort.signal.aborted) return;
          if (err instanceof MidnaError && err.status === 401) return setLink("unpaired");
        } finally {
          abort.signal.removeEventListener("abort", stop);
        }
        if (abort.signal.aborted) return;
        setThinking(null);
        if (attempt.signal.aborted) continue; // back in the foreground: now, not after a wait
        setLink("lost");
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, backoff);
          wakeUp = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wakeUp = null;
        backoff = Math.min(backoff * 2, 30_000);
      }
    })();
    return () => abort.abort();
  }, [client, merge, noteApproval, loadApprovals]);

  /** Answer an approval (Face ID first — the caller's job). When it's already over, say how, unless the stream already has. */
  const answerApproval = useCallback(
    async (a: Approval, answer: ApprovalAnswer) => {
      try {
        noteApproval(await client.answerApproval(a.id, { answer, client: "mobile" }));
      } catch (err) {
        if (!(err instanceof MidnaError && err.status === 409)) throw err;
        setApprovals((cur) => {
          const known = cur.get(a.id);
          if (known && known.state !== "pending") return cur;
          return new Map(cur).set(a.id, { ...a, state: a.expiresAt <= Date.now() ? "expired" : "cancelled" });
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

  /** Say something, with files uploaded first; a reply to a question names it. */
  const send = useCallback(
    async (text: string, replyTo?: number, attachments: Attachment[] = []) => {
      const key = `p:${++pending.current}`;
      merge([{ key, role: "user", text, client: "mobile", at: Date.now(), pending: true, attachments }]);
      if (replyTo) setLines((cur) => cur.map((l) => (l.outboxId === replyTo ? { ...l, answered: true } : l)));
      try {
        await client.send({ text, client: "mobile", ...(replyTo ? { replyTo } : {}), ...(attachments.length ? { attachments: attachments.map((a) => a.id) } : {}) });
      } catch (err) {
        setLines((cur) => cur.filter((l) => l.key !== key).map((l) => (replyTo && l.outboxId === replyTo ? { ...l, answered: false } : l)));
        throw err;
      }
    },
    [client, merge],
  );

  /** Put a file from this phone on the host, to send with a message. */
  const upload = useCallback(async (uri: string, info: UploadInfo) => client.upload(new Uint8Array(await new File(uri).arrayBuffer()), info), [client]);
  const discardUpload = useCallback((id: string) => client.deleteAttachment(id), [client]);

  /** Where an attachment's bytes are, and the header that lets this phone have them. */
  const attachmentSource = useCallback((id: string) => ({ uri: `${client.baseUrl}/v1/attachments/${encodeURIComponent(id)}`, headers: auth }), [client, auth]);

  /** An attachment on this phone, downloaded once into the cache, to open in Quick Look or share. */
  const fetchAttachment = useCallback(
    async (a: Attachment): Promise<File> => {
      const dir = new Directory(Paths.cache, "attachments", a.id);
      if (!dir.exists) dir.create({ intermediates: true });
      const file = new File(dir, a.name.replace(/[/\\]/g, "_") || "file");
      if (file.exists && file.size === a.size) return file;
      if (file.exists) file.delete();
      return File.downloadFileAsync(attachmentSource(a.id).uri, file, { headers: auth });
    },
    [attachmentSource, auth],
  );

  return { client, status, push, lines, link, thinking, send, loadOlder, olderExhausted, approvals, answerApproval, upload, discardUpload, attachmentSource, fetchAttachment, reconnect: () => kick.current() };
}

export type Midna = ReturnType<typeof useMidna>;
