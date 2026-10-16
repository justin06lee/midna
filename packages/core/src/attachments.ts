import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { MAX_ATTACHMENT_BYTES, type Attachment } from "@midna/protocol";

/**
 * Files that go with messages: screenshots and charts midna sends, photos the
 * user sends. The bytes are kept in the database, beside the conversation
 * they belong to, so a message can be redrawn long after the file it came
 * from was moved or deleted — and a backup of midna.db holds them too.
 *
 * An attachment belongs to one outbox item (something midna said) or one
 * message (something the user said). Until then it is loose: uploaded and
 * not yet sent, or staged by a chat episode for the reply it is writing.
 */

interface Row {
  id: string;
  name: string;
  mime: string;
  size: number;
}

const COLUMNS = "id, name, mime, size";

const BY_EXTENSION: Record<string, string> = {
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
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

const EXTENSION_FOR: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/heic": ".heic",
  "image/avif": ".avif",
  "application/pdf": ".pdf",
};

/** What a file is, from its first bytes; an extension is only a claim. */
function sniff(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 2) === "BM") return "image/bmp";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "mif1", "msf1"].includes(brand)) return "image/heic";
  }
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  return null;
}

/** The MIME type of a file, from its bytes, then its name, then what the sender claimed. */
export function mimeOf(name: string, data: Uint8Array, claimed?: string | null): string {
  const claim = claimed?.split(";")[0]!.trim().toLowerCase();
  return sniff(data) ?? BY_EXTENSION[extname(name).toLowerCase()] ?? (claim && claim !== "application/octet-stream" ? claim : "application/octet-stream");
}

/** A name safe to show and to save under: no directories, no control characters. */
function cleanName(name: string, mime: string): string {
  const base = basename(name.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(-120);
  if (base && base !== "." && base !== "..") return base;
  return `${mime.startsWith("image/") ? "image" : "file"}${EXTENSION_FOR[mime] ?? ""}`;
}

const toAttachment = (r: Row): Attachment => ({ id: r.id, kind: r.mime.startsWith("image/") ? "image" : "file", name: r.name, mime: r.mime, size: r.size });

export class Attachments {
  constructor(private db: Database) {}

  /** Keep a file. Throws when it is empty or too big. */
  add(file: { data: Uint8Array; name: string; mime?: string | null; source?: string; episodeId?: number }, now = Date.now()): Attachment {
    if (!file.data.byteLength) throw new Error(`${file.name || "that file"} is empty`);
    if (file.data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name || "that file"} is ${Math.ceil(file.data.byteLength / 1048576)} MB — the most midna sends is ${MAX_ATTACHMENT_BYTES / 1048576} MB`);
    const mime = mimeOf(file.name, file.data, file.mime);
    const row = this.db
      .query(
        `INSERT INTO attachments (id, name, mime, size, data, source, episode_id, created_at)
         VALUES ($id, $name, $mime, $size, $data, $source, $episode, $now) RETURNING ${COLUMNS}`,
      )
      .get({
        id: "att_" + randomBytes(12).toString("base64url"),
        name: cleanName(file.name, mime),
        mime,
        size: file.data.byteLength,
        data: file.data,
        source: file.source ?? null,
        episode: file.episodeId ?? null,
        now,
      }) as Row;
    return toAttachment(row);
  }

  /** Keep a copy of a file on this machine. */
  fromFile(path: string, opts: { episodeId?: number } = {}): Attachment {
    let st;
    try {
      st = statSync(path);
    } catch {
      throw new Error(`no file at ${path}`);
    }
    if (!st.isFile()) throw new Error(`${path} isn't a file`);
    if (st.size > MAX_ATTACHMENT_BYTES) throw new Error(`${path} is ${Math.ceil(st.size / 1048576)} MB — the most midna sends is ${MAX_ATTACHMENT_BYTES / 1048576} MB`);
    return this.add({ data: new Uint8Array(readFileSync(path)), name: basename(path), source: path, ...opts });
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

  /** What a chat episode attached to the reply it is still writing. */
  staged(episodeId: number): string[] {
    return (this.db.query("SELECT id FROM attachments WHERE episode_id = $e AND outbox_id IS NULL AND message_id IS NULL ORDER BY rowid").all({ e: episodeId }) as Array<{ id: string }>).map((r) => r.id);
  }

  /**
   * Hand loose attachments to what they were sent with. One already sent
   * with something else stays where it is; the ones that moved come back.
   */
  link(ids: string[], to: { outboxId: number } | { messageId: number }): Attachment[] {
    const stmt = this.db.query(
      `UPDATE attachments SET outbox_id = $o, message_id = $m WHERE id = $id AND outbox_id IS NULL AND message_id IS NULL RETURNING ${COLUMNS}`,
    );
    const linked: Attachment[] = [];
    for (const id of ids) {
      const r = stmt.get({ id, o: "outboxId" in to ? to.outboxId : null, m: "messageId" in to ? to.messageId : null }) as Row | null;
      if (r) linked.push(toAttachment(r));
    }
    return linked;
  }

  /** The attachments of each outbox item, by item id. */
  forOutbox(ids: number[]): Map<number, Attachment[]> {
    return this.grouped("outbox_id", ids);
  }

  /** The attachments of each user message, by message id. */
  forMessages(ids: number[]): Map<number, Attachment[]> {
    return this.grouped("message_id", ids);
  }

  private grouped(column: "outbox_id" | "message_id", ids: number[]): Map<number, Attachment[]> {
    const out = new Map<number, Attachment[]>();
    if (!ids.length) return out;
    const rows = this.db
      .query(`SELECT ${COLUMNS}, ${column} AS owner FROM attachments WHERE ${column} IN (SELECT value FROM json_each($ids)) ORDER BY rowid`)
      .all({ ids: JSON.stringify(ids) }) as Array<Row & { owner: number }>;
    for (const r of rows) {
      const list = out.get(r.owner) ?? [];
      list.push(toAttachment(r));
      out.set(r.owner, list);
    }
    return out;
  }
}
