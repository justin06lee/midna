/**
 * The code-signing identities midna.app is signed with, best first:
 *
 * 1. "Developer ID Application: …", Apple's certificate for apps shipped
 *    outside the App Store, when the login keychain has a valid one that
 *    codesign may use. app.ts then notarizes the build (the "midna-notary"
 *    notarytool profile) and staples the ticket.
 * 2. "midna dev": a self-signed certificate in the login keychain, made the
 *    way ruri makes "ruri dev" (`bun run signing`).
 * 3. Neither: ad hoc.
 *
 * Why: macOS keeps a permission grant (Screen Recording, Accessibility, Full
 * Disk Access, …) against the app's designated requirement. An ad-hoc
 * signature's requirement is its cdhash, new on every build, so each update
 * looked like a new app and lost its grants. Signed with the same certificate,
 * the requirement — identifier "sh.midna.desktop" and this certificate — stays
 * the same, and the grants survive every rebuild. "midna dev" does that on
 * this Mac only. Developer ID does it with a requirement Apple anchors
 * ("anchor apple generic", the team 65UN46K6FA), the same on every Mac and for
 * any Developer ID certificate of that team, and notarized, Gatekeeper accepts
 * the app anywhere, downloaded or copied, without "unidentified developer".
 *
 * Switching certificates changes the requirement, so the switch from "midna
 * dev" to Developer ID resets the grants once: guard.ts won't install over a
 * "midna dev" midna.app unless asked (MIDNA_SWITCH_SIGNER=1), and Justin
 * grants each permission again. After that they survive every update.
 *
 * `bun run signing` makes "midna dev" once (an identity already there is
 * kept), then does the two steps that need Justin, once each, in a terminal:
 * trusting the certificate for code signing (macOS asks for his password), so
 * it is a valid identity like "ruri dev"; and letting codesign (an "apple:"
 * tool) use its key without asking on every build (his login password). Back
 * it up with `security export -t identities -f pkcs12` (asks for the login
 * password); losing it means granting the permissions once more. A Developer
 * ID certificate comes from developer.apple.com and needs none of this.
 *
 * The notary profile, once per Mac, from the App Store Connect API key in
 * ~/.appstoreconnect/private_keys (no app-specific password), in the GUI
 * session, since it goes into the login keychain:
 *   xcrun notarytool store-credentials midna-notary --key <AuthKey_ID.p8> --key-id <ID> --issuer <issuer>
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const SIGNING_IDENTITY = "midna dev";
/** The notarytool keychain profile app.ts notarizes Developer ID builds with. */
export const NOTARY_PROFILE = "midna-notary";
const KEYCHAIN = join(homedir(), "Library", "Keychains", "login.keychain-db");

const sh = (argv: string[]) => {
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
};

/** Whether this Mac has the identity. Listed without -v: until it's trusted it isn't "valid", yet codesign signs with it. */
export function hasSigningIdentity(): boolean {
  return process.platform === "darwin" && sh(["security", "find-identity", "-p", "codesigning"]).out.includes(`"${SIGNING_IDENTITY}"`);
}

/** The partitions allowed to use an identity's private key without asking, from the keychain's access lists. */
function keyPartitions(identity: string): string[] {
  // The key's application label is the certificate's public-key hash.
  const hpky = /"hpky"<blob>=(0x[0-9A-F]+)/.exec(sh(["security", "find-certificate", "-c", identity, KEYCHAIN]).out)?.[1];
  if (!hpky) return [];
  const dump = sh(["security", "dump-keychain", "-a", KEYCHAIN]).out;
  const record = dump.split(/^keychain: /m).find((r) => r.includes("class: 0x00000010") && r.includes(`<blob>=${hpky}`));
  // "authorizations (1): partition_id", then (on current macOS) "don't-require-password", then "description: apple-tool:".
  const m = record && /authorizations \(\d+\): partition_id\n(?:[^\n]*\n)*?\s*description: ([^\n]*)/.exec(record);
  return m ? m[1]!.split(",").map((p) => p.trim()).filter(Boolean) : [];
}

