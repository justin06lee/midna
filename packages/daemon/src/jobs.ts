import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import type { Job, JobStatus, Store } from "@midna/core";
import { resolveModel, type JobStart, type JobsHandle } from "@midna/agent";

/**
 * Jobs: long work midna starts from a turn, run detached so it outlives
 * the turn's process and the daemon's own restarts (docs/jobs.md).
 *
 * Each job runs in a folder of its own under MIDNA_HOME/jobs: run.sh (the
 * command), log, pid, and exit, which a small sh wrapper writes when the
 * command ends. The exit file is how a job's end is known even when the
 * daemon wasn't there to see it.
 *
 * Detached means out of reach of whatever stops the daemon:
 * - under systemd (the Jetson), midna.service's default KillMode kills its
 *   whole cgroup on a restart, so each job runs in a transient user unit
 *   of its own (systemd-run --user), in no cgroup of midna's;
 * - elsewhere (launchd on a Mac, a terminal) it gets its own session and
 *   process group (setsid): launchd kills the job's process group, and a
 *   terminal's hangup reaches only its own session.
 */

/** Without a timeout of its own, a job is stopped after this long. */
export const JOB_TIMEOUT_DEFAULT = 2 * 60 * 60_000;
export const JOB_TIMEOUT_MAX = 24 * 60 * 60_000;

/**
 * The job's wrapper, written to wrapper.sh in its folder: only `/bin/sh
 * <that path>` goes on the launch command line. systemd rewrites $ and %
 * in a unit's command line ($$ came out as a literal $, so the pid file of
 * every job on the Jetson held "$"); a file is read by sh alone. The pid
 * comes first, so the daemon can find the job at once.
 */
const wrapper = (job: { id: number; dir: string; cwd: string }) => `d=${shq(job.dir)}
echo $$ > "$d/pid"
export MIDNA_JOB_ID=${job.id} MIDNA_JOB_DIR="$d"
cd ${shq(job.cwd)} 2>/dev/null || { echo "midna: there is no folder "${shq(job.cwd)} >> "$d/log"; echo 126 > "$d/exit"; exit 126; }
if [ -x /bin/bash ]; then sh=/bin/bash; else sh=/bin/sh; fi
"$sh" "$d/run.sh" < /dev/null >> "$d/log" 2>&1
c=$?
echo "$c" > "$d/exit.tmp" && mv "$d/exit.tmp" "$d/exit"
exit "$c"
`;
/** What systemd rewrites on a unit's command line: environment references ($), specifiers (%) and escapes (\). */
const REWRITTEN = /[$%\\]/;

/** The service manager's own variables: they describe midna's unit, not the job's. */
const NOT_PASSED = /^(INVOCATION_ID|JOURNAL_STREAM|NOTIFY_SOCKET|MANAGERPID|SYSTEMD_EXEC_PID|LISTEN_\w+|WATCHDOG_\w+|CLAUDECODE|_)$/;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

export interface JobRunnerOptions {
  store: Store;
  /** Where each job gets its folder: MIDNA_HOME/jobs. */
  root: string;
  /** A job's working directory when it names none. */
  workspace: string;
  /** "systemd": a transient user unit per job; "setsid": a session of its own. By default systemd when midna runs as a systemd service. */
  launcher?: "systemd" | "setsid";
  /** How often running jobs are looked at; tests make it short. */
  pollMs?: number;
  /** After SIGTERM, how long a job gets before SIGKILL. */
  killGraceMs?: number;
  /** The `claude` and `codex` a prompt job runs; found on PATH by default. */
  claudeBin?: string | null;
  codexBin?: string | null;
  /** The model midna thinks with now (a capped provider's fallback meanwhile); a prompt job runs on its harness. By default the setting. */
  model?: () => string | null;
  /** Providers out of usage, with when each resets; a prompt job naming one runs on the active model instead. */
  caps?: () => Record<string, number>;
  /** With no pid yet and no unit or process to show it running, how long a job may take to start before it counts as never started. */
  startGraceMs?: number;
  /** A job ended and its wakeup is due: run the scheduler now rather than at its next tick. */
  onEnded?: (job: Job) => void;
}

export class JobRunner implements JobsHandle {
  private readonly store: Store;
  private readonly launcher: "systemd" | "setsid";
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly poll: ReturnType<typeof setInterval>;
  /** Shut down: the jobs carry on, but this runner no longer settles them (the next one will). */
  private done = false;

