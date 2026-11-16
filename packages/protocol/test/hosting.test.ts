import { describe, expect, test } from "bun:test";
import { httpsCandidates, onTailnet, serveCommand, webViewBlocks } from "../src/hosting.ts";

describe("HTTPS on the tailnet", () => {
  test("tailnet addresses: 100.64.0.0/10, Tailscale's IPv6 range, MagicDNS names", () => {
    expect(onTailnet("100.74.137.16")).toBe(true);
    expect(onTailnet("100.64.0.1")).toBe(true);
    expect(onTailnet("100.127.255.254")).toBe(true);
    expect(onTailnet("[fd7a:115c:a1e0::7c33:8911]")).toBe(true);
    expect(onTailnet("midna.tailddc9d9.ts.net")).toBe(true);
    expect(onTailnet("100.128.0.1")).toBe(false);
    expect(onTailnet("100.63.0.1")).toBe(false);
    expect(onTailnet("10.77.0.1")).toBe(false);
    expect(onTailnet("127.0.0.1")).toBe(false);
  });

  test("plain http to a tailnet address is what the app's window can't load (the Mac mini and the MacBook Pro, 2026-11-15)", () => {
    expect(webViewBlocks("http://100.74.137.16:7717")).toBe(true);
    expect(webViewBlocks("http://midna.tailddc9d9.ts.net:7717")).toBe(true);
    expect(webViewBlocks("https://midna.tailddc9d9.ts.net:8443")).toBe(false);
    expect(webViewBlocks("http://127.0.0.1:7717")).toBe(false);
    expect(webViewBlocks("http://10.77.0.1:7717")).toBe(false);
    expect(webViewBlocks("not a url")).toBe(false);
  });

  test("candidates: the advertised address first, then the MagicDNS name on 8443", () => {
    expect(httpsCandidates({ ssh: "midna.tailddc9d9.ts.net", https: "https://midna.tailddc9d9.ts.net:9443/" })).toEqual(["https://midna.tailddc9d9.ts.net:9443", "https://midna.tailddc9d9.ts.net:8443"]);
    expect(httpsCandidates({ ssh: "midna.tailddc9d9.ts.net", https: "https://midna.tailddc9d9.ts.net:8443" })).toEqual(["https://midna.tailddc9d9.ts.net:8443"]);
    expect(httpsCandidates({ ssh: "justin@midna.tailddc9d9.ts.net." })).toEqual(["https://midna.tailddc9d9.ts.net:8443"]);
    // An IP to SSH to says nothing of a name with a certificate.
    expect(httpsCandidates({ ssh: "100.74.137.16" })).toEqual([]);
    expect(httpsCandidates({ ssh: null, https: "http://not-https" })).toEqual([]);
  });

  test("the command that gives midna an HTTPS address", () => {
    expect(serveCommand(7717)).toBe("tailscale serve --bg --https=8443 http://127.0.0.1:7717");
  });
});
