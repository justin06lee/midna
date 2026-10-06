import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromMakima, fromTailscale } from "../src/discover.ts";
import { dq, explainSsh, findBuild, platformOf, signInHint } from "../src/install.ts";

describe("discovery", () => {
  test("makima peers, with midna spotted among their published services", () => {
    const devices = fromMakima({
      node: { name: "justin06lee", address: "10.77.0.3" },
      peers: [
        { name: "tenet", address: "10.77.0.1", online: true, services: [{ name: "ollama", port: 11434 }, { name: "midna", port: 7717 }] },
        { name: "Huiyuns-MacBook-Air-3.local", address: "10.77.0.2", online: false, services: [] },
      ],
    });
    expect(devices.map((d) => [d.id, d.name, d.sshTarget, d.online, d.midna.running])).toEqual([
      ["makima:tenet", "tenet", "10.77.0.1", true, true],
      ["makima:Huiyuns-MacBook-Air-3.local", "Huiyuns-MacBook-Air-3", "10.77.0.2", false, false],
    ]);
  });

  test("tailscale peers: ssh by MagicDNS name, listen on the tailnet IPv4", () => {
    const [d] = fromTailscale({
      Peer: { nodekey1: { HostName: "tenet", DNSName: "tenet.tail1234.ts.net.", TailscaleIPs: ["fd7a:115c::1", "100.101.102.103"], Online: true, OS: "linux" } },
    });
    expect(d).toMatchObject({ id: "tailscale:tenet", address: "100.101.102.103", sshTarget: "tenet.tail1234.ts.net", listen: "100.101.102.103", os: "linux", online: true });
  });
});

describe("installing", () => {
  test("uname to a build platform", () => {
    expect(platformOf("Linux x86_64")).toBe("linux-x64");
    expect(platformOf("Linux aarch64\n")).toBe("linux-arm64");
    expect(platformOf("Darwin arm64")).toBe("darwin-arm64");
    expect(platformOf("Darwin x86_64")).toBe("darwin-x64");
    expect(platformOf("FreeBSD amd64")).toBeNull();
  });

  test("values are quoted safely for the remote shell", () => {
    expect(dq("America/Los_Angeles")).toBe('"America/Los_Angeles"');
    expect(dq('a"b$c`d\\e')).toBe('"a\\"b\\$c\\`d\\\\e"');
    expect(() => dq("it's")).toThrow(/single quote/);
  });

  test("SSH failures become something to do", () => {
    const tenet = { name: "tenet", via: "makima" as const };
    expect(explainSsh("ssh: connect to host 10.77.0.1 port 22: Connection refused", tenet).hint).toContain("makima sshd -on");
    expect(explainSsh("justin@10.77.0.1: Permission denied (publickey).", tenet).message).toContain("SSH key");
    expect(explainSsh("Host key verification failed.", tenet).hint).toContain("ssh-keygen -R");
    expect(explainSsh("ssh: connect to host x port 22: Connection timed out", { name: "box", via: "tailscale" }).message).toBe("box didn't answer.");
  });

  test("sign-in hints read like instructions", () => {
    expect(signInHint("tenet", "claude (then /login)")).toBe("Run `claude` on tenet and type /login to sign in, then try again.");
    expect(signInHint("tenet", "codex login")).toBe("Run `codex` on tenet to sign in, then try again.");
  });

  test("builds are found in kits, compressed or not", () => {
    const dir = mkdtempSync(join(tmpdir(), "midna-kits-"));
    writeFileSync(join(dir, "midna-linux-x64.gz"), "x");
    writeFileSync(join(dir, "midna-darwin-arm64"), "x");
    expect(findBuild("linux-x64", [dir])).toEqual({ path: join(dir, "midna-linux-x64.gz"), gz: true });
    expect(findBuild("darwin-arm64", [dir])).toEqual({ path: join(dir, "midna-darwin-arm64"), gz: false });
    expect(findBuild("darwin-x64", [dir])).toBeNull();
    rmSync(dir, { recursive: true });
  });
});
