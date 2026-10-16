import { createContext, useContext, useEffect, useState, type ContextType, type MouseEvent } from "react";
import type { Attachment } from "@midna/protocol";
import { openInApp, openUrl, saveToDownloads } from "./host";
import { Icon, Spinner } from "./ui";

/**
 * Images and files in the conversation. Attachment bytes need the device
 * token, which an <img> can't send, so each is fetched once and drawn from
 * an object URL; images on the web are drawn straight from their URL. Any
 * image, and any PDF, opens full size in the viewer; every attachment can be
 * saved to Downloads or opened in its own app.
 */

export interface Viewing {
  src: string;
  name: string;
  /** A PDF is drawn by WebKit's own viewer, in a frame. */
  kind: "image" | "pdf";
  /** What Download and Open act on; an image from the web has none. */
  attachment?: Attachment;
  /** An image from the web, which opens in the browser instead. */
  url?: string;
}

/** Something to tell the user about a file: where it was saved, or why it wasn't. */
export interface Notice {
  text: string;
  /** Where it went, for Show in Finder. */
  path?: string | null;
  error?: boolean;
}

export const Media = createContext<{ load: (id: string) => Promise<Blob>; view: (v: Viewing) => void; notice: (n: Notice) => void } | null>(null);
type Actions = NonNullable<ContextType<typeof Media>>;

// One fetch per attachment for the life of the window: an attachment never changes.
const blobs = new Map<string, Promise<Blob>>();
const urls = new Map<string, Promise<string>>();

function attachmentBlob(id: string, load: (id: string) => Promise<Blob>): Promise<Blob> {
  let blob = blobs.get(id);
  if (!blob) {
    blob = load(id);
    blob.catch(() => blobs.delete(id)); // try again the next time it's wanted
    blobs.set(id, blob);
  }
  return blob;
}

function objectUrl(id: string, load: (id: string) => Promise<Blob>): Promise<string> {
  let url = urls.get(id);
  if (!url) {
    url = attachmentBlob(id, load).then((b) => URL.createObjectURL(b));
    url.catch(() => urls.delete(id));
    urls.set(id, url);
  }
  return url;
}

/** A file this window just uploaded: drawn from what it already has rather than fetched back. */
export function remember(id: string, file: Blob): void {
  if (!blobs.has(id)) blobs.set(id, Promise.resolve(file));
}

interface Loaded {
  src: string;
  w: number;
  h: number;
}
const images = new Map<string, Promise<Loaded>>();

/** An attachment as an object URL, with the image's own size so it is drawn at the right size from the start. */
function loadImage(id: string, load: (id: string) => Promise<Blob>): Promise<Loaded> {
  let image = images.get(id);
  if (!image) {
    image = objectUrl(id, load).then(
      (src) =>
        new Promise<Loaded>((resolve, reject) => {
          const probe = new Image();
          // An SVG without a size reports 0×0: give it a square.
          probe.onload = () => resolve({ src, w: probe.naturalWidth || 300, h: probe.naturalHeight || 300 });
          probe.onerror = () => reject(new Error("this app can't show that kind of image"));
          probe.src = src;
        }),
    );
    image.catch(() => images.delete(id));
    images.set(id, image);
  }
  return image;
}

export const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isPdf = (a: Attachment) => a.mime === "application/pdf" || /\.pdf$/i.test(a.name);

/** Save an attachment to Downloads, and say where it went. */
async function download(m: Actions, a: Attachment): Promise<void> {
  try {
    const path = await saveToDownloads(a.name, await attachmentBlob(a.id, m.load));
    m.notice({ text: `Saved ${path ? path.split(/[/\\]/).pop() : a.name} to Downloads`, path });
  } catch (err) {
    m.notice({ text: `Couldn't save ${a.name}: ${why(err)}`, error: true });
  }
}

/** Open an attachment in the app the system picks for it. */
async function launch(m: Actions, a: Attachment): Promise<void> {
  try {
    await openInApp(a.id, a.name, await attachmentBlob(a.id, m.load));
  } catch (err) {
    m.notice({ text: `Couldn't open ${a.name}: ${why(err)}`, error: true });
  }
}

