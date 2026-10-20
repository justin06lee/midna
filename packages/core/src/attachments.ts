import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { MAX_ATTACHMENT_BYTES, type Attachment } from "@midna/protocol";

/**
 * Files that go with messages, of any type: screenshots and charts midna
 * sends, PDFs and zips it made, photos and documents the user sends. The
 * bytes are kept in the database, beside the conversation they belong to, so
 * a message can be redrawn long after the file it came from was moved or
 * deleted — and a backup of midna.db holds them too.
 *
 * An attachment belongs to one outbox item (something midna said) or one
 * message (something the user said), at the place in its list the sender
 * gave it. Until then it is loose: uploaded and not yet sent, or staged by a
 * chat episode for the reply it is writing.
 */

interface Row {
  id: string;
  name: string;
  mime: string;
  size: number;
  caption: string | null;
  kind: Attachment["kind"] | null;
}

const COLUMNS = "id, name, mime, size, caption, kind";

const MB = 1024 * 1024;
const tooBig = (what: string, bytes: number) => new Error(`${what} is ${Math.ceil(bytes / MB)} MB — the most midna sends is ${MAX_ATTACHMENT_BYTES / MB} MB`);

/** Extension → MIME type. The first extension listed for a type is the one a nameless file gets. */
const BY_EXTENSION: Record<string, string> = {
  // images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".ico": "image/x-icon",
  ".psd": "image/vnd.adobe.photoshop",
  // documents
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".html": "text/html",
  ".htm": "text/html",
  ".rtf": "application/rtf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".pages": "application/vnd.apple.pages",
  ".numbers": "application/vnd.apple.numbers",
  ".key": "application/vnd.apple.keynote",
  ".epub": "application/epub+zip",
  ".ics": "text/calendar",
  ".vcf": "text/vcard",
  ".eml": "message/rfc822",
  // data and code
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".sql": "application/sql",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/x-typescript",
  ".tsx": "text/x-typescript",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".sh": "application/x-sh",
  ".css": "text/css",
  ".sqlite": "application/vnd.sqlite3",
  ".db": "application/vnd.sqlite3",
  ".wasm": "application/wasm",
  // archives
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".tar": "application/x-tar",
  ".bz2": "application/x-bzip2",
  ".xz": "application/x-xz",
  ".zst": "application/zstd",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  // audio and video
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  // fonts and programs
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".dmg": "application/x-apple-diskimage",
  ".pkg": "application/vnd.apple.installer+xml",
  ".deb": "application/vnd.debian.binary-package",
  ".rpm": "application/x-rpm",
  ".apk": "application/vnd.android.package-archive",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".iso": "application/x-iso9660-image",
  ".bin": "application/octet-stream",
};

const EXTENSION_FOR: Record<string, string> = {};
for (const [ext, mime] of Object.entries(BY_EXTENSION)) if (mime !== "application/octet-stream") EXTENSION_FOR[mime] ??= ext;

/** Containers whose name tells more than their bytes: a .docx, .xlsx or .epub is a zip inside. */
const CONTAINERS = new Set(["application/zip", "application/octet-stream"]);

/** What a file is, from its first bytes; an extension is only a claim. */
function sniff(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(0, 2) === "BM" && [12, 40, 52, 56, 108, 124].includes(b[14] ?? 0)) return "image/bmp";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "mif1", "msf1"].includes(brand)) return "image/heic";
    if (brand === "qt  ") return "video/quicktime";
    if (brand.startsWith("M4A")) return "audio/mp4";
    return "video/mp4";
  }
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (ascii(0, 4) === "PK\u0003\u0004" || ascii(0, 4) === "PK\u0005\u0006") return "application/zip";
  if (b[0] === 0x1f && b[1] === 0x8b) return "application/gzip";
  if (ascii(0, 6) === "7z¼¯'\u001c") return "application/x-7z-compressed";
  if (ascii(0, 4) === "Rar!") return "application/vnd.rar";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (ascii(0, 3) === "ID3") return "audio/mpeg";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (ascii(0, 16) === "SQLite format 3\u0000") return "application/vnd.sqlite3";
  return null;
}

