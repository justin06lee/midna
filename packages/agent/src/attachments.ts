import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttachOptions, Store } from "@midna/core";
import { MAX_ATTACHMENT_BYTES, type Attachment } from "@midna/protocol";

/**
 * How what the brain points at becomes something the user can see: a file
 * of any type on this machine, or a URL, kept as an attachment. The brain
 * sees the user's attachments the other way round, as files in its
 * workspace.
 */

/** A file to send: a path, URL or attachment id, or one with the name, caption and form the brain wants it to have. */
export type FileRef = string | { file: string; name?: string; caption?: string; as?: "image" | "file" };

const isUrl = (ref: string) => /^https?:\/\//i.test(ref);
/** A file already kept in midna, such as a device's screenshot. */
const ATTACHMENT_ID = /^att_[\w-]+$/;

/** A path on this machine, from "/abs", "~/rel" or "file:///abs"; null for anything else. */
function localPath(ref: string): string | null {
  const r = ref.trim();
  if (/^file:\/\//i.test(r)) return fileURLToPath(r);
  if (r === "~" || r.startsWith("~/")) return join(homedir(), r.slice(1));
  return isAbsolute(r) ? r : null;
}

/** Keep a file on this machine, or download a URL, as an attachment; an attachment's id sends that one on. */
export async function attach(store: Store, ref: FileRef, opts: { episodeId?: number } = {}): Promise<Attachment> {
  const { file, ...how } = typeof ref === "string" ? { file: ref } : ref;
  const options: AttachOptions = { ...opts, ...how };
  if (ATTACHMENT_ID.test(file.trim())) return store.attachments.copy(file.trim(), options);
  if (isUrl(file)) {
    const { data, name, mime } = await download(file);
    return store.attachments.add({ data, mime, source: file, ...options, name: how.name || name });
  }
  const path = localPath(file);
  if (!path) throw new Error(`"${file}" isn't an absolute path or an http(s) URL`);
  return store.attachments.fromFile(path, options);
}

async function download(url: string): Promise<{ data: Uint8Array; name: string; mime: string | null }> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "midna" } });
  } catch (err) {
    throw new Error(`couldn't fetch ${url}: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) throw new Error(`couldn't fetch ${url}: ${res.status} ${res.statusText}`);
  const tooBig = () => new Error(`${url} is over ${MAX_ATTACHMENT_BYTES / 1048576} MB — the most midna sends`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_ATTACHMENT_BYTES) {
    await res.body.cancel();
    throw tooBig();
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ATTACHMENT_BYTES) {
      await reader.cancel();
      throw tooBig();
    }
    parts.push(value);
  }
  const data = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    data.set(p, at);
    at += p.byteLength;
  }
  const disposition = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get("content-disposition") ?? "")?.[1];
  const fromPath = decodeURIComponent(basename(new URL(url).pathname));
  return { data, name: disposition ? decodeURIComponent(disposition) : fromPath, mime: res.headers.get("content-type") };
}

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;

/**
 * Markdown images that point at files on this machine (`![chart](/tmp/c.png)`)
 * can't be drawn anywhere else: keep each file as an attachment and take the
 * markup out of the text. Ones that point at the web stay, for clients to
 * draw; ones whose file isn't there stay too, so nothing vanishes silently.
 */
export function liftLocalImages(store: Store, text: string, opts: { episodeId?: number } = {}): { text: string; attachments: string[] } {
  const attachments: string[] = [];
  const out = text.replace(MARKDOWN_IMAGE, (whole, _alt: string, angled: string | undefined, bare: string | undefined) => {
    const path = localPath(angled ?? bare ?? "");
    if (!path) return whole;
    try {
      attachments.push(store.attachments.fromFile(path, opts).id);
      return "";
    } catch {
      return whole;
    }
  });
  if (!attachments.length) return { text, attachments };
  return { text: out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), attachments };
}

/**
 * Where the brain can open something the user sent: a copy in its
 * workspace under the file's own name (attachments/<id>/<name>), written the
 * first time it is asked for.
 */
export function workspaceCopy(store: Store, workspace: string, a: Attachment): string | null {
  const dir = join(workspace, "attachments", a.id);
  const path = join(dir, a.name);
  if (existsSync(path)) return path;
  const file = store.attachments.read(a.id);
  if (!file) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, file.data);
  return path;
}
