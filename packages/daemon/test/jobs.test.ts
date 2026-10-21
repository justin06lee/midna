import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store, type Job } from "@midna/core";
import type { Brain, BrainRun } from "@midna/agent";
import { JobRunner, processStart, startDaemon, type RunningDaemon } from "../src/index.ts";

/**
 * Jobs: long work run detached from midna's turns. The runner against real
 * processes (setsid here; systemd-run through a stand-in that records how
 * it was called), then the daemon: the tools a brain calls, the wakeup that
 * reports a job's end, and a restart in the middle of one.
 */

const TZ = "America/Los_Angeles";
const tmp = mkdtempSync(join(tmpdir(), "midna-jobs-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function until<T>(what: string, fn: () => T | undefined | null | false, ms = 8_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The processes in a process group. */
const group = (pgid: number) =>
  Bun.spawnSync(["pgrep", "-g", String(pgid)], { stdout: "pipe" })
    .stdout.toString()
    .split("\n")
    .filter(Boolean)
    .map(Number);

let n = 0;
function runner(o: Partial<ConstructorParameters<typeof JobRunner>[0]> = {}) {
  const home = join(tmp, `r${++n}`);
  mkdirSync(join(home, "workspace"), { recursive: true });
  const store = o.store ?? Store.open(join(home, "midna.db"));
  store.updateSettings({ timezone: TZ });
  const ended: Job[] = [];
  const r = new JobRunner({ store, root: join(home, "jobs"), workspace: join(home, "workspace"), launcher: "setsid", pollMs: 50, killGraceMs: 300, onEnded: (j) => ended.push(j), ...o });
  return { r, store, ended, home };
}
const start = (r: JobRunner, command: string, more: Partial<Parameters<JobRunner["start"]>[0]> = {}) => r.start({ label: "test", command, episodeId: null, ...more });

describe("the runner", () => {
  test("a job runs detached, in a session of its own, and its exit code ends it", async () => {
    const { r, store, ended } = runner();
    const job = await start(r, 'echo "in $PWD as $MIDNA_JOB_ID"; sleep 0.3; exit 3');
    expect(job.pid).toBeGreaterThan(1);
    expect(job.pid_started).toBe(processStart(job.pid!));
    // Its own process group: what stops midna's doesn't reach it, and stopping it reaches all of it.
    expect(group(job.pid!)).toContain(job.pid!);
    const done = await until("the job's end", () => ended[0]);
    expect(done).toMatchObject({ id: job.id, status: "failed", exit_code: 3, reason: null });
    expect(readFileSync(done.log_path, "utf8")).toBe(`in ${job.cwd} as ${job.id}\n`);
    expect(store.jobs.forWakeup(done.wakeup_id!)!.id).toBe(job.id);
    r.shutdown();
  });

  test("stop kills the whole process group, and midna isn't woken about it", async () => {
    const { r, store, ended } = runner();
    const job = await start(r, "sleep 30 & sleep 30; wait");
    await until("both sleeps", () => group(job.pid!).length >= 3);
    const stopped = r.stop(job.id);
    expect(stopped).toMatchObject({ status: "stopped", wakeup_id: null });
    await until("the group gone", () => group(job.pid!).length === 0);
    expect(() => r.stop(job.id)).toThrow("isn't running");
    await Bun.sleep(200);
    expect(ended).toEqual([]);
    expect(store.schedule.pending(10)).toEqual([]);
    r.shutdown();
  });

  test("a job past its time limit is stopped with everything it started, and midna is told", async () => {
    const { r, ended } = runner();
    const job = await start(r, "sleep 30 & sleep 30; wait", { timeoutMs: 1_000 });
    const out = await until("the timeout", () => ended[0], 5_000);
    expect(out).toMatchObject({ status: "timeout", exit_code: null });
    expect(out.reason).toContain("time limit");
    expect(out.wakeup_id).toBeNumber();
    await until("the group gone", () => group(job.pid!).length === 0);
    r.shutdown();
  });

  test("what it can't do, it says", async () => {
    const { r, store } = runner();
    await expect(start(r, "true", { cwd: "/no/such/folder" })).rejects.toThrow("no folder");
    await expect(r.start({ label: "x", episodeId: null })).rejects.toThrow("either a command or a prompt");
    await expect(r.start({ label: "x", command: "true", prompt: "hi", episodeId: null })).rejects.toThrow("either a command or a prompt");
    await expect(start(r, "true", { label: "  " })).rejects.toThrow("label");
    await expect(start(r, "true", { resultFile: "out.txt" })).rejects.toThrow("absolute");
    store.updateSettings({ mode: "ask" });
    await expect(start(r, "true")).rejects.toThrow("ask mode");
    store.updateSettings({ mode: "autonomous" });
    const { r: none } = runner({ claudeBin: null });
    await expect(none.start({ label: "x", prompt: "hi", episodeId: null })).rejects.toThrow("claude isn't on");
    expect(store.jobs.running()).toEqual([]);
    r.shutdown();
    none.shutdown();
  });

  test("a prompt runs claude -p with midna's model, and its answer is the result", async () => {
    const bin = join(tmp, "fake-claude");
    writeFileSync(bin, '#!/bin/sh\necho "args: $*"\ncat\n');
    chmodSync(bin, 0o755);
    const { r, ended } = runner({ claudeBin: bin });
    const job = await r.start({ label: "think", prompt: "what's 2+2?\nshow work", episodeId: null });
    expect(job.result_path).toBe(join(job.dir, "result.md"));
    await until("the job's end", () => ended[0]);
    expect(readFileSync(job.result_path!, "utf8")).toBe("args: -p --output-format text --model opus --dangerously-skip-permissions\nwhat's 2+2?\nshow work");
    r.shutdown();
  });

  test("restarts: what ended meanwhile is settled from its exit file, a job killed meanwhile failed, a live one is kept", async () => {
    const first = runner();
    const quick = await start(first.r, "exit 0");
    const killed = await start(first.r, "sleep 30");
    const slow = await start(first.r, "sleep 1; echo finished");
    // midna stops: its runner goes, the jobs don't.
    first.r.shutdown();
    await until("the quick one's exit file", () => existsSync(join(quick.dir, "exit")));
    process.kill(-killed.pid!, "SIGKILL");
    await until("the killed one gone", () => processStart(killed.pid!) === null);

    const again = runner({ store: first.store });
    expect(again.r.reconcile()).toBe(1);
    expect(first.store.jobs.get(quick.id)).toMatchObject({ status: "done", exit_code: 0, reason: "it ended while midna was down" });
    expect(first.store.jobs.get(killed.id)!.status).toBe("failed");
    expect(first.store.jobs.get(killed.id)!.reason).toContain("no exit code");
    expect(first.store.jobs.get(killed.id)!.wakeup_id).toBeNumber();
    const late = await until("the slow one's end", () => again.ended.find((j) => j.id === slow.id));
    expect(late).toMatchObject({ status: "done", exit_code: 0, reason: null });
    expect(readFileSync(late.log_path, "utf8")).toBe("finished\n");
    again.r.shutdown();
  }, 15_000);

  test("a pid the OS has given to another process is not the job", async () => {
    const { r, store } = runner();
    const job = store.jobs.add({ label: "gone", command: "true", cwd: tmp, dir: join(tmp, "nowhere"), logPath: join(tmp, "nowhere", "log"), timeoutMs: 60_000 });
    // This test's own process, as if it had the job's pid: alive, but started at another time.
    store.jobs.launched(job.id, { pid: process.pid, pidStarted: "Thu Jan  1 00:00:00 1970" });
    r.reconcile();
    expect(store.jobs.get(job.id)).toMatchObject({ status: "failed" });
    // And it wasn't signalled: we're still here.
    r.shutdown();
  });

  // Stand-ins for systemd-run and systemctl. systemd-run records how it was called and starts the
  // command in a session of its own, as a unit would be, after rewriting it the way systemd does a
  // unit's command line ($$ becomes $: what turned every Jetson job's pid file into "$"). systemctl
  // answers is-active and MainPID from that process, and records a stop.
  const fakeSystemd = () => {
    const bin = mkdtempSync(join(tmp, "fake-systemd-"));
    writeFileSync(
      join(bin, "systemd-run"),
      `#!/bin/sh
printf '%s\\0' "$@" > "${bin}/systemd-run.args"
unit=""
while [ $# -gt 0 ] && [ "$1" != "/bin/sh" ]; do case "$1" in --unit=*) unit="\${1#--unit=}";; esac; shift; done
perl -MPOSIX -e 'POSIX::setsid(); exec map { s/\\$\\$/\\$/gr } @ARGV or die' "$@" </dev/null >/dev/null 2>&1 &
echo $! > "${bin}/$unit.mainpid"
exit 0
`,
    );
    writeFileSync(
      join(bin, "systemctl"),
      `#!/bin/sh
for u; do :; done
case "$2" in
  is-active) kill -0 "$(cat "${bin}/$u.mainpid" 2>/dev/null)" 2>/dev/null ;;
  show) if [ -n "$NO_MAINPID" ]; then echo 0; else cat "${bin}/$u.mainpid" 2>/dev/null || echo 0; fi ;;
  stop) printf '%s\\n' "$@" > "${bin}/systemctl.args" ;;
esac
`,
    );
    chmodSync(join(bin, "systemd-run"), 0o755);
    chmodSync(join(bin, "systemctl"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    return { bin, restore: () => (process.env.PATH = path) };
  };

  test("under systemd each job gets a transient user unit of its own, and nothing systemd rewrites reaches its command line", async () => {
    const { bin, restore } = fakeSystemd();
    try {
      const { r, ended } = runner({ launcher: "systemd" });
      const job = await start(r, "echo unit-ok in $MIDNA_JOB_ID");
      expect(job.unit).toMatch(/^midna-job-[a-z0-9]+-[0-9a-f]{6}$/);
      const args = readFileSync(join(bin, "systemd-run.args"), "utf8").split("\0").filter(Boolean);
      expect(args.slice(0, 4)).toEqual(["--user", "--quiet", "--collect", `--unit=${job.unit}`]);
      expect(args).toContain(`--setenv=MIDNA_JOB_DIR=${job.dir}`);
      expect(args).toContain(`--setenv=PATH=${process.env.PATH}`);
      expect(args.some((a) => a.startsWith("--setenv=INVOCATION_ID="))).toBe(false);
      // The command line is the shell and a path, and the path holds no $, % or \.
      expect(args.slice(args.indexOf("/bin/sh"))).toEqual(["/bin/sh", join(job.dir, "wrapper.sh")]);
      expect(job.dir).not.toMatch(/[$%\\]/);
      // The pid is the wrapper's, as systemd's MainPID would be.
      expect(job.pid).toBe(Number(readFileSync(join(bin, `${job.unit}.mainpid`), "utf8")));
      expect(readFileSync(join(job.dir, "pid"), "utf8").trim()).toBe(String(job.pid));
      const done = await until("the job's end", () => ended[0]);
      expect(done).toMatchObject({ status: "done", exit_code: 0 });
      expect(readFileSync(done.log_path, "utf8")).toBe(`unit-ok in ${job.id}\n`);

      const long = await start(r, "sleep 30");
      r.stop(long.id);
      await until("systemctl stop", () => existsSync(join(bin, "systemctl.args")) && readFileSync(join(bin, "systemctl.args"), "utf8"));
      expect(readFileSync(join(bin, "systemctl.args"), "utf8").trim().split("\n")).toEqual(["--user", "stop", "--no-block", long.unit!]);
      await until("its group gone", () => group(long.pid!).length === 0);
      r.shutdown();
    } finally {
      restore();
    }
  });

  test("a pid file that's missing or garbage while the unit runs: still running, no failure, and the real end still comes", async () => {
    const { restore } = fakeSystemd();
    process.env.NO_MAINPID = "1";
    try {
      const { r, store, ended } = runner({ launcher: "systemd", startGraceMs: 100 });
      const job = await start(r, "sleep 1; echo finished");
      // What the Jetson saw: a "$" in the pid file, so no pid at all.
      writeFileSync(join(job.dir, "pid"), "$\n");
      store.jobs.launched(job.id, { pid: null, pidStarted: null });
      await Bun.sleep(600);
      expect(store.jobs.get(job.id)!.status).toBe("running");
      expect(ended).toEqual([]);
      const done = await until("the job's end", () => ended[0]);
      expect(done).toMatchObject({ id: job.id, status: "done", exit_code: 0, reason: null });
      expect(done.wakeup_id).toBeNumber();
      r.shutdown();
    } finally {
      delete process.env.NO_MAINPID;
      restore();
    }
  }, 10_000);
});

describe("the daemon", () => {
  let home: string;
  let daemon: RunningDaemon;
  let tools: Client;
  const runs: BrainRun[] = [];
  const brain: Brain = async (run) => {
    runs.push(run);
    return { text: "ok", sessionId: `s-${runs.length}`, costUsd: 0 };
  };
  const options = () => ({ home, port: 17000 + Math.floor(Math.random() * 20000), brain, tickMs: 3_000, introDelayMs: 10, coalesceMs: 50, jobs: { launcher: "setsid" as const, pollMs: 50 } });

  async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; error: boolean }> {
    const r = (await tools.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
    return { text: r.content.map((c) => c.text ?? "").join("\n"), error: !!r.isError };
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "midna-jobs-daemon-"));
    daemon = await startDaemon(options());
    daemon.store.updateSettings({ quietHours: null, timezone: TZ });
    const intro = await until("a brain run", () => runs[0]);
    tools = new Client({ name: "fake-brain", version: "0" });
    await tools.connect(new StreamableHTTPClientTransport(new URL(intro.mcp.url), { requestInit: { headers: { authorization: `Bearer ${intro.mcp.token}` } } }));
  }, 15_000);

  afterAll(async () => {
    await tools.close().catch(() => {});
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("a job started from a turn outlives it, and its end wakes midna with the result", async () => {
    const result = join(home, "answer.txt");
    const started = await tool("job_start", { label: "count", command: `sleep 0.5; echo working; echo 42 > ${result}; exit 0`, result_file: result, when_done: "the user asked for the count" });
    expect(started.error).toBe(false);
    const id = Number(started.text.match(/job #(\d+)/)![1]);
    expect(started.text).toContain("You'll be woken when it ends");
    expect((await tool("job_list")).text).toContain('"status": "running"');
    // The scheduler's tick is 3 s here: the job's end runs it at once.
    const woke = await until("the job's wakeup", () => runs.find((r) => r.prompt.includes(`Job #${id} "count" finished (exit code 0)`)), 4_000);
    expect(woke.prompt).toContain("Background notification — the user did not send this. A job you started has ended.");
    // A short result is in the prompt as it is, so midna quotes it rather than guessing.
    expect(woke.prompt).toContain(`- result: ${result} (3 bytes), all of it:\n\`\`\`\n42\n\`\`\``);
    // The wakeup has no chat to remember: what to do comes with it.
    expect(woke.prompt).toContain('you meant to do this when it ended: "the user asked for the count"');
    expect(woke.prompt).toContain("Its log:\n```\nworking\n```");
    expect((await tool("job_list", { ended: true })).text).toContain('"exit_code": 0');
    expect((await tool("job_list")).text).toBe("no jobs running");
  });

  test("job_stop through the tools; ask mode refuses to start one", async () => {
    const started = await tool("job_start", { label: "forever", command: "sleep 30" });
    const id = Number(started.text.match(/job #(\d+)/)![1]);
    expect((await tool("job_stop", { id })).text).toMatch(new RegExp(`stopped job #${id} \\(forever\\) after \\d+ s`));
    expect((await tool("job_stop", { id })).error).toBe(true);
    daemon.store.updateSettings({ mode: "ask" });
    const refused = await tool("job_start", { label: "nope", command: "true" });
    expect(refused).toMatchObject({ error: true });
    expect(refused.text).toContain("ask mode");
    daemon.store.updateSettings({ mode: "autonomous" });
  });

  test("a job that ends while midna is down wakes it once it's back", async () => {
    const job = await daemon.jobs.start({ label: "overnight", command: "sleep 0.4; echo done", episodeId: null });
    await daemon.stop();
    await until("its exit file", () => existsSync(join(job.dir, "exit")));
    daemon = await startDaemon(options());
    const woke = await until("the job's wakeup", () => runs.find((r) => r.prompt.includes(`Job #${job.id} "overnight" finished (exit code 0) — it ended while midna was down.`)), 4_000);
    expect(woke.prompt).toContain("Its log:\n```\ndone\n```");
    // The tools' episode belonged to the first run; the next test has none.
    await tools.close().catch(() => {});
  }, 15_000);
});