/** The MIME type of a file, from its bytes, then its name, then what the sender claimed. */
export function mimeOf(name: string, data: Uint8Array, claimed?: string | null): string {
  const claim = claimed?.split(";")[0]!.trim().toLowerCase();
  const byName = BY_EXTENSION[extname(name).toLowerCase()];
  const sniffed = sniff(data);
  if (sniffed && !(CONTAINERS.has(sniffed) && byName)) return sniffed;
  return byName ?? (claim && claim !== "application/octet-stream" ? claim : "application/octet-stream");
}

/**
 * A name safe to show and to save under — no directories, no control
 * characters — whose extension says what the file is. When the bytes say for
 * sure (`known`), a file with no extension gets one, and an image named for
 * another image type (a PNG called photo.jpg) is renamed to match; a README
 * or a Makefile keeps its name.
 */
function cleanName(name: string, mime: string, known: boolean): string {
  let base = basename(name.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(-160);
  if (!base || base === "." || base === "..") base = mime.startsWith("image/") ? "image" : "file";
  const ext = extname(base);
  const want = EXTENSION_FOR[mime];
  if (!want || !known) return base;
  if (!ext) return base + want;
  const claimed = BY_EXTENSION[ext.toLowerCase()];
  if (claimed && claimed !== mime && claimed.startsWith("image/") && mime.startsWith("image/")) return base.slice(0, -ext.length) + want;
  return base;
}

const toAttachment = (r: Row): Attachment => ({
  id: r.id,
  kind: r.kind ?? (r.mime.startsWith("image/") ? "image" : "file"),
  name: r.name,
  mime: r.mime,
  size: r.size,
  caption: r.caption,
});

/** How the sender wants one file to go: under what name, with what caption, an image as a file. */
export interface AttachOptions {
  episodeId?: number;
  /** The name it arrives under, when not its own. */
  name?: string;
  caption?: string | null;
  /** "file" sends an image as a file. "image" only takes for image types. */
  as?: Attachment["kind"];
}

export class Attachments {
  constructor(private db: Database) {}

  /** Keep a file. Throws when it is empty or too big. */
  add(file: { data: Uint8Array; name: string; mime?: string | null; source?: string } & AttachOptions, now = Date.now()): Attachment {
    const name = file.name || "file";
    if (!file.data.byteLength) throw new Error(`${name} is empty`);
    if (file.data.byteLength > MAX_ATTACHMENT_BYTES) throw tooBig(name, file.data.byteLength);
    const mime = mimeOf(name, file.data, file.mime);
    const row = this.db
      .query(
        `INSERT INTO attachments (id, name, mime, size, data, source, episode_id, caption, kind, created_at)
         VALUES ($id, $name, $mime, $size, $data, $source, $episode, $caption, $kind, $now) RETURNING ${COLUMNS}`,
      )
      .get({
        id: "att_" + randomBytes(12).toString("base64url"),
        name: cleanName(file.name, mime, sniff(file.data) !== null),
        mime,
        size: file.data.byteLength,
        data: file.data,
        source: file.source ?? null,
        episode: file.episodeId ?? null,
        caption: file.caption?.trim() || null,
        kind: file.as === "file" ? "file" : null,
        now,
      }) as Row;
    return toAttachment(row);
  }

  /** Keep a copy of a file on this machine, of any type. */
  fromFile(path: string, opts: AttachOptions = {}): Attachment {
    let st;
    try {
      st = statSync(path);
    } catch {
      throw new Error(`no file at ${path}`);
    }
    if (!st.isFile()) throw new Error(`${path} isn't a file`);
    if (st.size > MAX_ATTACHMENT_BYTES) throw tooBig(path, st.size);
    return this.add({ data: new Uint8Array(readFileSync(path)), source: path, ...opts, name: opts.name || basename(path) });
  }

  /**
   * A new loose attachment with another one's bytes, going the way the
   * sender says now: how midna passes on a file already kept here, such as
   * a device's screenshot. Being new, it lines up with the other files of
   * its episode in the order they were attached.
   */
  copy(id: string, opts: AttachOptions = {}, now = Date.now()): Attachment {
    const src = this.db.query(`SELECT ${COLUMNS} FROM attachments WHERE id = $id`).get({ id }) as Row | null;
    if (!src) throw new Error(`no attachment ${id}`);
    const row = this.db
      .query(
        `INSERT INTO attachments (id, name, mime, size, data, source, episode_id, caption, kind, created_at)
         SELECT $new, $name, mime, size, data, source, $episode, $caption, $kind, $now FROM attachments WHERE id = $id RETURNING ${COLUMNS}`,
      )
      .get({
        id,
        new: "att_" + randomBytes(12).toString("base64url"),
        name: opts.name ? cleanName(opts.name, src.mime, src.mime !== "application/octet-stream") : src.name,
        episode: opts.episodeId ?? null,
        caption: opts.caption !== undefined ? opts.caption?.trim() || null : src.caption,
        kind: opts.as === "file" ? "file" : opts.as === "image" ? null : src.kind,
        now,
      }) as Row;
    return toAttachment(row);
  }

  get(id: string): Attachment | null {
    const r = this.db.query(`SELECT ${COLUMNS} FROM attachments WHERE id = $id`).get({ id }) as Row | null;
    return r ? toAttachment(r) : null;
  }

  /** The file and its bytes. */
  read(id: string): { attachment: Attachment; data: Uint8Array } | null {
    const r = this.db.query(`SELECT ${COLUMNS}, data FROM attachments WHERE id = $id`).get({ id }) as (Row & { data: Uint8Array }) | null;
    return r ? { attachment: toAttachment(r), data: r.data } : null;
  }

  /** Take back a loose attachment; one already sent with a message stays with it. */
  remove(id: string): "removed" | "sent" | "missing" {
    if (this.db.query("DELETE FROM attachments WHERE id = $id AND outbox_id IS NULL AND message_id IS NULL").run({ id }).changes) return "removed";
    return this.db.query("SELECT 1 FROM attachments WHERE id = $id").get({ id }) ? "sent" : "missing";
  }

  /** Delete loose attachments made before `before`: uploads never sent, files staged by a turn that failed. */
  sweep(before: number): number {
    return this.db.query("DELETE FROM attachments WHERE outbox_id IS NULL AND message_id IS NULL AND created_at < $b").run({ b: before }).changes;
  }

  /** What a chat episode attached to the reply it is still writing, in the order it attached them. */
  staged(episodeId: number): string[] {
    return (this.db.query("SELECT id FROM attachments WHERE episode_id = $e AND outbox_id IS NULL AND message_id IS NULL ORDER BY rowid").all({ e: episodeId }) as Array<{ id: string }>).map((r) => r.id);
  }

  /**
   * Hand loose attachments to what they were sent with, in the order given:
   * that order is the one every client shows. One already sent with
   * something else stays where it is; the ones that moved come back.
   */
  link(ids: string[], to: { outboxId: number } | { messageId: number }): Attachment[] {
    const stmt = this.db.query(
      `UPDATE attachments SET outbox_id = $o, message_id = $m, position = $p
       WHERE id = $id AND outbox_id IS NULL AND message_id IS NULL RETURNING ${COLUMNS}`,
    );
    const linked: Attachment[] = [];
    for (const id of ids) {
      const r = stmt.get({ id, o: "outboxId" in to ? to.outboxId : null, m: "messageId" in to ? to.messageId : null, p: linked.length }) as Row | null;
      if (r) linked.push(toAttachment(r));
    }
    return linked;
  }

  /** The attachments of each outbox item, by item id, in their order. */
  forOutbox(ids: number[]): Map<number, Attachment[]> {
    return this.grouped("outbox_id", ids);
  }

  /** The attachments of each user message, by message id, in their order. */
  forMessages(ids: number[]): Map<number, Attachment[]> {
    return this.grouped("message_id", ids);
  }

  private grouped(column: "outbox_id" | "message_id", ids: number[]): Map<number, Attachment[]> {
    const out = new Map<number, Attachment[]>();
    if (!ids.length) return out;
    const rows = this.db
      .query(`SELECT ${COLUMNS}, ${column} AS owner FROM attachments WHERE ${column} IN (SELECT value FROM json_each($ids)) ORDER BY position, rowid`)
      .all({ ids: JSON.stringify(ids) }) as Array<Row & { owner: number }>;
    for (const r of rows) {
      const list = out.get(r.owner) ?? [];
      list.push(toAttachment(r));
      out.set(r.owner, list);
    }
    return out;
  }
}
