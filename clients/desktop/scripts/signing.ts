/**
 * The stable code-signing identity midna.app is signed with on this Mac,
 * "midna local signing": a self-signed certificate in the login keychain.
 *
 * Why: macOS keeps a permission grant (Screen Recording, Accessibility, Full
 * Disk Access, …) against the app's designated requirement. An ad-hoc
 * signature's requirement is its cdhash, new on every build, so each update
 * looked like a new app and lost its grants. Signed with the same certificate,
 * the requirement — identifier "sh.midna.desktop" and this certificate — stays
 * the same, and the grants survive every rebuild.
 *
 * `bun run signing` creates it once (doing nothing when it exists). It needs
 * no Apple account and isn't trusted: codesign uses it all the same, and
 * trust only matters to Gatekeeper on other Macs. One step needs the login
 * password, once: letting codesign (an "apple:" tool) use the key without
 * asking on every build. Run in a terminal, the script asks for it; otherwise
 * it prints the command. app.ts signs with the identity once it's ready.
 * Back it up with `security export -t identities -f pkcs12` (asks for the
 * login password); losing it means granting the permissions once more.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const SIGNING_IDENTITY = "midna local signing";
const KEYCHAIN = join(homedir(), "Library", "Keychains", "login.keychain-db");

const sh = (argv: string[]) => {
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
};

/** Whether this Mac has the identity. Listed without -v: an untrusted self-signed one isn't "valid", yet codesign signs with it. */
export function hasSigningIdentity(): boolean {
  return process.platform === "darwin" && sh(["security", "find-identity", "-p", "codesigning"]).out.includes(`"${SIGNING_IDENTITY}"`);
}

/** The partitions allowed to use the identity's private key without asking, from the keychain's access lists. */
function keyPartitions(): string[] {
  const dump = sh(["security", "dump-keychain", "-a", KEYCHAIN]).out;
  const record = dump.split(/^keychain: /m).find((r) => r.includes("class: 0x00000010") && r.includes(`0x00000001 <blob>="${SIGNING_IDENTITY}"`));
  const m = record && /authorizations \(\d+\): partition_id\s*\n\s*description: ([^\n]*)/.exec(record);
  return m ? m[1]!.split(",").map((p) => p.trim()).filter(Boolean) : [];
}

/** The command that lets codesign use the key without a prompt — the one step that needs the login password. */
export const ALLOW_CODESIGN = ["security", "set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-t", "private", "-l", SIGNING_IDENTITY, KEYCHAIN];

/** The identity is here and codesign can use it without stopping the build for a password. */
export function signingReady(): boolean {
  return hasSigningIdentity() && keyPartitions().includes("apple:");
}

function create(): void {
  if (process.platform !== "darwin") throw new Error("only macOS signs apps this way");
  if (hasSigningIdentity()) {
    console.log(`"${SIGNING_IDENTITY}" is already in the login keychain`);
    allowCodesign();
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "midna-signing-"));
  try {
    const run = (argv: string[]) => {
      const r = sh(argv);
      if (!r.ok) throw new Error(`${argv[0]} ${argv[1]} failed:\n${r.out}`);
    };
    run([
      "/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-nodes",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-subj", `/CN=${SIGNING_IDENTITY}`,
      "-addext", "basicConstraints=critical,CA:false",
      "-addext", "keyUsage=critical,digitalSignature",
      "-addext", "extendedKeyUsage=critical,codeSigning",
    ]);
    // OpenSSL 3 writes a PKCS#12 that `security` can't read without -legacy; LibreSSL's is fine and has no such flag.
    const legacy = sh(["/usr/bin/openssl", "pkcs12", "-help"]).out.includes("-legacy") ? ["-legacy"] : [];
    run(["/usr/bin/openssl", "pkcs12", "-export", ...legacy, "-inkey", join(dir, "key.pem"), "-in", join(dir, "cert.pem"),
      "-name", SIGNING_IDENTITY, "-out", join(dir, "id.p12"), "-passout", "pass:midna"]);
    // -T: codesign may use the key without asking each build.
    run(["security", "import", join(dir, "id.p12"), "-k", KEYCHAIN, "-P", "midna", "-T", "/usr/bin/codesign"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!hasSigningIdentity()) throw new Error("the identity isn't in the keychain after importing it");
  console.log(`created "${SIGNING_IDENTITY}" in the login keychain`);
  console.log("once, after switching from ad-hoc builds: tccutil reset All sh.midna.desktop, then grant each permission again");
  allowCodesign();
}

function allowCodesign(): void {
  if (signingReady()) return void console.log("codesign can use it; app builds sign with it");
  const quoted = ALLOW_CODESIGN.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(" ");
  if (!process.stdin.isTTY) {
    console.log(`one step left, needing your login password once — run in a terminal:\n  ${quoted}`);
    return;
  }
  console.log("letting codesign use the key without asking on every build — your login password, once:");
  Bun.spawnSync(ALLOW_CODESIGN, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  console.log(signingReady() ? "done; app builds sign with it" : `that didn't take; run it again:\n  ${quoted}`);
}

if (import.meta.main) create();
