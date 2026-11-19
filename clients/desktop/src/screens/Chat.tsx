import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { Approval, ApprovalAnswer, Attachment } from "@midna/protocol";
import { APPROVAL_OPTIONS, MAX_ATTACHMENT_BYTES } from "@midna/protocol";
import { MAX_FILES, PendingFiles, typeFor, usePendingFiles, type Upload } from "../attach";
import { copiedFiles, showInFolder } from "../host";
import { Markdown } from "../markdown";
import { Attachments, Media, Viewer, type Notice, type Viewing } from "../media";
import { Icon, Mark, Spinner } from "../ui";
import type { Line } from "../useMidna";

const DAY_MS = 86_400_000;
/** The day a stretch of the conversation began, as Messages heads one: "Today", "Yesterday", "Fri, Nov 20". */
function day(ms: number, now = Date.now()): string {
  const d = new Date(ms).toDateString();
  if (d === new Date(now).toDateString()) return "Today";
  if (d === new Date(now - DAY_MS).toDateString()) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
/** How long a silence must be before the time is said again. */
const TIME_BREAK = 30 * 60_000;
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
const finder = /Mac/.test(navigator.userAgent) ? "Show in Finder" : "Show in folder";
const carriesFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
const stamp = () => new Date().toLocaleString("sv").replace(" ", " at ").replaceAll(":", ".");

/** A pasted image comes as "image.png": name it the way a screenshot is named. */
function named(f: File): File {
  const ext = /^image\.(\w+)$/i.exec(f.name)?.[1];
  return ext ? new File([f], `Pasted image ${stamp()}.${ext}`, { type: f.type }) : f;
}

/** The conversation: everything said, on any device, and the place to say more. */
export function Chat({
  lines,
  thinking,
  canSend,
  send,
  loadOlder,
  olderExhausted,
  draft,
  onDraftUsed,
  shown,
  draftKey,
  loadAttachment,
  upload,
  discardUpload,
  approvals,
  answerApproval,
  controls,
}: {
  lines: Line[];
  thinking: { tool: string | null } | null;
  canSend: boolean;
  send: (text: string, replyTo?: number, attachments?: Attachment[]) => Promise<void>;
  loadOlder: () => Promise<void>;
  olderExhausted: boolean;
  draft?: string | null;
  onDraftUsed?: () => void;
  /** An attachment's bytes, fetched with this device's token. */
  loadAttachment: (id: string) => Promise<Blob>;
  /** Put a file on the host, reporting progress, to send with the next message. */
  upload: Upload;
  /** Take back an upload removed before sending. */
  discardUpload: (id: string) => Promise<unknown>;
  /** Device hands approvals, by the question that asks each. */
  approvals: Map<number, Approval>;
  answerApproval: (a: Approval, answer: ApprovalAnswer) => Promise<void>;
  /** False while another screen shows: the chat stays mounted, hidden, so nothing typed or uploading is lost. */
  shown: boolean;
  /** Where what's typed is kept until it is sent (localStorage), one per connection. */
  draftKey: string;
  /** What sits in the composer beside Send: the model's pop-up button. */
  controls?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const closeViewer = useCallback(() => setViewing(null), []);
  const [notice, setNotice] = useState<Notice | null>(null);
  const media = useMemo(() => ({ load: loadAttachment, view: setViewing, notice: setNotice }), [loadAttachment]);
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? "");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const files = usePendingFiles(upload, discardUpload);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  // Pasted, dropped or picked: into the composer, uploading at once.
  const { add } = files;
  const addFiles = useCallback(
    (list: File[]) => {
      if (!list.length || busy.current) return;
      setError(null);
      const left = add(list);
      if (left) setNotice({ text: `A message takes up to ${MAX_FILES} files; ${left === 1 ? "one was" : `${left} were`} left out.`, error: true });
      input.current?.focus();
    },
    [add],
  );

  // What's typed survives a restart or a crash; it goes once a send succeeds.
  useEffect(() => {
    if (busy.current) return; // mid-send: the box is empty, but the message isn't gone yet
    if (text) localStorage.setItem(draftKey, text);
    else localStorage.removeItem(draftKey);
  }, [text, draftKey]);

  useEffect(() => {
    if (!shown) return;
    const paste = async (e: ClipboardEvent) => {
      const list = [...(e.clipboardData?.files ?? [])];
      if (!list.length) return;
      e.preventDefault();
      // Several files copied in Finder reach WebKit as only the first: read them all through the app.
      const copied = await copiedFiles().catch(() => []);
      if (copied.length < 2) return addFiles(list.map(named));
      const big = copied.filter((c) => c.size > MAX_ATTACHMENT_BYTES);
      if (big.length) setNotice({ text: `Left out ${big.map((c) => c.name).join(", ")}: over the ${MAX_ATTACHMENT_BYTES / 1048576} MB limit.`, error: true });
      try {
        const read = await Promise.all(copied.filter((c) => !big.includes(c)).map(async (c) => new File([await c.read()], c.name, { type: typeFor(c.name) })));
        addFiles(read);
      } catch (err) {
        setNotice({ text: `Couldn't read what was copied: ${why(err)}`, error: true });
      }
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, [addFiles, shown]);

  // A notice stays long enough to act on.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.path ? 9000 : 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const drag = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      if (--depth.current <= 0) {
        depth.current = 0;
        setDragging(false);
      }
    },
    onDrop: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      addFiles([...e.dataTransfer.files]);
    },
  };

  // Something to say, handed over from another screen: below what the user has written, never over it.
  useEffect(() => {
    if (!draft) return;
    setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${draft}` : draft));
    onDraftUsed?.();
    input.current?.focus();
  }, [draft, onDraftUsed]);

  // Back from another screen: where it was, and ready to type.
  useLayoutEffect(() => {
    if (!shown) return;
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    input.current?.focus();
  }, [shown]);

  // Keep to the bottom as lines arrive — unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, thinking]);

  // Images arrive after their line does: stay at the bottom as they open up.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !content.current) return;
    const watch = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    watch.observe(content.current);
    return () => watch.disconnect();
  }, []);

  const onScroll = () => {
    if (!shown) return; // hidden, it has no height to measure
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 40 && !olderExhausted) {
      const before = el.scrollHeight;
      void loadOlder().then(() => requestAnimationFrame(() => (el.scrollTop += el.scrollHeight - before)));
    }
  };

  const submit = async (value = text, replyTo?: number) => {
    const t = value.trim();
    const withFiles = !replyTo && files.items.length > 0;
    if ((!t && !withFiles) || busy.current) return;
    setError(null);
    stick.current = true;
    busy.current = true;
    setSending(true);
    try {
      // Every file up first, then the message with them, in the order they were added.
      let attachments: Attachment[] = [];
      if (withFiles) {
        try {
          attachments = await files.ready();
        } catch {
          setError("a file didn't upload — try it again, or take it out");
          return;
        }
      }
      const taken = withFiles ? files.take() : null;
      if (!replyTo) setText("");
      try {
        await send(t, replyTo, attachments);
        taken?.done();
        if (!replyTo) localStorage.removeItem(draftKey);
      } catch (err) {
        if (!replyTo) setText(t);
        taken?.back();
        setError(why(err));
      }
    } finally {
      busy.current = false;
      setSending(false);
    }
  };

  // Grow the box with what's typed, up to a point.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const sendable = text.trim().length > 0 || files.items.length > 0;
  // Nothing to send while midna works: the button stops it instead.
  const stoppable = thinking !== null && !sendable && !sending;

  return (
    <Media.Provider value={media}>
      <div className="relative flex h-full min-h-0 flex-col" {...drag}>
        <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div ref={content} className="mx-auto w-full max-w-[720px] px-6 pt-4 pb-6">
            {lines.length === 0 && !thinking && (
              <div className="flex flex-col items-center pt-24 text-center">
                <Mark className="mb-3 size-8 text-dimmer" />
                <p className="text-[14px] font-medium">Say hello.</p>
                <p className="mt-1 max-w-[340px] text-[12.5px] text-dim">midna will start by getting to know you — what you're aiming for, and what's on your plate.</p>
              </div>
            )}
            {lines.map((l, i) => {
              const prev = lines[i - 1];
              const newDay = !prev || new Date(prev.at).toDateString() !== new Date(l.at).toDateString();
              const quiet = prev !== undefined && l.at - prev.at > TIME_BREAK;
              const gap = prev && !newDay && !quiet && (prev.role !== l.role || l.at - prev.at > 5 * 60_000);
              return (
                <Fragment key={l.key}>
                  {(newDay || quiet) && (
                    <div className="mt-6 mb-3 text-center text-[11px] text-dim">
                      <span className="font-semibold">{day(l.at)}</span> {time(l.at)}
                    </div>
                  )}
                  <div className={gap ? "mt-4" : "mt-1.5"}>
                    <LineView
                      line={l}
                      onAnswer={(option) => void submit(option, l.outboxId)}
                      canSend={canSend}
                      approval={l.outboxId === undefined ? undefined : approvals.get(l.outboxId)}
                      onApprove={answerApproval}
                    />
                  </div>
                </Fragment>
              );
            })}
            {thinking && (
              <div className="rise mt-4 flex items-center gap-2 text-[12px] text-dim">
                <span className="dots flex h-7 items-center gap-1 rounded-full bg-fill px-3">
                  <span className="size-1.5 rounded-full bg-dim" />
                  <span className="size-1.5 rounded-full bg-dim" />
                  <span className="size-1.5 rounded-full bg-dim" />
                </span>
                {thinking.tool && <span className="truncate">{thinking.tool}</span>}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 px-6 pt-1 pb-5">
          <div className="mx-auto w-full max-w-[720px]">
            {notice && (
              <div role="status" className="rise material mb-2 flex items-center gap-2 rounded-[10px] py-1 pr-1 pl-3 text-[12.5px]">
                <Icon name={notice.error ? "cross" : "check"} className="size-3.5 shrink-0 text-dim" />
                <span className="selectable min-w-0 flex-1 truncate">{notice.text}</span>
                {notice.path && (
                  <button type="button" onClick={() => void showInFolder(notice.path!).catch((err) => setNotice({ text: why(err), error: true }))} className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-accent hover:bg-hover">
                    <Icon name="folder" className="size-3.5" />
                    {finder}
                  </button>
                )}
                <button type="button" title="Dismiss" onClick={() => setNotice(null)} className="flex size-6 shrink-0 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-ink">
                  <Icon name="cross" className="size-3.5" />
                </button>
              </div>
            )}
            {error && <p className="mb-2 px-3 text-[12px] text-ink-2">Couldn't send: {error}</p>}
            {/* The composer, as Messages has it: one rounded field, what to attach on its left, Send on its right. */}
            <div className="rounded-[20px] border border-line-2 bg-panel p-1 transition-colors focus-within:border-dimmer">
              <div className="px-1">
                <PendingFiles
                  items={files.items}
                  onRemove={(key) => {
                    setError(null);
                    files.remove(key);
                  }}
                  onRetry={files.retry}
                />
              </div>
              <div className="flex items-end gap-1">
                <button
                  type="button"
                  title="Attach files, or paste or drop them here"
                  disabled={sending}
                  onClick={() => picker.current?.click()}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full text-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
                >
                  <Icon name="plus" className="size-[18px]" />
                </button>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    addFiles([...(e.target.files ?? [])]);
                    e.target.value = "";
                  }}
                />
                <textarea
                  ref={input}
                  rows={1}
                  value={text}
                  autoFocus
                  readOnly={sending}
                  placeholder={canSend ? "Message midna" : "Reconnecting…"}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                  className="selectable min-h-[20px] flex-1 resize-none bg-transparent px-1 py-1 text-[13.5px] leading-[1.45] outline-none placeholder:text-dimmer"
                />
                {controls}
                {stoppable ? (
                  <button type="button" title="Stop what midna is doing" disabled={!canSend} onClick={() => void submit("/stop")} className="flex size-7 shrink-0 items-center justify-center rounded-full bg-control text-ink transition-colors hover:bg-control-hover disabled:opacity-40">
                    <Icon name="stop" className="size-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    title={files.items.some((f) => !f.done && !f.error) ? "Send once the files are up (Return)" : "Send (Return). Shift-Return starts a new line; begin with /queue and it waits its turn."}
                    disabled={!sendable || !canSend || sending}
                    onClick={() => void submit()}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-ink transition-[background-color,opacity] disabled:bg-control disabled:text-dimmer"
                  >
                    {sending ? <Spinner className="size-3.5" /> : <Icon name="send" className="size-4" />}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        {dragging && (
          <div className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-[16px] border-2 border-dashed border-accent bg-bg/85 backdrop-blur-[2px]">
            <div className="flex flex-col items-center gap-2 text-center">
              <Icon name="paperclip" className="size-6 text-dim" />
              <p className="text-[14px] font-medium">Drop to attach</p>
              <p className="text-[12px] text-dim">Images and files go with your next message, up to {MAX_FILES}.</p>
            </div>
          </div>
        )}
      </div>
      <Viewer viewing={viewing} onClose={closeViewer} />
    </Media.Provider>
  );
}

/** How an approval ended, in words: "Allowed for 10 min by Justin's iPhone (telegram)". */
function approvalOutcome(a: Approval): string {
  const by = a.answeredBy ? ` by ${a.answeredBy}${a.answeredVia ? ` (${a.answeredVia})` : ""}` : "";
  if (a.state === "allowed") return `${a.answer === "allow_10_min" ? "Allowed for 10 min" : "Allowed"}${by}`;
  if (a.state === "denied") return `Denied${by}`;
  if (a.state === "expired") return "No answer in time, so no";
  return "No longer needed";
}

function LineView({
  line: l,
  onAnswer,
  canSend,
  approval,
  onApprove,
}: {
  line: Line;
  onAnswer: (option: string) => void;
  canSend: boolean;
  /** When the line asks for a device hands approval: its buttons answer it, and it says how it ended. */
  approval?: Approval;
  onApprove: (a: Approval, answer: ApprovalAnswer) => Promise<void>;
}) {
  const [answering, setAnswering] = useState(false);
  const files = l.attachments ?? [];
  if (l.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        {files.length > 0 && (
          <div className="max-w-[78%]">
            <Attachments items={files} align="end" />
          </div>
        )}
        {l.text && (
          <div title={`${time(l.at)}${l.client && l.client !== "desktop" ? ` · sent from ${l.client}` : ""}`} className={`selectable max-w-[78%] rounded-[18px] bg-primary px-3 py-1.5 text-[13.5px] leading-[1.45] whitespace-pre-wrap text-primary-ink transition-opacity ${l.pending ? "opacity-60" : ""}`}>
            {l.text}
          </div>
        )}
        {l.pending && <span className="px-1 text-[10.5px] text-dimmer">Sending…</span>}
      </div>
    );
  }

  // Every kind of line midna sends looks the same; its kind only decides how loudly it notifies.
  return (
    <div className="max-w-[86%]" title={time(l.at)}>
      {l.text && (
        <div className="text-[13.5px] leading-[1.5]">
          <Markdown text={l.text} />
        </div>
      )}
      {files.length > 0 && (
        <div className={l.text ? "mt-2" : ""}>
          <Attachments items={files} />
        </div>
      )}
      {approval ? (
        <div className="mt-2">
          {approval.state === "pending" ? (
            <div className="flex flex-wrap gap-1.5">
              {APPROVAL_OPTIONS.map((o) => (
                <button
                  key={o.answer}
                  type="button"
                  disabled={answering || !canSend}
                  onClick={() => {
                    setAnswering(true);
                    void onApprove(approval, o.answer).finally(() => setAnswering(false));
                  }}
                  className={`h-7 rounded-full px-3 text-[12.5px] transition-colors disabled:opacity-45 ${o.answer === "allow" ? "bg-primary font-medium text-primary-ink hover:brightness-110" : "bg-control hover:bg-control-hover"}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="text-[12px] text-dim">{approvalOutcome(approval)}</div>
          )}
        </div>
      ) : l.kind === "question" && l.options && l.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {l.options.map((o) => (
            <button
              key={o}
              type="button"
              disabled={l.answered || !canSend}
              onClick={() => onAnswer(o)}
              className="h-7 rounded-full bg-control px-3 text-[12.5px] text-accent transition-colors hover:bg-control-hover disabled:text-dim disabled:opacity-60"
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
