import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MidnaClient } from "@midna/protocol";
import { findByTitle, startDaemon, Vault, vaultSettings, type RunningDaemon, type VaultSettings } from "../src/index.ts";

/**
 * The vault against a stand-in for Bitwarden's CLI (fake-bw.ts), which logs
 * every command line it was given: no secret may ever be on one.
 */

const MASTER = "master-pw-not-in-argv";
const GITHUB_PW = "gh-secret-0001";
const FAKE = join(import.meta.dir, "fake-bw.ts");

function fakeVault(root: string, extra: Record<string, unknown> = {}): VaultSettings {
  const data = join(root, "bw");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, "master"), `${MASTER}\n`, { mode: 0o600 });
  writeFileSync(
    join(data, "fake.json"),
    JSON.stringify({
      serverUrl: null,
      email: "midna@ghostly.local",
      password: MASTER,
      status: "unauthenticated",
      generation: 0,
      collections: [{ id: "col-midna", name: "midna", organizationId: "org-1" }],
      items: [
        { id: "gh", type: 1, name: "GitHub", organizationId: "org-1", collectionIds: ["col-midna"], revisionDate: "2026-11-01T00:00:00.000Z", login: { username: "justin06lee", password: GITHUB_PW, uris: [{ match: null, uri: "https://github.com" }] } },
        { id: "bank", type: 1, name: "Bank", reprompt: 1, login: { username: "j", password: "bank-secret-0002", uris: [] } },
        { id: "note", type: 2, name: "A secure note", notes: "not a login" },
      ],
      ...extra,
    }),
  );
  return { server: "https://localhost:8222", email: "midna@ghostly.local", passwordFile: join(root, "master"), bw: [process.execPath, FAKE], dataDir: data, collection: "midna" };
}

const argvLog = (s: VaultSettings) => readFileSync(join(s.dataDir, "calls.log"), "utf8");
const fakeState = (s: VaultSettings) => JSON.parse(readFileSync(join(s.dataDir, "fake.json"), "utf8")) as { items: Array<Record<string, any>>; status: string };

