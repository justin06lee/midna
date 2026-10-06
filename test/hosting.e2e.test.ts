import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { MidnaClient, type InstallEvent } from "@midna/protocol";
import { install } from "../clients/cli/src/install.ts";

/**
 * The whole "make this machine midna's home" path, for real, on this
 * machine: compile the current code, install it into a throwaway directory
 * as a background process, start it, pair with it, talk to it. Only SSH is
 * left out — the same steps run over it for a remote machine.
 */

const plat = `${platform()}-${arch() === "x64" ? "x64" : "arm64"}`;
let kits: string;
let home: string;
let bin: string;
const port = 27000 + Math.floor(Math.random() * 900);

beforeAll(() => {
  kits = mkdtempSync(join(tmpdir(), "midna-kit-"));
  home = mkdtempSync(join(tmpdir(), "midna-host-"));
  bin = join(home, "midna");
  const r = Bun.spawnSync(["bun", "build", join(import.meta.dir, "..", "clients/cli/src/main.ts"), "--compile", "--outfile", join(kits, `midna-${plat}`)], { stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
});

afterAll(() => {
  Bun.spawnSync(["pkill", "-f", `[${bin[0]}]${bin.slice(1)} serve`]);
  rmSync(kits, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("install on this machine: binary, start, pair, talk", async () => {
  const events: InstallEvent[] = [];
  const ok = await install(
    { id: "local", name: "here", via: "local", address: "127.0.0.1", sshTarget: null, online: true, self: true, midna: { running: false } },
    { model: "claude:sonnet", timezone: "America/Los_Angeles", mode: "autonomous", port, home, bin, noService: true, noIntro: true, skipBrainCheck: true, kits: [kits], deviceName: "test" },
    (e) => events.push(e),
  );
  const failed = events.find((e) => e.type === "failed");
  expect(failed).toBeUndefined();
  expect(ok).toBe(true);

  const steps = events.filter((e): e is Extract<InstallEvent, { type: "step" }> => e.type === "step" && e.status !== "running").map((e) => `${e.id}:${e.status}`);
  expect(steps).toEqual(["reach:done", "binary:done", "brain:skipped", "start:done", "pair:done"]);
  expect(events.some((e) => e.type === "progress")).toBe(true);

  const done = events.find((e): e is Extract<InstallEvent, { type: "done" }> => e.type === "done")!;
  expect(done.connection.url).toBe(`http://127.0.0.1:${port}`);
  const midna = new MidnaClient(done.connection.url, done.connection.token);
  const status = await midna.status();
  expect(status.model).toBe("claude:sonnet");
  expect(status.timezone).toBe("America/Los_Angeles");
  expect((await midna.devices()).map((d) => d.name)).toContain("test");

  // A second run finds it running and current, and only pairs again.
  const again: InstallEvent[] = [];
  expect(
    await install(
      { id: "local", name: "here", via: "local", address: "127.0.0.1", sshTarget: null, online: true, self: true, midna: { running: true, version: status.version } },
      { model: "claude:opus", timezone: "UTC", mode: "ask", port, home, bin, noService: true, kits: [kits] },
      (e) => again.push(e),
    ),
  ).toBe(true);
  expect(again.filter((e) => e.type === "step" && e.status === "skipped").map((e) => (e as { id: string }).id)).toEqual(["binary", "brain", "start"]);
  expect((await midna.status()).model).toBe("claude:sonnet"); // an existing install keeps its settings
}, 120_000);
