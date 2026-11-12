import { closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { VaultItem } from "@midna/protocol";

/**
 * The vault: ghostly's Vaultwarden on this host, opened with midna's own
 * account there (midna@ghostly.local), through Bitwarden's own CLI — every
 * bit of crypto happens inside `bw`, as in ghostly itself.
 *
 * Secrets move on stdin and stdout only. A new or changed login goes to
 * `bw create|edit` encoded on stdin; the master password is read by `bw`
 * from its file (`--passwordfile`); the session key lives in this process's
 * memory and in `bw`'s environment, never in argv, on disk, or in a log.
 * midna keeps its own `bw` state (<home>/vault), apart from the `ghostly`
 * CLI's, so neither locks the other out.
 */

export class VaultError extends Error {
  constructor(
    message: string,
    /** The HTTP status that says it best: 404 no such login, 503 no vault here, 502 bw failed. */
    readonly status: 404 | 409 | 502 | 503 = 502,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export interface VaultSettings {
  /** The Vaultwarden, as this host reaches it. */
  server: string;
  /** midna's account on it. */
  email: string;
  /** Its master password, one line (mode 600): `bw` reads the file itself. */
  passwordFile: string;
  /** A PEM to trust, for a server with a self-signed certificate. */
  caCert?: string;
  /** argv that runs the Bitwarden CLI. */
  bw: string[];
  /** midna's own `bw` state. */
  dataDir: string;
  /** Where new logins go when midna's account can see it: the collection the user shares with midna. */
  collection?: string;
  /** Lock again after this long unused. */
  idleMs?: number;
}

/** What a midna config.json may say under "vault"; anything left out is the ghostly install's own layout. */
export type VaultConfig = Partial<Omit<VaultSettings, "dataDir">>;

const TIMEOUT_MS = 90_000;
const IDLE_MS = 15 * 60_000;
/** Pull what changed in other Bitwarden apps at most this often. */
const SYNC_MS = 60_000;
/** bw prints its answer, then idles about two seconds before it exits: these are done once it has answered. */
const ANSWERS_BEFORE_EXIT = new Set(["status", "list", "get", "sync", "create", "edit", "delete"]);
const LOGIN = 1;
/** Bitwarden's "master password re-prompt": the user wants to be asked. Not handed to another program. */
const REPROMPT = 1;

/**
 * The Bitwarden CLI on this machine, as argv: `bw` where it is a program of
 * its own; bw.js on Node 22+ where there is one, else on bun (as ghostly's
 * Jetson install runs it). Null when there is none.
 */
export function findBw(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const home = homedir();
  const path = [join(home, ".bun", "bin"), join(home, ".local", "bin"), ...(env.PATH ?? "").split(delimiter)].filter(Boolean);
  const which = (name: string) => path.map((d) => join(d, name)).find((p) => existsSync(p)) ?? null;
  const bw = which("bw");
  if (!bw) return null;
  const script = realpathSync(bw);
  const head = firstBytes(script, 64);
  if (!head.startsWith("#!") || !/\bnode\b/.test(head.split("\n")[0]!)) return [bw];
  const node = which("node");
  if (node) {
    const major = Number(Bun.spawnSync([node, "-p", "process.versions.bun ? 0 : process.versions.node.split('.')[0]"], { stdout: "pipe", stderr: "ignore", timeout: 5_000 }).stdout.toString().trim() || 0);
    if (major >= 22) return [node, script];
  }
  const bun = which("bun");
  return bun ? [bun, "--bun", script] : null;
}

function firstBytes(path: string, n: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The vault on this host, as ghostly installs it (~/.local/share/ghostly,
 * with midna's master password in <midna home>/secrets/ghostly_midna) and as
 * config.json's "vault" says otherwise — or why there is none.
 */
export function vaultSettings(home: string, config: VaultConfig = {}): VaultSettings | { missing: string } {
  const ghostly = join(homedir(), ".local", "share", "ghostly");
  const passwordFile = config.passwordFile ?? join(home, "secrets", "ghostly_midna");
  if (!existsSync(passwordFile)) return { missing: `there's no vault here: midna's ghostly password isn't in ${passwordFile}` };
  const bw = config.bw ?? findBw();
  if (!bw) return { missing: "there's no vault here: the Bitwarden CLI (bw) isn't installed" };
  const ca = join(ghostly, "tls", "ca.crt");
  return {
    server: config.server ?? "https://localhost:8222",
    email: config.email ?? "midna@ghostly.local",
    passwordFile,
    ...(config.caCert ? { caCert: config.caCert } : existsSync(ca) ? { caCert: ca } : {}),
    bw,
    dataDir: join(home, "vault"),
    collection: config.collection ?? "midna",
    ...(config.idleMs ? { idleMs: config.idleMs } : {}),
  };
}

interface BwItem {
  id: string;
  type: number;
  name: string;
  organizationId?: string | null;
  collectionIds?: string[];
  revisionDate?: string;
  reprompt?: number;
  login?: { username?: string | null; password?: string | null; uris?: Array<{ uri?: string | null; match?: unknown }> | null } | null;
  [k: string]: unknown;
}

interface BwResponse {
  success: boolean;
  message?: string;
  data?: unknown;
}

const encode = (item: object) => Buffer.from(JSON.stringify(item), "utf8").toString("base64");

/** What a login shows the apps: never its password. */
export function shown(item: BwItem): VaultItem {
  const updated = item.revisionDate ? Date.parse(item.revisionDate) : NaN;
  return {
    id: item.id,
    title: item.name,
    username: item.login?.username || null,
    url: item.login?.uris?.find((u) => u.uri)?.uri ?? null,
    shared: !!item.organizationId,
    updatedAt: Number.isFinite(updated) ? updated : null,
  };
}

const norm = (s: string) => s.trim().toLowerCase();

/** By title: the exact title (any case) first, then titles that hold it, then a username or website that does. */
export function findByTitle(items: VaultItem[], title: string): VaultItem[] {
  const q = norm(title);
  if (!q) return [];
  const exact = items.filter((i) => norm(i.title) === q);
  if (exact.length) return exact;
  const inTitle = items.filter((i) => norm(i.title).includes(q));
  if (inTitle.length) return inTitle;
  return items.filter((i) => norm(i.username ?? "").includes(q) || norm(i.url ?? "").includes(q));
}

export class Vault {
  private session: string | null = null;
  private opening: Promise<void> | null = null;
  private syncedAt = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  /** One bw at a time: they share one state file. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly settings: VaultSettings) {}

  /** Every login, by title. */
  list(query?: string): Promise<VaultItem[]> {
    return this.serial(async () => {
      await this.sync();
      const items = (await this.logins()).map(shown).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
      const q = query ? norm(query) : "";
      return q ? items.filter((i) => norm(i.title).includes(q) || norm(i.username ?? "").includes(q) || norm(i.url ?? "").includes(q)) : items;
    });
  }

  /** The logins a title names (see findByTitle). */
  async find(title: string): Promise<VaultItem[]> {
    return findByTitle(await this.list(), title);
  }

  add(entry: { title: string; username?: string; url?: string; password: string }): Promise<VaultItem> {
    return this.serial(async () => {
      const home = await this.sharedCollection();
      const item = {
        type: LOGIN,
        name: entry.title,
        notes: null,
        favorite: false,
        organizationId: home?.organizationId ?? null,
        collectionIds: home ? [home.id] : [],
        login: { username: entry.username || null, password: entry.password, totp: null, uris: entry.url ? [{ match: null, uri: entry.url }] : [] },
      };
      try {
        return shown((await this.call(["create", "item"], encode(item))) as BwItem);
      } catch (err) {
        if (!home) throw err;
        // The shared collection may be read-only for midna: then it is midna's own.
        return shown((await this.call(["create", "item"], encode({ ...item, organizationId: null, collectionIds: [] }))) as BwItem);
      }
    });
  }

  edit(id: string, patch: { title?: string; username?: string; url?: string; password?: string }): Promise<VaultItem> {
    return this.serial(async () => {
      const item = await this.item(id);
      const login = { ...item.login };
      if (patch.username !== undefined) login.username = patch.username || null;
      if (patch.password !== undefined) login.password = patch.password;
      if (patch.url !== undefined) {
        const rest = (login.uris ?? []).slice(1);
        login.uris = patch.url ? [{ ...(login.uris?.[0] ?? { match: null }), uri: patch.url }, ...rest] : rest;
      }
      const next = { ...item, ...(patch.title !== undefined ? { name: patch.title } : {}), login };
      return shown((await this.call(["edit", "item", id], encode(next))) as BwItem);
    });
  }

  /** To the trash: Bitwarden can restore it. */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      await this.item(id);
      await this.call(["delete", "item", id]);
    });
  }

  /** One login's password. `forAnotherProgram` refuses a login the user marked "re-prompt". */
  password(id: string, opts: { forAnotherProgram?: boolean } = {}): Promise<{ item: VaultItem; password: string }> {
    return this.serial(async () => {
      const item = await this.item(id);
      if (opts.forAnotherProgram && item.reprompt === REPROMPT) throw new VaultError(`"${item.name}" is marked to ask for the master password: it isn't handed out`, 409);
      const password = item.login?.password;
      if (!password) throw new VaultError(`"${item.name}" has no password`, 404);
      return { item: shown(item), password };
    });
  }

  /** Forget the session and lock bw's copy. */
  async lock(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (!this.session) return;
    this.session = null;
    await this.serial(() => this.bw(["lock"]).catch(() => undefined));
  }

  // ── inside ─────────────────────────────────────────────────────────

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async logins(): Promise<BwItem[]> {
    return ((await this.call(["list", "items"])) as BwItem[]).filter((i) => i.type === LOGIN && !i.deletedDate);
  }

  private async item(id: string): Promise<BwItem> {
    const item = (await this.logins()).find((i) => i.id === id);
    if (!item) throw new VaultError("there's no such login in the vault", 404);
    return item;
  }

  private async sharedCollection(): Promise<{ id: string; organizationId: string } | null> {
    const name = this.settings.collection;
    if (!name) return null;
    const all = (await this.call(["list", "collections"]).catch(() => [])) as Array<{ id: string; name: string; organizationId: string }>;
    return all.find((c) => c.name === name) ?? null;
  }

  private async sync(): Promise<void> {
    if (Date.now() - this.syncedAt < SYNC_MS) return;
    // Unreachable for a moment: bw still has the last synced copy, and reads carry on from it.
    await this.call(["sync"]).then(
      () => (this.syncedAt = Date.now()),
      (err: Error) => console.error(`[midna] vault: sync failed, using the last synced copy: ${err.message}`),
    );
  }

  /** A bw command inside an open session, opening (again) once when the session is gone. */
  private async call(args: string[], stdin?: string): Promise<unknown> {
    if (!this.session) await this.open();
    this.armIdle();
    try {
      return await this.bw(args, stdin);
    } catch (err) {
      if (!(err instanceof VaultError) || !/locked|not logged in|logged out|session/i.test(err.message)) throw err;
      this.session = null;
      await this.open();
      return await this.bw(args, stdin);
    }
  }

  private open(): Promise<void> {
    this.opening ??= this.unlock().finally(() => (this.opening = null));
    return this.opening;
  }

  private async unlock(): Promise<void> {
    const s = this.settings;
    mkdirSync(s.dataDir, { recursive: true, mode: 0o700 });
    let status = (await this.bw(["status"])) as { serverUrl?: string | null; userEmail?: string; status: string };
    const sameServer = (status.serverUrl ?? "").replace(/\/+$/, "") === s.server.replace(/\/+$/, "");
    if (status.status !== "unauthenticated" && (!sameServer || status.userEmail !== s.email)) {
      await this.bw(["logout"]).catch(() => undefined);
      status = { ...status, status: "unauthenticated" };
    }
    if (!sameServer) await this.bw(["config", "server", s.server]);
    const answer =
      status.status === "unauthenticated"
        ? await this.bw(["login", s.email, "--passwordfile", s.passwordFile, "--raw"])
        : await this.bw(["unlock", "--passwordfile", s.passwordFile, "--raw"]);
    const key = typeof answer === "string" ? answer : (answer as { raw?: string } | null)?.raw;
    if (!key) throw new VaultError("the vault didn't open: the Bitwarden CLI gave no session");
    this.session = key;
    if (status.status === "unauthenticated") this.syncedAt = Date.now(); // a login syncs
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.lock(), this.settings.idleMs ?? IDLE_MS);
    this.idle.unref?.();
  }

  /** Run `bw --response <args>`: its answer, unwrapped, or a VaultError in bw's own words. */
  private async bw(args: string[], stdin?: string): Promise<unknown> {
    const s = this.settings;
    const env: Record<string, string> = {};
    // Whatever BW_* this process carries belongs to some other vault.
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("BW_") && k !== "BITWARDENCLI_APPDATA_DIR") env[k] = v;
    env.BITWARDENCLI_APPDATA_DIR = s.dataDir;
    env.BW_NOINTERACTION = "true";
    if (s.caCert) env.NODE_EXTRA_CA_CERTS = s.caCert;
    if (this.session) env.BW_SESSION = this.session;
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn([...s.bw, "--response", ...args], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      throw new VaultError(`the Bitwarden CLI couldn't be run: ${(err as Error).message}`, 503);
    }
    proc.stdin.write(stdin ?? "");
    void proc.stdin.end();
    const err = new Response(proc.stderr).text().catch(() => "");
    const timer = setTimeout(() => proc.kill("SIGKILL"), TIMEOUT_MS);
    const early = ANSWERS_BEFORE_EXIT.has(args[0] ?? "");
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    let answer: BwResponse | undefined;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
        if (early && out.trimEnd().endsWith("}") && (answer = parse(out))) break;
      }
    } finally {
      clearTimeout(timer);
    }
    if (answer) {
      // Answered: let bw finish idling on its own.
      void reader.cancel().catch(() => {});
      proc.unref();
    } else {
      await proc.exited;
      answer = parse(out);
    }
    if (!answer) {
      if (proc.signalCode === "SIGKILL") throw new VaultError(`the vault didn't answer within ${TIMEOUT_MS / 1000} s (bw ${args[0]})`);
      const why = (await err).trim().split("\n").pop() || (proc.signalCode ? `killed by ${proc.signalCode}` : `exit ${proc.exitCode ?? "?"}`);
      throw new VaultError(`bw ${args[0]} failed: ${why}`);
    }
    if (!answer.success) throw new VaultError(answer.message || `bw ${args[0]} failed`);
    return unwrap(answer.data);
  }
}

/** bw can print notices before its answer: the answer is the last JSON line. */
function parse(stdout: string): BwResponse | undefined {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const r = JSON.parse(line) as BwResponse;
      if (typeof r.success === "boolean") return r;
    } catch {}
  }
  return undefined;
}

function unwrap(data: unknown): unknown {
  if (data && typeof data === "object") {
    const r = data as Record<string, unknown>;
    if (r.object === "list" || r.object === "string") return r.data;
    if (r.object === "template") return r.template;
  }
  return data;
}