/** A PDF in the viewer; anything else in its own app. */
async function show(m: Actions, a: Attachment): Promise<void> {
  if (!isPdf(a)) return launch(m, a);
  try {
    m.view({ kind: "pdf", src: await objectUrl(a.id, m.load), name: a.name, attachment: a });
  } catch (err) {
    m.notice({ text: `Couldn't load ${a.name}: ${why(err)}`, error: true });
  }
}

/** What went with a line, in the order it was sent: a run of images shares a row, each file is a chip in its place. */
export function Attachments({ items, align = "start" }: { items: Attachment[]; align?: "start" | "end" }) {
  if (!items.length) return null;
  const runs: Attachment[][] = [];
  for (const a of items) {
    const last = runs.at(-1);
    if (a.kind === "image" && last?.[0]?.kind === "image") last.push(a);
    else runs.push([a]);
  }
  return (
    <div className={`flex flex-col gap-1.5 ${align === "end" ? "items-end" : "items-start"}`}>
      {runs.map((run) =>
        run[0]!.kind === "image" ? (
          <div key={run[0]!.id} className={`flex flex-wrap gap-1.5 ${align === "end" ? "justify-end" : ""}`}>
            {run.map((a) => (
              <AttachedImage key={a.id} a={a} single={run.length === 1} />
            ))}
          </div>
        ) : (
          <FileChip key={run[0]!.id} a={run[0]!} />
        ),
      )}
    </div>
  );
}

/** A file: click to open it (a PDF opens here), or save it. */
function FileChip({ a }: { a: Attachment }) {
  const media = useContext(Media);
  const [busy, setBusy] = useState<"open" | "save" | null>(null);
  const act = (what: "open" | "save", run: (m: Actions, a: Attachment) => Promise<void>) => async (e: MouseEvent) => {
    e.stopPropagation();
    if (!media || busy) return;
    setBusy(what);
    await run(media, a);
    setBusy(null);
  };
  return (
    <div title={`${a.name} · ${a.mime}`} className="flex max-w-[340px] items-center rounded-[10px] border border-line bg-panel text-[12.5px]">
      <button type="button" onClick={act("open", show)} className="flex min-w-0 flex-1 items-center gap-2 rounded-l-[9px] py-1.5 pr-1.5 pl-2.5 text-left hover:bg-hover">
        {busy === "open" ? <Spinner className="size-4 shrink-0 text-dim" /> : <Icon name="file" className="size-4 shrink-0 text-dim" />}
        <span className="truncate font-medium">{a.name}</span>
        <span className="shrink-0 text-dimmer">{size(a.size)}</span>
      </button>
      <button type="button" title="Save to Downloads" onClick={act("save", download)} className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-ink">
        {busy === "save" ? <Spinner /> : <Icon name="download" className="size-3.5" />}
      </button>
    </div>
  );
}

/**
 * A lone image is shown whole, up to 440×320; several share a row at one
 * height, cropped to at most 240 wide.
 */
function AttachedImage({ a, single }: { a: Attachment; single: boolean }) {
  const media = useContext(Media);
  const [image, setImage] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!media) return;
    let alive = true;
    loadImage(a.id, media.load).then(
      (i) => alive && setImage(i),
      (err) => alive && setFailed(why(err)),
    );
    return () => {
      alive = false;
    };
  }, [a.id, media]);

  if (failed) {
    return (
      <div title={failed} className="flex h-[72px] w-[200px] flex-col items-center justify-center gap-1 rounded-[10px] border border-line bg-sunken px-3 text-center text-[11.5px] text-dim">
        <span className="truncate font-medium text-ink-2">{a.name}</span>
        couldn't load this image
      </div>
    );
  }
  if (!image) {
    return (
      <div className={`flex items-center justify-center rounded-[10px] border border-line bg-sunken text-dimmer ${single ? "h-[180px] w-[260px]" : "h-[150px] w-[150px]"}`}>
        <Spinner />
      </div>
    );
  }
  const ratio = image.w / image.h;
  const width = single ? Math.min(440, image.w, 320 * ratio) : Math.max(80, Math.min(240, 150 * ratio));
  const height = single ? width / ratio : 150;
  return (
    <button type="button" title={a.name} onClick={() => media?.view({ kind: "image", src: image.src, name: a.name, attachment: a })} className="block max-w-full cursor-zoom-in overflow-hidden rounded-[10px] border border-line bg-sunken outline-none focus-visible:shadow-[0_0_0_3px_var(--focus)]">
      <img src={image.src} alt={a.name} draggable={false} style={{ width, height }} className="block max-w-full object-cover" />
    </button>
  );
}

