import type { Job } from "@midna/core";

/**
 * What midna's job tools reach: long work run detached from the turn, so it
 * outlives the turn's process and midna's own restarts (docs/jobs.md). The
 * daemon implements it; when a job ends it queues a wakeup with the result.
 */
export interface JobsHandle {
  /** Start one; throws with a message midna can act on when it can't. */
  start(req: JobStart): Promise<Job>;
  /** The running jobs; with `ended`, the latest of any state. */
  list(opts?: { ended?: boolean }): Job[];
  /** Stop a running job and its whole process group. */
  stop(id: number): Job;
}

export interface JobStart {
  label: string;
  /** A bash command; or */
  command?: string;
  /** a task for a fresh `claude -p` run, whose answer goes to the result file. */
  prompt?: string;
  /** For a prompt: the Claude model; by default the one midna thinks with, when that is Claude. */
  model?: string;
  /** Absolute; midna's workspace when left out. */
  cwd?: string;
  timeoutMs?: number;
  /** Where the job leaves its result, for the wakeup to name. */
  resultFile?: string;
  /** What to do when it ends: the wakeup that reports it has no chat to remember. */
  whenDone?: string;
  episodeId: number | null;
}