  constructor(private readonly opts: JobRunnerOptions) {
    this.store = opts.store;
    this.launcher = opts.launcher ?? (platform() === "linux" && process.env.INVOCATION_ID && Bun.which("systemd-run") ? "systemd" : "setsid");
    mkdirSync(opts.root, { recursive: true, mode: 0o700 });
    this.poll = setInterval(() => {
      try {
        for (const job of this.store.jobs.running()) this.check(job.id, false);
      } catch (err) {
        console.error("[midna] jobs: couldn't look at the running jobs:", (err as Error).message);
      }
    }, opts.pollMs ?? 2_000);
  }

  /** Which harness and model a prompt job runs on: a model named with its
   *  provider ("codex:gpt-5.5") is that provider's; a bare one ("opus") is the
   *  active model's provider's; none, or one whose provider is capped, is the
   *  active model. */
  private promptModel(asked: string | undefined, active: string): { provider: "claude" | "codex"; model?: string } {
    const now = resolveModel(active);
    let named = asked && /^(claude|codex)(:|$)/.test(asked) ? resolveModel(asked) : undefined;
    if (named && named.provider !== now.provider && this.opts.caps?.()[named.provider]) {
      named = undefined;
      asked = undefined;
    }
    const provider = named?.provider ?? now.provider;
    if (provider !== "claude" && provider !== "codex") throw new Error(`a prompt job runs on Claude or Codex, not ${provider}; run it through a command instead`);
    const model = named ? named.model : (asked ?? (provider === now.provider ? now.model : undefined));
    return { provider, ...(model ? { model } : {}) };
  }

  /**
   * At startup: settle what ended while midna was down — from its exit
   * file when it has one, as failed when it has none — and keep watching
   * what still runs. Returns how many still run.
   */
  reconcile(): number {
    let still = 0;
    for (const job of this.store.jobs.running()) {
      this.check(job.id, true);
      const now = this.store.jobs.get(job.id)!;
      if (now.status !== "running") continue;
      still++;
      this.arm(now);
    }
    return still;
  }

  async start(req: JobStart): Promise<Job> {
    const settings = this.store.settings();
    if (settings.mode === "ask") throw new Error("midna is in ask mode: a job runs commands on this machine, which needs the user's approval. Ask them with ask_user; in autonomous mode you can start it.");
    const label = req.label.trim();
    if (!label) throw new Error("give the job a label: a few words saying what it is");
    if (!!req.command?.trim() === !!req.prompt?.trim()) throw new Error("give either a command or a prompt");
    const cwd = req.cwd ?? this.opts.workspace;
    if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`there is no folder ${cwd} (give an absolute path)`);
    if (req.resultFile && !isAbsolute(req.resultFile)) throw new Error("result_file must be an absolute path");
    const timeoutMs = Math.min(JOB_TIMEOUT_MAX, Math.max(1_000, req.timeoutMs ?? JOB_TIMEOUT_DEFAULT));

