import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_ID, refuseInstall, signer, type InstallFacts } from "../scripts/guard.ts";

const adHoc = (over: Partial<InstallFacts> = {}): InstallFacts => ({ bundleId: BUNDLE_ID, build: "adhoc", identity: false, installed: "none", allowAdHoc: false, ...over });

describe("installing midna.app", () => {
  test("an ad-hoc build is refused where the identity is, usable yet or not (make app at 14:43 and 21:36)", () => {
    const refusal = refuseInstall(adHoc({ identity: true, installed: "adhoc" }));
    expect(refusal).toContain(`"midna dev" is on this Mac, but codesign can't use it yet`);
    expect(refusal).toContain("bun run signing");
    expect(refusal).toContain("make signing");
    expect(refusal).toContain("MIDNA_ALLOW_ADHOC=1 make app");
  });

  test("an ad-hoc build never replaces a signed midna.app, identity or not", () => {
    expect(refuseInstall(adHoc({ installed: "midna dev" }))).toContain(`the installed midna.app is signed with "midna dev" and this build isn't`);
    expect(refuseInstall(adHoc({ installed: "other" }))).toContain("the installed midna.app is signed and this build isn't");
  });

  test("a signed build installs; so does an ad-hoc one where nothing is lost, or when asked for", () => {
    expect(refuseInstall(adHoc({ build: "midna dev", identity: true, installed: "midna dev" }))).toBeNull();
    expect(refuseInstall(adHoc({ build: "midna dev", identity: true, installed: "adhoc" }))).toBeNull();
    // A Mac that never made the identity, with no signed app to lose: ad hoc, as before.
    expect(refuseInstall(adHoc())).toBeNull();
    expect(refuseInstall(adHoc({ installed: "adhoc" }))).toBeNull();
    expect(refuseInstall(adHoc({ identity: true, installed: "midna dev", allowAdHoc: true }))).toBeNull();
  });

  test("test copies under another bundle id aren't midna.app and aren't guarded", () => {
    expect(refuseInstall(adHoc({ bundleId: "sh.midna.desktop.test", identity: true, installed: "midna dev" }))).toBeNull();
  });

  test.skipIf(process.platform !== "darwin")("who signed an app is read from its signature, without signing anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "midna-guard-"));
    try {
      expect(signer(join(dir, "missing.app"))).toBe("none");
      const unsigned = join(dir, "unsigned.app", "Contents", "MacOS");
      mkdirSync(unsigned, { recursive: true });
      writeFileSync(join(unsigned, "midna"), "#!/bin/sh\n");
      expect(signer(join(dir, "unsigned.app"))).toBe("adhoc");
      // Apple signs its own apps: a signature with an authority that isn't "midna dev".
      expect(signer("/System/Applications/Calculator.app")).toBe("other");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
