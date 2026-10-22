# midna — Build and checks

One layer of midna's stack, owning `scripts/, test/, package.json, bun.lock, tsconfig.json, tsconfig.base.json, scripts/tenet.sh, Makefile, .gitignore`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer build-and-checks` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer build-and-checks add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer compiles the CLI into a single-file binary and checks package import boundaries and a live daemon-to-brain reply. Its scripts run with Bun, and bun.lock records the dependencies used by the workspace. Clients depend only on their allowed packages, so a client can be removed without changing core code. Root package.json also carries the release version and the aliases that run the desktop client's signing and app build. scripts/tenet.sh runs every heavy step on tenet (Justin's Arch desktop) instead of the 8 GB Mac.

## Where to change what

- **Compiled CLI and build targets:** scripts/build.ts
- **Package import rules:** scripts/check-boundaries.ts
- **Live brain smoke check:** scripts/smoke.ts
- **Hosting install end-to-end test:** test/hosting.e2e.test.ts
- **Telegram bridge end-to-end test (replies and voice notes):** test/telegram.e2e.test.ts
- **Root scripts, release aliases and version:** package.json
- **Workspace dependencies:** bun.lock
- **Running heavy steps on tenet:** scripts/tenet.sh, Makefile

## How it works

- **Build:** Select the current machine or all four Linux and macOS targets → Compile clients/cli/src/main.ts with Bun → Write the binary under dist/ and fail if compilation fails
- **Live smoke check:** Create a temporary home and configure the selected model → Start a daemon and connect a MidnaClient with its host token → Watch events for activity and an outbox message reply
- **Release cut:** Bump the version in all six version files → Run make tenet-check and make tenet-cargo-test → Make the release commit and tag vX.Y.Z → Build the kits and the signed desktop app on the Mac, then verify each reports the new version
- **Run on tenet:** Snapshot the working tree as a commit through a scratch index → Push it to tenet:~/work/midna as refs/tenet/<sha>, and yagami's HEAD to ~/work/yagami → Check it out in the slot (~/work/midna, or ~/work/midna-<name> for a worktree) under a per-slot flock; rebuild yagami and bun install only when they changed → Run the command in a background.slice scope (MemoryMax 6G, CPUWeight 20, nice 10) with the Mac's bun version via mise; exit with its status

## Key files

- scripts/build.ts — compiles the CLI binary for the current machine or four explicit targets
- scripts/check-boundaries.ts — scans TypeScript imports against per-package dependency allowlists
- scripts/smoke.ts — starts a throwaway daemon and checks for a reply through a real brain
- test/hosting.e2e.test.ts — end-to-end install test that re-pairs and checks old-token retirement
- test/telegram.e2e.test.ts — end-to-end test of the Telegram bridge's replies and voice notes
- package.json — root scripts, the signing and app:build aliases, and the release version
- bun.lock — records resolved workspace dependencies
- scripts/tenet.sh — ships the working tree to tenet and runs one command there, or pulls results back; its --remote half runs on tenet, read from the snapshot

## Rules and traps

- Keep each package's imports within the allowlist in scripts/check-boundaries.ts; protocol has no allowed package imports, and core may import only protocol.
- The smoke check uses a real brain and has a small token cost.
- The smoke check defaults to claude:sonnet; its first command-line argument selects another yagami model reference.
- The hosting e2e test expects re-pairing to retire only the token saved for the same host; a saved connection to a different address must retire nothing.
- The telegram e2e test must wait for all three images before checking; checking earlier raced and failed.
- A release version must be bumped in all six files together: root package.json, clients/desktop/package.json, clients/desktop/src-tauri/Cargo.toml, Cargo.lock, tauri.conf.json, and packages/daemon/src/version.ts.
- bun run typecheck also runs clients/mobile's own tsc (TypeScript 6, React Native types); the root tsconfig excludes clients/mobile/src, and the boundary check lets it import only @midna/protocol. Mobile tests run under bun, so they import only its React-Native-free modules (lines.ts, server.ts).
- Run heavy steps through scripts/tenet.sh, never by hand on tenet: it is Justin's KDE desktop, and the script keeps work in background.slice under a memory cap (tenet has no swap). No root and nothing system-wide there; user-level toolchains only (mise bun and node, rustup in ~/.cargo).
- A slot on tenet mirrors its Mac checkout: each run force-checks-out the snapshot and git clean -fd's it, so don't keep work there; ignored files (node_modules, dist, target) stay.
- systemd-run expands $VAR in the command it runs unless --expand-environment=no, and a scope sets INVOCATION_ID, which makes JobRunner default to real systemd-run jobs; tenet.sh passes the flag and unsets it.
- cargo test of clients/desktop/src-tauri on tenet: make tenet-cargo-test. A fresh checkout needs the frontend built (bun run build: generate_context! wants ../dist) and this platform's sidecar (bun scripts/sidecar.ts: tauri-build wants binaries/midna-<triple>) first. It covers the platform-neutral Rust tests; the macOS-only code compiles only in the Mac's app build.

## What it talks to

- Clients — the build compiles the CLI entry point; the boundary check scans both clients; the hosting e2e test drives the CLI's install pairing
- Telegram client — the telegram e2e test drives clients/telegram/src/bridge.ts and voice.ts
- Desktop client — root signing and app:build aliases run the clients/desktop scripts
- Protocol — the smoke check uses MidnaClient; the boundary check permits no protocol package imports
- Daemon — the smoke check starts it and configures its host settings; the hosting e2e test checks that the daemon revokes replaced tokens; version.ts carries the release version
- Assistant and Core — the boundary check restricts their package imports
- Runtime — Bun compiles the binary and runs these scripts
- tenet — scripts/tenet.sh pushes snapshots over ssh to ~/work/midna and ~/work/yagami and runs commands in user scopes there
