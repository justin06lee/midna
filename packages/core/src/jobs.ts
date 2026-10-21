import type { Database } from "bun:sqlite";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import type { Schedule } from "./schedule.ts";

/**
 * Long work midna starts from a turn — a render, a build, a `claude -p`
 * run — that has to outlive the turn's process. The daemon runs each job
 * detached, in a folder of its own (its log, exit code and pid); this is
 * the record of it, kept across restarts, and the wakeup that tells midna
 * how it ended.
 */

export type JobStatus = "running" | "done" | "failed" | "stopped" | "timeout";

export interface Job {
  id: number;
  label: string;
  command: string;
  cwd: string;
  /** The job's own folder: run.sh, log, pid, exit. */
  dir: string;
  log_path: string;
  /** Where the job leaves its result, when it says. */
  result_path: string | null;
  /** The systemd user unit it runs in (Linux under systemd), so a service restart doesn't reach it. */
  unit: string | null;
  pid: number | null;
  /** The process's start time as the OS tells it: a pid alone may since belong to another process. */
  pid_started: string | null;
  status: JobStatus;
  exit_code: number | null;
  /** How it ended, in words. */
  reason: string | null;
  timeout_ms: number;
  episode_id: number | null;
  /** The wakeup that tells midna how it ended; none for a job midna stopped itself. */
  wakeup_id: number | null;
  started_at: number;
  ended_at: number | null;
}

/** How much of a log's end goes in a wakeup's prompt. */
export const LOG_TAIL_BYTES = 6_000;
const LOG_TAIL_LINES = 40;

export class Jobs {
  constructor(private db: Database, private schedule: Schedule) {}

  add(j: { label: string; command: string; cwd: string; dir: string; logPath: string; resultPath?: string | null; timeoutMs: number; episodeId?: number | null }, now = Date.now()): Job {
    return this.db
      .query(
        `INSERT INTO jobs (label, command, cwd, dir, log_path, result_path, timeout_ms, episode_id, started_at)
         VALUES ($label, $command, $cwd, $dir, $log, $result, $timeout, $episode, $now) RETURNING *`,
      )
      .get({ label: j.label, command: j.command, cwd: j.cwd, dir: j.dir, log: j.logPath, result: j.resultPath ?? null, timeout: j.timeoutMs, episode: j.episodeId ?? null, now }) as Job;
  }

  /** Its process is up: the pid, that process's start time, and the unit it runs in. */
  launched(id: number, p: { pid: number | null; pidStarted: string | null; unit?: string | null }): void {
    this.db.query("UPDATE jobs SET pid = $pid, pid_started = $started, unit = COALESCE($unit, unit) WHERE id = $id").run({ id, pid: p.pid, started: p.pidStarted, unit: p.unit ?? null });
  }

  get(id: number): Job | null {
    return this.db.query("SELECT * FROM jobs WHERE id = $id").get({ id }) as Job | null;
  }

  running(): Job[] {
    return this.db.query("SELECT * FROM jobs WHERE status = 'running' ORDER BY id").all() as Job[];
  }

  /** The latest jobs, running or not, newest first. */
  recent(limit = 20): Job[] {
    return this.db.query("SELECT * FROM jobs ORDER BY id DESC LIMIT $limit").all({ limit }) as Job[];
  }

  /**
   * The job ended: the first ending counts, later ones (a stop racing the
   * exit) change nothing. Unless midna stopped it itself, or `quiet` (it
   * never started, and the tool call said so), a wakeup due now tells it
   * how the job went. Returns the job as it ended, or null.
   */
  end(id: number, e: { status: Exclude<JobStatus, "running">; exitCode?: number | null; reason?: string | null; quiet?: boolean; tz: string }, now = Date.now()): Job | null {
    return this.db.transaction(() => {
      const r = this.db
        .query("UPDATE jobs SET status = $status, exit_code = $code, reason = $reason, ended_at = $now WHERE id = $id AND status = 'running'")
        .run({ id, status: e.status, code: e.exitCode ?? null, reason: e.reason ?? null, now });
      if (r.changes === 0) return null;
      if (e.status !== "stopped" && !e.quiet) {
        const job = this.get(id)!;
        const w = this.schedule.add({ dueAt: now, reason: `job #${id} (${job.label}) ended: ${e.status}`, kind: "followup", createdBy: `job:${id}`, tz: e.tz }, now);
        this.db.query("UPDATE jobs SET wakeup_id = $w WHERE id = $id").run({ w: w.id, id });
      }
      return this.get(id);
    })();
  }

  /** The job whose ending this wakeup reports. */
  forWakeup(wakeupId: number): Job | null {
    return this.db.query("SELECT * FROM jobs WHERE wakeup_id = $w").get({ w: wakeupId }) as Job | null;
  }

  /** Forget jobs that ended before `before`; returns their folders, for the daemon to delete. */
  prune(before: number): string[] {
    const rows = this.db.query("DELETE FROM jobs WHERE status != 'running' AND ended_at < $before RETURNING dir").all({ before }) as Array<{ dir: string }>;
    return rows.map((r) => r.dir);
  }
}

/** The end of a log: its last lines, at most LOG_TAIL_BYTES of them; null when there is no log. */
export function logTail(path: string, maxBytes = LOG_TAIL_BYTES, maxLines = LOG_TAIL_LINES): { text: string; cut: boolean } | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let lines = buf.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    // A read that starts mid-file starts mid-line too.
    if (size > len) lines = lines.slice(1);
    const cut = size > len || lines.length > maxLines;
    return { text: lines.slice(-maxLines).join("\n"), cut };
  } finally {
    closeSync(fd);
  }
}
