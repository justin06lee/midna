import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_ATTACHMENT_BYTES, type Attachment } from "@midna/protocol";
import { remember, size } from "./media";
import { Icon, Spinner } from "./ui";

/**
 * Files on their way into a message — pasted, dropped or picked. Each starts
 * uploading the moment it is added, so it is usually there before the
 * message is; they go with it in the order they were added.
 */

/** As many as one message takes (SendMessage's limit). */
export const MAX_FILES = 10;
// Two at a time: WebKit keeps six connections per host, and the event stream and status polls need theirs.
const AT_ONCE = 2;

// What a file is, by its name, for the few ways one arrives without a type.
const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff",
  pdf: "application/pdf", zip: "application/zip", json: "application/json", txt: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", mp4: "video/mp4", mov: "video/quicktime",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const typeFor = (name: string) => TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "";

export interface Pending {
  key: string;
  file: File;
  /** An image's thumbnail. */
  preview: string | null;
  /** Bytes uploaded so far. */
  sent: number;
  done: Attachment | null;
  error: string | null;
  /** False when trying again can't help: the file is too big. */
  retryable: boolean;
}

export type Upload = (file: File, onProgress: (sent: number) => void, signal?: AbortSignal) => Promise<Attachment>;

interface Job {
  file: File;
  stop: AbortController;
  result: Promise<Attachment>;
  settle: { resolve: (a: Attachment) => void; reject: (e: unknown) => void };
}

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
let made = 0;

function job(file: File): Job {
  let settle!: Job["settle"];
  const result = new Promise<Attachment>((resolve, reject) => (settle = { resolve, reject }));
  result.catch(() => {}); // a failure shows on the file itself
  return { file, stop: new AbortController(), result, settle };
}

export function usePendingFiles(upload: Upload) {
  const [items, setItems] = useState<Pending[]>([]);
  const current = useRef(items);
  current.current = items;
  const jobs = useRef(new Map<string, Job>());
  const queue = useRef<string[]>([]);
  const running = useRef(0);

  const patch = useCallback((key: string, p: Partial<Pending>) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...p } : i))), []);

  const pump = useCallback(() => {
    while (running.current < AT_ONCE && queue.current.length) {
      const key = queue.current.shift()!;
      const j = jobs.current.get(key);
      if (!j) continue; // removed while it waited
      running.current++;
      upload(j.file, (sent) => patch(key, { sent }), j.stop.signal)
        .then(
          (a) => {
            remember(a.id, j.file);
            patch(key, { done: a, sent: j.file.size });
            j.settle.resolve(a);
          },
          (err) => {
            if (!j.stop.signal.aborted) patch(key, { error: why(err) });
            j.settle.reject(err);
          },
        )
        .finally(() => {
          running.current--;
          pump();
        });
    }
  }, [upload, patch]);

  /** Add files; answers how many didn't fit. */
  const add = useCallback(
    (files: File[]) => {
      const room = Math.max(0, MAX_FILES - current.current.length);
      const fresh: Pending[] = files.slice(0, room).map((file) => {
        const key = `f${++made}`;
        const j = job(file);
        jobs.current.set(key, j);
        const tooBig = file.size > MAX_ATTACHMENT_BYTES;
        if (tooBig) j.settle.reject(new Error("too big"));
        else queue.current.push(key);
        return {
          key,
          file,
          preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
          sent: 0,
          done: null,
          error: tooBig ? `over the ${MAX_ATTACHMENT_BYTES / 1048576} MB limit` : null,
          retryable: !tooBig,
        };
      });
      setItems((cur) => [...cur, ...fresh]);
      pump();
      return files.length - fresh.length;
    },
    [pump],
  );

  const remove = useCallback((key: string) => {
    jobs.current.get(key)?.stop.abort();
    jobs.current.delete(key);
    queue.current = queue.current.filter((k) => k !== key);
    setItems((cur) => {
      const gone = cur.find((i) => i.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return cur.filter((i) => i.key !== key);
    });
  }, []);

  const retry = useCallback(
    (key: string) => {
      const old = jobs.current.get(key);
      if (!old) return;
      jobs.current.set(key, job(old.file));
      queue.current.push(key);
      patch(key, { error: null, sent: 0, done: null });
      pump();
    },
    [patch, pump],
  );

  /** Every file uploaded, in the order added — or the first failure. */
  const ready = useCallback(() => Promise.all(current.current.map((i) => jobs.current.get(i.key)!.result)), []);

  /** Out of the composer and into a message; `back` puts them where they were if it didn't go, `done` lets them go. */
  const take = useCallback(() => {
    const taken = current.current;
    setItems([]);
    return {
      back: () => setItems((cur) => [...taken, ...cur]),
      done: () => {
        for (const i of taken) {
          if (i.preview) URL.revokeObjectURL(i.preview);
          jobs.current.delete(i.key);
        }
      },
    };
  }, []);

  // Stop whatever is still going when the chat goes away.
  useEffect(() => () => jobs.current.forEach((j) => j.stop.abort()), []);

  return { items, add, remove, retry, ready, take };
}