describe("the vault, over Bitwarden's CLI", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "midna-vault-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("lists logins without their passwords, adds, edits, hands one out and trashes — no secret on any command line", async () => {
    const s = fakeVault(join(root, "a"));
    const v = new Vault(s);
    const listed = await v.list();
    expect(listed.map((i) => i.title)).toEqual(["Bank", "GitHub"]); // logins only, by title
    expect(listed.find((i) => i.id === "gh")).toEqual({ id: "gh", title: "GitHub", username: "justin06lee", url: "https://github.com", shared: true, updatedAt: Date.parse("2026-11-01T00:00:00.000Z") });
    expect(JSON.stringify(listed)).not.toContain(GITHUB_PW);

    // A new login goes where the user sees it too: the collection shared with midna.
    const added = await v.add({ title: "Netflix", username: "j@example.com", url: "https://netflix.com", password: "nf-secret-0003" });
    expect(added).toMatchObject({ title: "Netflix", username: "j@example.com", url: "https://netflix.com", shared: true });

    const edited = await v.edit(added.id, { title: "Netflix (family)", password: "nf-secret-0004", url: "" });
    expect(edited).toMatchObject({ title: "Netflix (family)", username: "j@example.com", url: null });
    expect(fakeState(s).items.find((i) => i.id === added.id)!.login.password).toBe("nf-secret-0004");

    expect((await v.password(added.id)).password).toBe("nf-secret-0004");
    expect((await v.find("netflix")).map((i) => i.id)).toEqual([added.id]);

    await v.remove(added.id);
    expect((await v.list()).map((i) => i.title)).toEqual(["Bank", "GitHub"]);
    await expect(v.edit("nope", { title: "x" })).rejects.toMatchObject({ status: 404 });

    const argv = argvLog(s);
    for (const secret of [MASTER, GITHUB_PW, "nf-secret-0003", "nf-secret-0004", "fake-session-key"]) expect(argv).not.toContain(secret);
    expect(argv).toContain("--passwordfile");
    await v.lock();
    expect(fakeState(s).status).toBe("locked");
  });

  test("a login marked re-prompt isn't handed to another program", async () => {
    const v = new Vault(fakeVault(join(root, "b")));
    await expect(v.password("bank", { forAnotherProgram: true })).rejects.toMatchObject({ status: 409 });
    expect((await v.password("bank")).password).toBe("bank-secret-0002");
  });

  test("a vault locked under it is opened again; a read-only shared collection leaves a new login midna's own", async () => {
    const s = fakeVault(join(root, "c"), { readOnly: ["col-midna"] });
    const v = new Vault(s);
    await v.list();
    writeFileSync(join(s.dataDir, "fake.json"), JSON.stringify({ ...fakeState(s), status: "locked" }));
    expect((await v.add({ title: "Wi-Fi", password: "wifi-secret-0005" })).shared).toBe(false);
  });

  test("finding by title: the exact title first, then titles that hold it, then a username or website", () => {
    const items = [
      { id: "1", title: "GitHub", username: "a", url: null, shared: false, updatedAt: null },
      { id: "2", title: "GitHub (work)", username: "b", url: null, shared: false, updatedAt: null },
      { id: "3", title: "Mail", username: "c", url: "https://fastmail.com", shared: false, updatedAt: null },
    ];
    expect(findByTitle(items, "github").map((i) => i.id)).toEqual(["1"]);
    expect(findByTitle(items, "git").map((i) => i.id)).toEqual(["1", "2"]);
    expect(findByTitle(items, "fastmail").map((i) => i.id)).toEqual(["3"]);
    expect(findByTitle(items, "  ")).toEqual([]);
  });

  test("no ghostly password for midna on this host: no vault, and it says why", () => {
    const home = join(root, "nohome");
    expect(vaultSettings(home, { bw: ["bw"] })).toEqual({ missing: expect.stringContaining("ghostly_midna") });
    mkdirSync(join(home, "secrets"), { recursive: true });
    writeFileSync(join(home, "secrets", "ghostly_midna"), "x\n");
    expect(vaultSettings(home, { bw: ["bw"] })).toMatchObject({ server: "https://localhost:8222", email: "midna@ghostly.local", dataDir: join(home, "vault"), collection: "midna" });
  });
});