/** The valid (unexpired, chained to Apple) Developer ID Application identity in the keychain, if there is one. */
export function developerId(): string | null {
  if (process.platform !== "darwin") return null;
  return /"(Developer ID Application: [^"]+)"/.exec(sh(["security", "find-identity", "-v", "-p", "codesigning"]).out)?.[1] ?? null;
}

/** What app.ts signs with: Developer ID when it's valid and codesign may use it, else "midna dev" when ready, else nothing (ad hoc). */
export function signingIdentity(): { name: string; developerId: boolean } | null {
  const dev = developerId();
  if (dev && keyPartitions(dev).includes("apple:")) return { name: dev, developerId: true };
  return signingReady() ? { name: SIGNING_IDENTITY, developerId: false } : null;
}

/** The command that lets codesign use the key without a prompt — the one step that needs the login password. */
export const ALLOW_CODESIGN = ["security", "set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-t", "private", "-l", SIGNING_IDENTITY, KEYCHAIN];

/** "midna dev" is here and codesign can use it without stopping the build for a password. */
export function signingReady(): boolean {
  return hasSigningIdentity() && keyPartitions(SIGNING_IDENTITY).includes("apple:");
}

/** Trusted for code signing, so `security find-identity -v` lists it as valid, as it does "ruri dev". */
export function signingTrusted(): boolean {
  return process.platform === "darwin" && sh(["security", "find-identity", "-v", "-p", "codesigning"]).out.includes(`"${SIGNING_IDENTITY}"`);
}

function create(): void {
  if (process.platform !== "darwin") throw new Error("only macOS signs apps this way");
  if (hasSigningIdentity()) console.log(`"${SIGNING_IDENTITY}" is already in the login keychain`);
  else {
    const dir = mkdtempSync(join(tmpdir(), "midna-signing-"));
    try {
      const run = (argv: string[]) => {
        const r = sh(argv);
        if (!r.ok) throw new Error(`${argv[0]} ${argv[1]} failed:\n${r.out}`);
      };
      writeFileSync(
        join(dir, "cert.cnf"),
        `[req]\ndistinguished_name = dn\nx509_extensions = ext\nprompt = no\n[dn]\nCN = ${SIGNING_IDENTITY}\n[ext]\nbasicConstraints = critical, CA:false\nkeyUsage = critical, digitalSignature\nextendedKeyUsage = critical, codeSigning\n`,
      );
      run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-config", join(dir, "cert.cnf"), "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")]);
      // Apple's own openssl writes a PKCS#12 the keychain reads.
      run(["/usr/bin/openssl", "pkcs12", "-export", "-inkey", join(dir, "key.pem"), "-in", join(dir, "cert.pem"), "-name", SIGNING_IDENTITY, "-passout", "pass:midna", "-out", join(dir, "id.p12")]);
      // -T: codesign and security may use the key.
      run(["security", "import", join(dir, "id.p12"), "-k", KEYCHAIN, "-P", "midna", "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (!hasSigningIdentity()) throw new Error("the identity isn't in the keychain after importing it");
    console.log(`created "${SIGNING_IDENTITY}" in the login keychain`);
    console.log("once, after switching signatures: tccutil reset <service> sh.midna.desktop for each permission, then grant them again");
  }
  trust();
  allowCodesign();
}

/** Trust the certificate for code signing in the user's trust settings — macOS asks for the password, once. */
function trust(): void {
  if (signingTrusted()) return;
  const pem = sh(["security", "find-certificate", "-c", SIGNING_IDENTITY, "-p", KEYCHAIN]).out;
  const dir = mkdtempSync(join(tmpdir(), "midna-signing-"));
  const cert = join(dir, "cert.pem");
  writeFileSync(cert, pem);
  const argv = ["security", "add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", KEYCHAIN, cert];
  try {
    if (!process.stdin.isTTY) {
      console.log(`to trust it (macOS asks for your password), run in a terminal: bun run signing`);
      return;
    }
    console.log("trusting it for code signing — macOS asks for your password:");
    Bun.spawnSync(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    console.log(signingTrusted() ? "trusted" : "not trusted yet: run bun run signing again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
