/**
 * Whether app.ts may put a build in ~/Applications/midna.app.
 *
 * An ad-hoc midna.app loses every permission it was granted (its
 * requirement is a cdhash, new on every build). So where this Mac has the
 * "midna dev" identity, usable yet or not, or the installed app is signed,
 * an ad-hoc build isn't installed unless asked for: `bun run signing` first
 * (or `make signing`), or MIDNA_ALLOW_ADHOC=1 to mean it. A Mac with
 * neither gets the ad-hoc build as before. Other bundle ids (the
 * sh.midna.desktop.test copies) aren't midna.app and aren't guarded.
 *
 * Why: on 2026-10-20 `make app` installed ad-hoc builds over a granted
 * midna.app twice, with the identity there but codesign not yet allowed
 * to use it; the warning scrolled past.
 */
import { existsSync } from "node:fs";
import { SIGNING_IDENTITY } from "./signing.ts";

/** tauri.conf.json's identifier, which every signed build keeps. */
export const BUNDLE_ID = "sh.midna.desktop";

/** Who signed an app: "midna dev", someone else, ad hoc or nobody, or there's no app there. */
export type Signer = "midna dev" | "other" | "adhoc" | "none";

/** From the signature alone (`codesign -dvv` reads, never signs): no keychain, so no dialog. */
export function signer(app: string): Signer {
  if (!existsSync(app)) return "none";
  const r = Bun.spawnSync(["codesign", "-dvv", app], { stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  if (out.split("\n").includes(`Authority=${SIGNING_IDENTITY}`)) return "midna dev";
  return /^Authority=/m.test(out) ? "other" : "adhoc";
}

export interface InstallFacts {
  /** The build's bundle id. */
  bundleId: string;
  /** Who signed the build about to be installed. */
  build: Signer;
  /** This Mac has the "midna dev" identity, whether codesign may use it yet or not. */
  identity: boolean;
  /** Who signed the midna.app it would replace. */
  installed: Signer;
  /** MIDNA_ALLOW_ADHOC=1: install an ad-hoc build all the same. */
  allowAdHoc: boolean;
}

/** Why this build mustn't be installed, as the message to print; null when it may. */
export function refuseInstall(f: InstallFacts): string | null {
  if (f.bundleId !== BUNDLE_ID || f.build === "midna dev" || f.allowAdHoc) return null;
  const why = f.identity
    ? `"${SIGNING_IDENTITY}" is on this Mac, but codesign can't use it yet`
    : f.installed === "midna dev" || f.installed === "other"
      ? `the installed midna.app is signed${f.installed === "midna dev" ? ` with "${SIGNING_IDENTITY}"` : ""} and this build isn't`
      : null;
  if (!why) return null;
  return [
    `✗ not installing an ad-hoc midna.app: ${why}.`,
    `  Installed, it would lose every permission midna.app has been granted (Screen Recording, Accessibility, Automation, Full Disk Access).`,
    `  To sign it: cd clients/desktop && bun run signing   (or: make signing), then make app again.`,
    `  To install it unsigned all the same: MIDNA_ALLOW_ADHOC=1 make app`,
  ].join("\n");
}
