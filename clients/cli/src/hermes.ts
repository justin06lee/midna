import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { MidnaClient } from "@midna/protocol";
import { writePrivate } from "@midna/daemon";

/**
 * Hermes as midna's brain (`midna hermes setup`; `midna host install` runs it). Hermes's side lives
 * in the hyperactive repo's deploy/midna, pinned here: it is cloned at that commit and its
 * installer run, so a fresh machine and a re-run end up exactly like the live setup.
 *
 *  1. Skip when this machine has no Hermes (no `hermes` user that midna may sudo to).
 *  2. Clone/fetch the pinned deploy into <midna home>/vendor/hyperactive.
 *  3. Pair Hermes with this midna as a bridge, so what it sends on its own reaches the app
 *     (secrets/hermes_app_token; kept while it still works).
 *  4. `midna_hermes.py install` — P1, persona, P2, the api_server, and the app delivery. Idempotent.
 *  5. Once Hermes is the writer (P3, phase "activated"), midna thinks with it: `midna model hermes`.
 */
export const HERMES_DEPLOY = {
  repo: "https://github.com/justin06lee/hyperactive",
  ref: "1de03582b40c2a4ba6757778d43c6d673721c964",
};

export interface HermesSetupResult {
  ok: boolean;
  skipped?: string;
  detail?: string;
  error?: string;
}

export interface HermesSetupOptions {
  home: string;
  /** midna serve here, and the host's own client for it. */
  url: string;
  client: MidnaClient;
  repo?: string;
  ref?: string;
  /** Leave the brain setting alone even when Hermes is the writer. */
  keepModel?: boolean;
  /** Set it up even in an isolated install (MIDNA_HOME set). */
  force?: boolean;
  log: (line: string) => void;
}

function run(argv: string[], opts: { cwd?: string; log?: (line: string) => void } = {}): { code: number; out: string } {
  const r = Bun.spawnSync(argv, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const out = `${r.stdout.toString()}${r.stderr.toString()}`;
  if (opts.log) for (const line of out.split("\n")) if (line.trim()) opts.log(line);
  return { code: r.exitCode ?? 1, out };
}

/** Why there's nothing to set up here, or null when there is a Hermes to set up. */
export function noHermes(force = false): string | null {
  if (platform() !== "linux") return "Hermes runs on midna's Linux host only";
  if (process.env.MIDNA_HOME && !force) return "an isolated install (MIDNA_HOME) leaves Hermes alone";
  if (run(["id", "-u", "hermes"]).code !== 0) return "no Hermes on this machine (no `hermes` user)";
  if (run(["sudo", "-n", "-u", "hermes", "true"]).code !== 0) return "midna may not act as the `hermes` user (sudo -n -u hermes)";
  return null;
}

export function hermesState(): { phase?: string } {
  const f = join(homedir(), ".local", "state", "midna-hermes", "state.json");
  try {
    return JSON.parse(readFileSync(f, "utf8")) as { phase?: string };
  } catch {
    return {};
  }
}

export async function hermesSetup(o: HermesSetupOptions): Promise<HermesSetupResult> {
  const skip = noHermes(o.force);
  if (skip) return { ok: true, skipped: skip };
  const repo = o.repo ?? HERMES_DEPLOY.repo;
  const ref = o.ref ?? HERMES_DEPLOY.ref;

  // 2 ── the pinned deploy
  const vendor = join(o.home, "vendor", "hyperactive");
  if (!existsSync(join(vendor, ".git"))) {
    mkdirSync(join(o.home, "vendor"), { recursive: true });
    o.log(`cloning ${repo} into ${vendor}`);
    const c = run(["git", "clone", "-q", repo, vendor]);
    if (c.code !== 0) return { ok: false, error: `cloning ${repo} failed: ${c.out.trim().slice(-300)}` };
  }
  const has = () => run(["git", "-C", vendor, "cat-file", "-e", `${ref}^{commit}`]).code === 0;
  if (!has()) run(["git", "-C", vendor, "fetch", "-q", repo, ref]);
  if (!has()) run(["git", "-C", vendor, "fetch", "-q", "--all"]);
  if (!has()) return { ok: false, error: `${repo} has no commit ${ref}` };
  const co = run(["git", "-C", vendor, "checkout", "-q", "--detach", "--force", ref]);
  if (co.code !== 0) return { ok: false, error: `checking out ${ref.slice(0, 12)} failed: ${co.out.trim().slice(-300)}` };
  const sha = run(["git", "-C", vendor, "rev-parse", "HEAD"]).out.trim();

  // 3 ── Hermes paired as a bridge, for its deliveries into the outbox (a just-restarted midna may need a moment)
  for (const end = Date.now() + 30_000; Date.now() < end; await Bun.sleep(1_000)) {
    if (await o.client.status().then(() => true, () => false)) break;
  }
  const tokenFile = join(o.home, "secrets", "hermes_app_token");
  const old = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
  const works = old ? await new MidnaClient(o.url, old).status().then(() => true, () => false) : false;
  if (!works) {
    const { code } = await o.client.pairingCode();
    const paired = await new MidnaClient(o.url).pair({ code, deviceName: "Hermes", kind: "bridge", ...(old ? { replaces: old } : {}) });
    mkdirSync(join(o.home, "secrets"), { recursive: true, mode: 0o700 });
    writePrivate(tokenFile, paired.token + "\n");
    o.log(`paired Hermes with midna as a bridge (${paired.deviceId})`);
  }

  // 4 ── Hermes's side, idempotent
  const script = join(vendor, "deploy", "midna", "midna_hermes.py");
  o.log(`running ${script} install at ${sha.slice(0, 12)}`);
  const inst = run(["python3", "-I", script, "install", "--repo", vendor, "--ref", sha, "--app-url", o.url], { log: o.log });
  if (inst.code !== 0) return { ok: false, error: `Hermes's installer failed: ${inst.out.trim().split("\n").slice(-3).join(" | ")}` };

  // 5 ── one brain, once Hermes is the writer
  const phase = hermesState().phase ?? "none";
  let model = (await o.client.status()).model;
  if (phase === "activated" && !o.keepModel && model !== "hermes") {
    model = (await o.client.updateSettings({ model: "hermes" })).model;
    o.log("brain: hermes (Hermes is the writer)");
  }
  return { ok: true, detail: `hyperactive ${sha.slice(0, 12)}, phase ${phase}, brain ${model}` };
}