/** The files waiting in the composer: thumbnails and chips, each with how far its upload has got, and a cross. */
export function PendingFiles({ items, onRemove, onRetry }: { items: Pending[]; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 pt-1 pb-1.5">
      {items.map((p) => (
        <PendingItem key={p.key} p={p} onRemove={() => onRemove(p.key)} onRetry={() => onRetry(p.key)} />
      ))}
    </div>
  );
}

function PendingItem({ p, onRemove, onRetry }: { p: Pending; onRemove: () => void; onRetry: () => void }) {
  const [thumb, setThumb] = useState(!!p.preview);
  const uploading = !p.done && !p.error;
  const share = p.done ? 1 : p.file.size ? p.sent / p.file.size : 0;
  const bar = uploading && (
    <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/10">
      <div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${Math.max(4, share * 100)}%` }} />
    </div>
  );
  const cross = (
    <button type="button" title="Remove" onClick={onRemove} className="absolute top-1 right-1 flex size-[18px] items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80">
      <Icon name="cross" className="size-3" />
    </button>
  );
  const title = `${p.file.name} · ${size(p.file.size)}${p.error ? ` — ${p.error}` : uploading ? " — uploading" : ""}`;

  if (thumb && p.preview) {
    return (
      <div title={title} className="relative size-14 shrink-0 overflow-hidden rounded-[9px] border border-line bg-sunken">
        <img src={p.preview} alt={p.file.name} draggable={false} onError={() => setThumb(false)} className={`size-full object-cover ${uploading ? "opacity-60" : ""}`} />
        {p.error && (
          <button type="button" title={p.retryable ? `${p.error} — try again` : p.error} onClick={p.retryable ? onRetry : undefined} className="absolute inset-0 flex items-center justify-center bg-black/55 text-white">
            <Icon name={p.retryable ? "refresh" : "cross"} className="size-4" />
          </button>
        )}
        {bar}
        {cross}
      </div>
    );
  }
  return (
    <div title={title} className="relative flex h-14 max-w-[230px] min-w-[150px] shrink-0 items-center gap-2 overflow-hidden rounded-[9px] border border-line bg-panel pr-7 pl-2.5">
      {uploading ? <Spinner className="size-4 shrink-0 text-dim" /> : <Icon name="file" className="size-4 shrink-0 text-dim" />}
      <div className="min-w-0 text-[12px] leading-[1.35]">
        <div className="truncate font-medium">{p.file.name}</div>
        <div className="truncate text-[11px] text-dimmer">
          {p.error ? (
            <>
              <span className="text-ink-2">{p.error}</span>
              {p.retryable && (
                <button type="button" onClick={onRetry} className="ml-1.5 font-medium text-ink underline-offset-2 hover:underline">
                  Try again
                </button>
              )}
            </>
          ) : uploading ? (
            `${Math.round(share * 100)}% of ${size(p.file.size)}`
          ) : (
            size(p.file.size)
          )}
        </div>
      </div>
      {bar}
      {cross}
    </div>
  );
}