    const name = `job-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const dir = join(this.opts.root, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let command = req.command?.trim() ?? "";
    let resultPath = req.resultFile ?? null;
    if (req.prompt?.trim()) {
      const { provider, model } = this.promptModel(req.model, this.opts.model?.() ?? settings.model);
      const bin = provider === "codex" ? this.opts.codexBin : this.opts.claudeBin;
      const exe = bin === undefined ? Bun.which(provider) : bin;
      if (!exe) throw new Error(`${provider} isn't on midna's PATH on this machine; run it through a command instead`);
      writeFileSync(join(dir, "prompt.md"), req.prompt);
      resultPath ??= join(dir, "result.md");
      const m = model ? ["--model", shq(model)] : [];
      command = (
        provider === "codex"
          ? [shq(exe), "exec", ...m, "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--ephemeral", "--color", "never", "-o", shq(resultPath), `< "$MIDNA_JOB_DIR/prompt.md"`]
          : [shq(exe), "-p", "--output-format", "text", ...m, "--dangerously-skip-permissions", `< "$MIDNA_JOB_DIR/prompt.md"`, `> ${shq(resultPath)}`]
      ).join(" ");
    }
    writeFileSync(join(dir, "run.sh"), command + "\n");
    const logPath = join(dir, "log");
    writeFileSync(logPath, "");

    const job = this.store.jobs.add({ label, command, cwd, dir, logPath, resultPath, whenDone: req.whenDone?.trim() || null, timeoutMs, episodeId: req.episodeId });
    try {
      await this.launch(job, name);
    } catch (err) {
      this.store.jobs.end(job.id, { status: "failed", reason: `it couldn't start: ${(err as Error).message}`, tz: settings.timezone, quiet: true });
      throw new Error(`job #${job.id} couldn't start: ${(err as Error).message}`);
    }
    const started = this.store.jobs.get(job.id)!;
    this.arm(started);
    console.log(`[midna] job #${job.id} started (${label}): pid ${started.pid}${started.unit ? `, unit ${started.unit}` : ""}`);
    return started;
  }

  list(opts: { ended?: boolean } = {}): Job[] {
    return opts.ended ? this.store.jobs.recent(20) : this.store.jobs.running();
  }

  stop(id: number): Job {
    const job = this.store.jobs.get(id);
    if (!job) throw new Error(`there is no job #${id}`);
    if (job.status !== "running") throw new Error(`job #${id} isn't running: it ${job.status === "done" ? "finished" : `ended (${job.status})`}`);
    const ended = this.store.jobs.end(id, { status: "stopped", reason: "midna stopped it", tz: this.store.settings().timezone });
    this.kill(job);
    this.disarm(id);
    console.log(`[midna] job #${id} stopped`);
    return ended ?? this.store.jobs.get(id)!;
  }

  /** Forget jobs that ended before `before`, and delete their folders. */
  prune(before: number): number {
    const dirs = this.store.jobs.prune(before);
    for (const dir of dirs) if (dir.startsWith(this.opts.root + sep)) rmSync(dir, { recursive: true, force: true });
    return dirs.length;
  }

  /** The daemon is stopping: stop watching. The jobs themselves carry on, and the next start picks them up. */
  shutdown(): void {
    this.done = true;
    clearInterval(this.poll);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private async launch(job: Job, name: string): Promise<void> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !NOT_PASSED.test(k)) env[k] = v;
    env.MIDNA_JOB_ID = String(job.id);
    env.MIDNA_JOB_DIR = job.dir;
    const script = join(job.dir, "wrapper.sh");
    writeFileSync(script, wrapper(job));
    const argv = ["/bin/sh", script];

    if (this.launcher === "systemd") {
      if (REWRITTEN.test(script)) throw new Error(`systemd would rewrite the job's path ${script} ($, % or \\ in MIDNA_HOME)`);
      const unit = `midna-${name}`;
      // A variable systemd can't carry (a newline in it, say) stays behind rather than failing the job.
      const setenv = Object.entries(env)
        .filter(([, v]) => !/[\x00-\x08\x0a-\x1f\x7f]/.test(v))
        .map(([k, v]) => `--setenv=${k}=${v}`);
      const r = Bun.spawnSync(
        ["systemd-run", "--user", "--quiet", "--collect", `--unit=${unit}`, `--description=midna job #${job.id}: ${job.label.replace(/%/g, "%%")}`, "-p", "TimeoutStopSec=10", ...setenv, ...argv],
        { stdout: "pipe", stderr: "pipe", env: process.env },
      );
      if (r.exitCode !== 0) throw new Error(`systemd-run failed: ${(r.stderr.toString() || r.stdout.toString()).trim()}`);
      this.store.jobs.launched(job.id, { pid: null, pidStarted: null, unit });
      // The wrapper writes its pid first thing; failing that, the unit knows its main process.
      for (let i = 0; i < 50; i++) {
        const pid = readPid(job.dir) ?? mainPid(unit);
        if (pid) return this.store.jobs.launched(job.id, { pid, pidStarted: processStart(pid) });
        await Bun.sleep(100);
      }
      // Still none: check() keeps looking while the unit runs.
      return;
    }

    const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: "ignore", env });
    // Bun's ChildProcess is an EventEmitter; its types leave that out.
    const events = child as unknown as { on(event: string, f: (arg?: unknown) => void): void };
    await new Promise<void>((resolve, reject) => {
      events.on("spawn", () => resolve());
      events.on("error", (err) => reject(err as Error));
    });
    child.unref();
    // Ours until the daemon restarts: look at once when it ends.
    events.on("exit", () => this.check(job.id, false));
    this.store.jobs.launched(job.id, { pid: child.pid ?? null, pidStarted: child.pid ? processStart(child.pid) : null });
  }

  /** Has the job ended? Settle it if so. */
  private check(id: number, atStartup: boolean): void {
    if (this.done) return;
    const job = this.store.jobs.get(id);
    if (!job || job.status !== "running") return;
    const down = atStartup ? "while midna was down" : null;
    const exited = (code: number) => this.finish(job, code === 0 ? "done" : "failed", code, down && `it ended ${down}`);
    const code = readExit(job.dir);
    if (code !== null) return exited(code);
    if (job.pid === null) {
      const pid = readPid(job.dir) ?? (job.unit ? mainPid(job.unit) : null);
      if (pid) return this.store.jobs.launched(id, { pid, pidStarted: processStart(pid) });
    }
    // Running while its unit is active or its process is alive, pid file or not.
    if (this.alive(job)) return;
    // It may have written its exit code just as it went.
    const late = readExit(job.dir);
    if (late !== null) return exited(late);
    if (job.pid === null) {
      if (Date.now() - job.started_at < (this.opts.startGraceMs ?? 30_000)) return;
      return this.finish(job, "failed", null, "it never started");
    }
    this.finish(job, "failed", null, down ? `it ended ${down}, with no exit code: killed, or the machine restarted` : "it ended with no exit code: something outside midna killed it");
  }

  private finish(job: Job, status: Exclude<JobStatus, "running">, exitCode: number | null, reason: string | null): void {
    const ended = this.store.jobs.end(job.id, { status, exitCode, reason, tz: this.store.settings().timezone });
    if (!ended) return;
    this.disarm(job.id);
    console.log(`[midna] job #${job.id} (${job.label}) ${status}${exitCode !== null ? `, exit ${exitCode}` : ""}${reason ? `: ${reason}` : ""}`);
    this.opts.onEnded?.(ended);
  }

  /** Stop it at its time limit, from whenever it started. */
  private arm(job: Job): void {
    this.disarm(job.id);
    const left = job.started_at + job.timeout_ms - Date.now();
    this.timers.set(
      job.id,
      setTimeout(() => {
        this.timers.delete(job.id);
        const now = this.store.jobs.get(job.id);
        if (now?.status !== "running") return;
        const ended = this.store.jobs.end(job.id, { status: "timeout", reason: `stopped at its time limit of ${minutes(job.timeout_ms)}`, tz: this.store.settings().timezone });
        this.kill(now);
        if (ended) {
          console.log(`[midna] job #${job.id} (${job.label}) stopped at its time limit`);
          this.opts.onEnded?.(ended);
        }
      }, Math.max(0, left)),
    );
  }

  private disarm(id: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  /** TERM to its whole process group (and its unit), KILL to whatever is left after the grace. */
  private kill(job: Job): void {
    const signal = (sig: NodeJS.Signals) => {
      // Only while the pid is still the job's: a reused pid's group is someone else's.
      if (job.pid !== null && this.alive(job)) {
        try {
          process.kill(-job.pid, sig);
        } catch {}
      }
    };
    signal("SIGTERM");
    // The unit is the whole cgroup: it reaches what left the process group too.
    if (job.unit) {
      try {
        Bun.spawn(["systemctl", "--user", "stop", "--no-block", job.unit], { stdout: "ignore", stderr: "ignore", env: process.env });
      } catch {}
    }
    setTimeout(() => signal("SIGKILL"), this.opts.killGraceMs ?? 5_000).unref?.();
  }

  private alive(job: Job): boolean {
    if (job.unit && unitActive(job.unit)) return true;
    if (job.pid === null) return false;
    const started = processStart(job.pid);
    if (started === null) return false;
    return job.pid_started === null || started === job.pid_started;
  }
}

