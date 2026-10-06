# midna — Build and checks

One layer of midna's stack, owning `scripts/, test/, package.json, bun.lock, tsconfig.json, tsconfig.base.json`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer build-and-checks` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer build-and-checks add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer compiles the CLI into a single-file binary and checks package import boundaries and a live daemon-to-brain reply. Its scripts run with Bun, and bun.lock records the dependencies used by the workspace. Clients depend only on their allowed packages, so a client can be removed without changing core code.

## Where to change what

- **Compiled CLI and build targets:** scripts/build.ts
- **Package import rules:** scripts/check-boundaries.ts
- **Live brain smoke check:** scripts/smoke.ts
- **Workspace dependencies:** bun.lock

## How it works

- **Build:** Select the current machine or all four Linux and macOS targets → Compile clients/cli/src/main.ts with Bun → Write the binary under dist/ and fail if compilation fails
- **Live smoke check:** Create a temporary home and configure the selected model → Start a daemon and connect a MidnaClient with its host token → Watch events for activity and an outbox message reply

## Key files

- scripts/build.ts — compiles the CLI binary for the current machine or four explicit targets
- scripts/check-boundaries.ts — scans TypeScript imports against per-package dependency allowlists
- scripts/smoke.ts — starts a throwaway daemon and checks for a reply through a real brain
- bun.lock — records resolved workspace dependencies

## Rules and traps

- Keep each package's imports within the allowlist in scripts/check-boundaries.ts; protocol has no allowed package imports, and core may import only protocol.
- The smoke check uses a real brain and has a small token cost.
- The smoke check defaults to claude:sonnet; its first command-line argument selects another yagami model reference.

## What it talks to

- Clients — the build compiles the CLI entry point; the boundary check scans both clients
- Protocol — the smoke check uses MidnaClient; the boundary check permits no protocol package imports
- Daemon — the smoke check starts it and configures its host settings
- Assistant and Core — the boundary check restricts their package imports
- Runtime — Bun compiles the binary and runs these scripts
