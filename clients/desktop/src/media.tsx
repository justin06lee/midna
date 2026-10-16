import { createContext, useContext, useEffect, useState } from "react";
import type { Attachment } from "@midna/protocol";
import { Icon, Spinner } from "./ui";

/**
 * Images and files in the conversation. Attachment bytes need the device
 * token, which an <img> can't send, so each is fetched once and drawn from
 * an object URL; images on the web are drawn straight from their URL. Any
 * image opens full size in the viewer.
 */

export interface Viewing {
  src: string;
  name: string;
}

export const Media = createContext<{ load: (id: string) => Promise<Blob>; open: (v: Viewing) => void } | null>(null);

interface Loaded {
  src: string;
  w: number;
  h: number;
}

// One fetch per attachment for the life of the window: an attachment never changes.
const loaded = new Map<string, Promise<Loaded>>();

/** An attachment as an object URL, with the image's own size so it is drawn at the right size from the start. */
function loadImage(id: string, load: (id: string) => Promise<Blob>): Promise<Loaded> {
  let image = loaded.get(id);
  if (!image) {
    image = load(id).then(
      (blob) =>
        new Promise<Loaded>((resolve, reject) => {
          const src = URL.createObjectURL(blob);
          const probe = new Image();
          // An SVG without a size reports 0×0: give it a square.
          probe.onload = () => resolve({ src, w: probe.naturalWidth || 300, h: probe.naturalHeight || 300 });
          probe.onerror = () => reject(new Error("this app can't show that kind of image"));
          probe.src = src;
        }),
    );
    image.catch(() => loaded.delete(id)); // try again the next time it's drawn
    loaded.set(id, image);
  }
  return image;
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** What went with a line: images inline, files as chips. */
export function Attachments({ items, align = "start" }: { items: Attachment[]; align?: "start" | "end" }) {
  if (!items.length) return null;
  const images = items.filter((a) => a.kind === "image");
  const files = items.filter((a) => a.kind !== "image");
  return (
    <div className={`flex flex-col gap-1.5 ${align === "end" ? "items-end" : "items-start"}`}>
      {images.length > 0 && (
        <div className={`flex flex-wrap gap-1.5 ${align === "end" ? "justify-end" : ""}`}>
          {images.map((a) => (
            <AttachedImage key={a.id} a={a} single={images.length === 1} />
          ))}
        </div>
      )}
      {files.map((a) => (
        <div key={a.id} title={`${a.name} · ${a.mime}`} className="flex max-w-[320px] items-center gap-2 rounded-[10px] border border-line bg-panel px-2.5 py-1.5 text-[12.5px]">
          <Icon name="file" className="size-4 shrink-0 text-dim" />
          <span className="truncate font-medium">{a.name}</span>
          <span className="shrink-0 text-dimmer">{size(a.size)}</span>
        </div>
      ))}
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
      (err) => alive && setFailed((err as Error).message),
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
    <button type="button" title={a.name} onClick={() => media?.open({ src: image.src, name: a.name })} className="block max-w-full cursor-zoom-in overflow-hidden rounded-[10px] border border-line bg-sunken outline-none focus-visible:shadow-[0_0_0_3px_var(--focus)]">
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
      onClick={() => media?.open({ src, name: alt || src })}
      className="my-1.5 block max-h-[320px] max-w-[min(100%,440px)] cursor-zoom-in rounded-[10px] border border-line"
    />
  );
}

/** One image at full size, over everything. Escape, the cross or a click outside closes it. */
export function Viewer({ viewing, onClose }: { viewing: Viewing | null; onClose: () => void }) {
  useEffect(() => {
    if (!viewing) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [viewing, onClose]);
  if (!viewing) return null;
  return (
    <div role="dialog" aria-label={viewing.name} onClick={onClose} className="rise fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm">
      <div className="flex h-12 shrink-0 items-center gap-3 pr-3 pl-24 text-[12.5px] text-white/80" data-tauri-drag-region>
        <span className="min-w-0 flex-1 truncate" data-tauri-drag-region>
          {viewing.name}
        </span>
        <button type="button" title="Close (Esc)" onClick={onClose} className="flex size-8 items-center justify-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white">
          <Icon name="cross" className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 pb-8">
        <img src={viewing.src} alt={viewing.name} onClick={(e) => e.stopPropagation()} className="max-h-full max-w-full rounded-[6px] object-contain shadow-2xl" />
      </div>
    </div>
  );
}