describe("the vault through midna's API", () => {
  let home: string;
  let daemon: RunningDaemon;
  let settings: VaultSettings;
  let host: MidnaClient;
  const logged: string[] = [];
  let spy: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "midna-vault-api-"));
    settings = fakeVault(join(home, "fake"));
    spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    daemon = await startDaemon({ home, port: 17000 + Math.floor(Math.random() * 20000), brain: async () => ({ text: "No reply needed", sessionId: "s" }), introDelayMs: 60 * 60_000, vault: settings });
    host = new MidnaClient(daemon.url, readFileSync(join(home, "host.token"), "utf8").trim());
  });
  afterAll(async () => {
    await daemon.stop();
    spy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  });

  const token = async (deviceName: string, kind: "desktop" | "mobile" | "bridge" | "cli") => (await new MidnaClient(daemon.url).pair({ code: (await host.pairingCode()).code, deviceName, kind })).token;
  const pair = async (deviceName: string, kind: "desktop" | "mobile" | "bridge" | "cli") => new MidnaClient(daemon.url, await token(deviceName, kind));

  test("the user's own devices list, add, edit, reveal and remove; a bridge and the host can't", async () => {
    const desktop = await pair("Mac", "desktop");
    expect((await desktop.vault()).map((i) => i.title)).toEqual(["Bank", "GitHub"]);
    expect((await desktop.vault("hub")).map((i) => i.title)).toEqual(["GitHub"]);
    const added = await desktop.addToVault({ title: "Router", username: "admin", password: "router-secret-0006" });
    const edited = await desktop.editVault(added.id, { password: "router-secret-0007" });
    expect(edited.title).toBe("Router");
    const phone = await pair("iPhone", "mobile");
    expect(await phone.vaultPassword(added.id)).toEqual({ password: "router-secret-0007" });
    await expect(desktop.editVault(added.id, {})).rejects.toThrow(/nothing to change/);
    await expect(desktop.addToVault({ title: "", password: "x" })).rejects.toThrow(/title and a password/);
    expect(await phone.removeFromVault(added.id)).toEqual({ ok: true });
    await expect(phone.vaultPassword(added.id)).rejects.toMatchObject({ status: 404 });

    const telegram = await pair("Telegram", "bridge");
    await expect(telegram.vault()).rejects.toMatchObject({ status: 403 });
    await expect(host.vault()).rejects.toMatchObject({ status: 403 });

    const said = logged.join("\n");
    expect(said).toContain('Mac added "Router"');
    expect(said).toContain('iPhone was shown the password of "Router"');
    for (const secret of ["router-secret-0006", "router-secret-0007", MASTER]) expect(said).not.toContain(secret);
    for (const secret of ["router-secret-0006", "router-secret-0007", MASTER]) expect(argvLog(settings)).not.toContain(secret);
  });

  test("Hermes finds a login by title through its MCP, and gets a password only by asking for it; nobody else may use the tools", async () => {
    const hermes = await token("Hermes", "bridge");
    const tools = new Client({ name: "hermes", version: "0" });
    await tools.connect(new StreamableHTTPClientTransport(new URL(`${daemon.url}/v1/vault/mcp`), { requestInit: { headers: { authorization: `Bearer ${hermes}` } } }));
    try {
      const listed = (await tools.listTools()).tools;
      expect(listed.map((t) => [t.name, t.annotations?.readOnlyHint])).toEqual([
        ["vault_find", true],
        ["vault_password", false],
      ]);
      const text = async (name: string, args: Record<string, unknown>) => {
        const r = (await tools.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
        return { text: r.content[0]!.text, error: !!r.isError };
      };
      const found = await text("vault_find", { title: "github" });
      expect(found.text).toBe("GitHub · user justin06lee · https://github.com · id gh");
      expect(found.text).not.toContain(GITHUB_PW);
      expect((await text("vault_find", { title: "spotify" })).text).toBe('No login titled "spotify" in the vault.');
      expect(await text("vault_password", { login: "GitHub" })).toEqual({ text: GITHUB_PW, error: false });
      expect(await text("vault_password", { login: "gh" })).toEqual({ text: GITHUB_PW, error: false });
      expect((await text("vault_password", { login: "bank" })).error).toBe(true); // re-prompt: not for Hermes
    } finally {
      await tools.close();
    }
    expect(logged.join("\n")).toContain('vault: Hermes vault_password: handed out the password of "GitHub" (gh)');
    expect(logged.join("\n")).not.toContain(GITHUB_PW);

    const mac = await token("Other Mac", "desktop");
    const r = await fetch(`${daemon.url}/v1/vault/mcp`, { method: "POST", headers: { authorization: `Bearer ${mac}`, "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(403);
  });

  test("with no vault on the host, the apps are told why", async () => {
    const other = mkdtempSync(join(tmpdir(), "midna-novault-"));
    const d = await startDaemon({ home: other, port: 17000 + Math.floor(Math.random() * 20000), brain: async () => ({ text: "ok", sessionId: "s" }), introDelayMs: 60 * 60_000, vault: null });
    try {
      const h = new MidnaClient(d.url, readFileSync(join(other, "host.token"), "utf8").trim());
      const mac = new MidnaClient(d.url, (await new MidnaClient(d.url).pair({ code: (await h.pairingCode()).code, deviceName: "Mac", kind: "desktop" })).token);
      await expect(mac.vault()).rejects.toMatchObject({ status: 503, message: "there's no vault here" });
    } finally {
      await d.stop();
      rmSync(other, { recursive: true, force: true });
    }
  });
});
