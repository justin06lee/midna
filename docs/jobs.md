# Jobs: long work that outlives midna's turn

*Since midna 0.10.0.*

Each of midna's turns runs in its own Claude Code process, and that process ends when the turn does. Shells it starts in the background (`run_in_background`) and subagents end with it. Work that takes longer — a render, a build, a long download, a test suite, a `claude -p` run — goes through the job registry instead. The daemon runs each job detached from the turn, keeps a record of it across restarts, and wakes midna when it ends.

## The tools

- `job_start { label, command | prompt, model?, cwd?, timeout_minutes?, result_file?, when_done? }` starts one and returns at once: `started job #12 (render the deck); log: …`.
  - `command` is bash, run in `cwd` (by default midna's workspace).
  - `prompt` runs `claude -p` with that task instead: a fresh run without midna's tools or the conversation. Its answer goes to `result.md` in the job's folder unless `result_file` says otherwise. `model` picks the Claude model; by default it's the one midna thinks with.
  - The command sees `$MIDNA_JOB_DIR`, the job's folder, and `$MIDNA_JOB_ID`.
  - A job is stopped after `timeout_minutes`: 120 by default, at most 1440.
  - `when_done` says what to do when it ends, e.g. "the user asked to hear what out.txt says". The wakeup that reports the job runs in a session of its own, without the chat the job came from, so this note is all it knows of what the user wanted.
- `job_list { ended? }` lists the running jobs, or with `ended: true` the latest 20 of any state.
- `job_stop { id }` stops a running job and everything it started.

In ask mode, `job_start` is refused, the same as midna's other shell commands on its host.

## When a job ends

A wakeup comes due at once. midna reads, as a background notification rather than the user's words:
- the job's id, label and command;
- how it ended: finished, failed with its exit code, stopped at its time limit, or failed with no exit code;
- how long it ran, and where;
- its log path and the log's last 40 lines (at most 6 KB);
- its result file's path and size, or that it wasn't written; a text result of 4 KB or less is included in full, so midna quotes it rather than guessing;
- its `when_done` note.

Nothing reaches the user unless midna sends it with `message_user`. There is no wakeup for a job midna stopped itself.

## How a job outlives things

Each job has a folder, `MIDNA_HOME/jobs/job-…/`, holding `wrapper.sh`, `run.sh` (the command), `log`, `pid`, and `exit`. The wrapper, a small `sh` script, writes `pid` first and `exit` when the command ends. Only `/bin/sh <its path>` goes on the launch command line: systemd rewrites `$` and `%` there, which in 0.10.0 left a literal `$` in every job's pid file on the Jetson. The exit file is how the daemon learns how a job ended, even if the daemon was down when it did.

- **Linux under systemd (the Jetson):** a restart of `midna.service` kills everything in its cgroup (the default `KillMode=control-group`). So each job runs in a transient user unit of its own, `systemd-run --user --unit midna-job-…`, which is in no cgroup of midna's. `midna.service` itself is unchanged.
- **Elsewhere (launchd on a Mac, a terminal):** the job gets a session and process group of its own (`setsid`). launchd kills a stopped agent's process group, and a terminal's hangup reaches only its own session, so neither reaches the job.

A job counts as running while its unit is active (under systemd) or its process is alive, whatever its pid file says; only a job with neither, and no exit file, 30 seconds after its start, counts as never started.

When the daemon starts, it looks at every job still marked running:
- one with an exit file ended while midna was down, and its exit code says how;
- one whose process is gone with no exit file was killed, or the machine restarted, and it counts as failed;
- one that's still alive is watched again, with its time limit counted from when it started.

The first two wake midna.

A pid alone doesn't identify a process: the OS hands pids out again. Each job's record keeps the process's start time too (`/proc/<pid>/stat` on Linux, `ps -o lstart` on a Mac). A pid whose start time differs is another process, so it's never signalled and never taken for the job.

Stopping a job, by `job_stop` or at its time limit, sends SIGTERM to its whole process group, and SIGKILL 5 seconds later to whatever is left. Under systemd it also stops the job's unit, which reaches processes that left the group.

Ended jobs, with their folders, are forgotten after 30 days. A `result_file` outside the folder is never deleted.