/** An image the Markdown points at: drawn from the web, or noted when it lives where the app can't reach. */
export function WebImage({ src, alt }: { src: string; alt: string }) {
  const media = useContext(Media);
  const [failed, setFailed] = useState(false);
  const web = /^https?:\/\//i.test(src);
  if (!web || failed) {
    return (
      <span title={src} className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-[8px] border border-line bg-sunken px-2 py-1 align-middle text-[12px] text-dim">
        <Icon name="image" className="size-3.5 shrink-0" />
        <span className="truncate">{failed ? `couldn't load ${alt || "image"}` : `${alt || "an image"} on midna's machine — ask midna to attach it`}</span>
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      title={alt || src}
      loading="lazy"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(true)}
      onClick={() => media?.view({ kind: "image", src, name: alt || src, url: src })}
      className="my-1.5 block max-h-[320px] max-w-[min(100%,440px)] cursor-zoom-in rounded-[10px] border border-line"
    />
  );
}

function ViewerButton({ icon, label, title, onClick, busy }: { icon: "download" | "external" | "cross"; label?: string; title: string; onClick: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg text-white/80 hover:bg-white/10 hover:text-white ${label ? "px-2.5" : "w-8"}`}
    >
      {busy ? <Spinner className="size-4" /> : <Icon name={icon} className="size-4" />}
      {label}
    </button>
  );
}

/** One image or PDF at full size, over everything. Escape, the cross or a click outside closes it. */
export function Viewer({ viewing, onClose }: { viewing: Viewing | null; onClose: () => void }) {
  const media = useContext(Media);
  const [busy, setBusy] = useState<"save" | "open" | null>(null);
  useEffect(() => {
    if (!viewing) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [viewing, onClose]);
  if (!viewing) return null;
  const a = viewing.attachment;
  const act = (what: "save" | "open", run: (m: Actions, a: Attachment) => Promise<void>) => async () => {
    if (!media || !a || busy) return;
    setBusy(what);
    await run(media, a);
    setBusy(null);
  };
  return (
    <div role="dialog" aria-label={viewing.name} onClick={onClose} className="rise fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm">
      <div className="flex h-12 shrink-0 items-center gap-1 pr-3 pl-24 text-[12.5px] text-white/80" data-tauri-drag-region>
        <span className="min-w-0 flex-1 truncate pr-2" data-tauri-drag-region>
          {viewing.name}
        </span>
        {a && <ViewerButton icon="download" label="Download" title="Save to Downloads" busy={busy === "save"} onClick={act("save", download)} />}
        {a && <ViewerButton icon="external" label="Open" title={viewing.kind === "pdf" ? "Open in Preview, or whatever opens PDFs" : "Open in its own app"} busy={busy === "open"} onClick={act("open", launch)} />}
        {viewing.url && <ViewerButton icon="external" label="Open in browser" title={viewing.url} onClick={() => void openUrl(viewing.url!)} />}
        <ViewerButton icon="cross" title="Close (Esc)" onClick={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 pb-8">
        {viewing.kind === "pdf" ? (
          <iframe src={viewing.src} title={viewing.name} onClick={(e) => e.stopPropagation()} className="h-full w-full max-w-[960px] rounded-[6px] bg-white shadow-2xl" />
        ) : (
          <img src={viewing.src} alt={viewing.name} onClick={(e) => e.stopPropagation()} className="max-h-full max-w-full rounded-[6px] object-contain shadow-2xl" />
        )}
      </div>
    </div>
  );
}