function readExit(dir: string): number | null {
  const file = join(dir, "exit");
  if (!existsSync(file)) return null;
  const n = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(n) ? n : null;
}

/** Is the job's systemd unit running (or starting)? */
function unitActive(unit: string): boolean {
  try {
    return Bun.spawnSync(["systemctl", "--user", "is-active", "--quiet", unit], { stdout: "ignore", stderr: "ignore", env: process.env }).exitCode === 0;
  } catch {
    return false;
  }
}

/** The unit's main process, as systemd tells it; null when there is none. */
function mainPid(unit: string): number | null {
  try {
    const out = Bun.spawnSync(["systemctl", "--user", "show", "-p", "MainPID", "--value", unit], { stdout: "pipe", stderr: "ignore", env: process.env }).stdout.toString().trim();
    const n = Number(out);
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

function readPid(dir: string): number | null {
  const file = join(dir, "pid");
  if (!existsSync(file)) return null;
  const n = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(n) && n > 1 ? n : null;
}

/**
 * When a live process started, as the OS tells it, or null when there is no
 * such process (or only its zombie). With the pid, it names one process: a
 * pid the OS hands out again later comes with another start time.
 */
export function processStart(pid: number): string | null {
  if (platform() === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The name in parentheses may hold spaces; the fields after it don't.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[0] === "Z" ? null : (fields[19] ?? null);
    } catch {
      return null;
    }
  }
  const r = Bun.spawnSync(["ps", "-o", "stat=,lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const out = r.stdout.toString().trim();
  if (r.exitCode !== 0 || !out) return null;
  const [stat, ...start] = out.split(/\s+/);
  return stat!.startsWith("Z") ? null : start.join(" ");
}
