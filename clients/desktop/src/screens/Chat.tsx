import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "../markdown";
import { Icon, Mark, Spinner } from "../ui";
import type { Line } from "../useMidna";

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

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
}: {
  lines: Line[];
  thinking: { tool: string | null } | null;
  canSend: boolean;
  send: (text: string, replyTo?: number) => Promise<void>;
  loadOlder: () => Promise<void>;
  olderExhausted: boolean;
  draft?: string | null;
  onDraftUsed?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Something to say, handed over from another screen.
  useEffect(() => {
    if (!draft) return;
    setText(draft);
    onDraftUsed?.();
    input.current?.focus();
  }, [draft, onDraftUsed]);

  // Keep to the bottom as lines arrive — unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, thinking]);

  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 40 && !olderExhausted) {
      const before = el.scrollHeight;
      void loadOlder().then(() => requestAnimationFrame(() => (el.scrollTop += el.scrollHeight - before)));
    }
  };

  const submit = async (value = text, replyTo?: number) => {
    const t = value.trim();
    if (!t) return;
    setError(null);
    stick.current = true;
    if (!replyTo) setText("");
    try {
      await send(t, replyTo);
    } catch (err) {
      if (!replyTo) setText(t);
      setError((err as Error).message);
    }
  };

  // Grow the box with what's typed, up to a point.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-6 pt-4 pb-6">
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
            const gap = prev && !newDay && (prev.role !== l.role || l.at - prev.at > 5 * 60_000);
            return (
              <Fragment key={l.key}>
                {newDay && (
                  <div className="my-5 flex items-center gap-3 text-[11px] font-medium tracking-wide text-dimmer uppercase">
                    <span className="h-px flex-1 bg-line" />
                    {day(l.at)}
                    <span className="h-px flex-1 bg-line" />
                  </div>
                )}
                <div className={gap ? "mt-4" : "mt-1.5"}>
                  <LineView line={l} onAnswer={(option) => void submit(option, l.outboxId)} canSend={canSend} />
                </div>
              </Fragment>
            );
          })}
          {thinking && (
            <div className="rise mt-4 flex items-center gap-2 text-[12.5px] text-dim">
              <span className="dots flex gap-0.5 text-[18px] leading-none">
                <span>·</span>
                <span>·</span>
                <span>·</span>
              </span>
              {thinking.tool ? <span>using <span className="font-mono text-[11.5px] text-ink-2">{thinking.tool}</span></span> : "thinking"}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-6 pt-1 pb-5">
        <div className="mx-auto w-full max-w-[720px]">
          {error && <p className="mb-2 text-[12px] text-ink-2">Couldn't send: {error}</p>}
          <div className="field flex items-end gap-2 rounded-[14px] py-1.5 pr-1.5 pl-3.5">
            <textarea
              ref={input}
              rows={1}
              value={text}
              autoFocus
              placeholder={canSend ? "Message midna" : "Reconnecting…"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
              className="selectable min-h-[22px] flex-1 resize-none bg-transparent py-[5px] text-[13.5px] leading-[1.45] outline-none placeholder:text-dimmer"
            />
            <button
              type="button"
              title="Send (Enter)"
              disabled={!text.trim() || !canSend}
              onClick={() => void submit()}
              className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-ink transition-opacity disabled:opacity-25"
            >
              <Icon name="send" className="size-4" />
            </button>
          </div>
          <p className="mt-1.5 px-1 text-[11px] text-dimmer">Enter to send · Shift+Enter for a new line</p>
        </div>
      </div>
    </div>
  );
}

function LineView({ line: l, onAnswer, canSend }: { line: Line; onAnswer: (option: string) => void; canSend: boolean }) {
  if (l.role === "user") {
    return (
      <div className="flex flex-col items-end">
        <div className={`selectable max-w-[78%] rounded-[16px] rounded-br-[5px] bg-primary px-3.5 py-2 text-[13.5px] leading-[1.45] whitespace-pre-wrap text-primary-ink ${l.pending ? "opacity-60" : ""}`}>
          {l.text}
        </div>
        <span className="mt-0.5 px-1 text-[10.5px] text-dimmer">
          {l.pending ? <Spinner className="inline size-2.5" /> : time(l.at)}
          {l.client && l.client !== "desktop" && ` · via ${l.client}`}
        </span>
      </div>
    );
  }

  const aside = l.kind && l.kind !== "message";
  const label = l.kind === "question" ? "question" : l.priority === "urgent" ? "urgent" : l.priority === "fyi" ? "fyi" : "note";
  return (
    <div className={`max-w-[86%] ${aside ? `border-l-2 pl-3 ${l.priority === "urgent" ? "border-ink" : "border-line-2"}` : ""}`}>
      {aside && <div className={`mb-0.5 text-[10.5px] font-medium tracking-wide uppercase ${l.priority === "urgent" ? "text-ink" : "text-dimmer"}`}>{label} · {time(l.at)}</div>}
      <div className={`text-[13.5px] leading-[1.55] ${l.priority === "fyi" ? "text-ink-2" : ""}`}>
        <Markdown text={l.text} />
      </div>
      {l.kind === "question" && l.options && l.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {l.options.map((o) => (
            <button
              key={o}
              type="button"
              disabled={l.answered || !canSend}
              onClick={() => onAnswer(o)}
              className="h-7 rounded-full border border-line-2 bg-panel px-3 text-[12.5px] font-medium transition-colors hover:bg-sunken disabled:opacity-45"
            >
              {o}
            </button>
          ))}
        </div>
      )}
      {!aside && <div className="mt-0.5 text-[10.5px] text-dimmer">{time(l.at)}</div>}
    </div>
  );
}
