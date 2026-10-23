# midna — Daemon

One layer of midna's stack, owning `packages/daemon/src/server.ts, packages/daemon/src/daemon.ts, packages/daemon/src/bridges.ts, packages/daemon/src/hands.ts, packages/daemon/src/approvals.ts, packages/daemon/src/jobs.ts, packages/daemon/test/jobs.test.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer daemon` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer daemon add|set|drop <section> …`. Where it and the code disagree, the code is right.

The Daemon layer is midna's runtime host: it wires Store, Assistant, and Bridges together, serves the public HTTP API via Hono, and runs the scheduler tick loop. Newcomers must grasp that the daemon owns no domain logic. It exposes Core/Assistant capabilities over HTTP/SSE and supervises bridge subprocesses that are ordinary API clients. Device approvals are answered from any client, and the first answer wins.

## Where to change what

- **HTTP API routes (messages, inbound events, attachments, settings, health, status, bridge setup):** packages/daemon/src/server.ts
- **Device pairing and re-pairing (/v1/pair, replaces, revoke):** packages/daemon/src/server.ts
- **SSE event stream:** packages/daemon/src/server.ts
- **Startup, config load (including listen addresses), and scheduler tick loop:** packages/daemon/src/daemon.ts, packages/daemon/src/config.ts
- **Bridge process supervision, restart, and per-bridge mode (bridges.telegram.mode passed as MIDNA_BRIDGE_MODE):** packages/daemon/src/bridges.ts, packages/daemon/src/config.ts, packages/daemon/src/daemon.ts
- **Device hands: sessions, the signing key, routing, the policy gate, /v1/hands/*:** packages/daemon/src/hands.ts, packages/daemon/src/server.ts
- **Approvals: questions on the device stream, the event stream, and in chat; Allow, Allow for 10 min, Deny; answers via POST /v1/approvals or a reply in POST /v1/messages:** packages/daemon/src/approvals.ts, packages/daemon/src/server.ts, packages/daemon/src/hands.ts
- **Jobs: detached launch (systemd-run --user running wrapper.sh, launchd, or setsid), the exit file, pid and unit checks, startup reconcile, time limits, job_stop:** packages/daemon/src/jobs.ts, packages/daemon/test/jobs.test.ts, packages/daemon/src/daemon.ts
- **Daemon version and release (version string, status wakeup spend):** packages/daemon/src/version.ts, packages/daemon/src/server.ts

## How it works

- **Serve a client request:** Hono app in server.ts authenticates device and parses Zod wire schema → Handler reads/writes Store (@midna/core) or calls Assistant (@midna/agent) → Settings changes trigger onSettingsChanged; bridge changes trigger reloadBridges → Response returned; async updates pushed via SSE StreamEvent
- **Boot and run:** startDaemon in daemon.ts loads config, ensures home, opens Store → Constructs Assistant, Bridges, and Hono app via createApp → Recovers wakeups, ensures rituals and intro, revives brain failures, and answers what the user wrote before a restart (assistant.answerLeftovers) → Optionally runs checkBrainOnStart → Starts HTTP listener and scheduler tick loop; syncs enabled bridges
- **Device command:** device_* tool → HandsHub.run → device by name or id → global pause → online and state → capability offered, permissions granted → decide() gate (Approver when it says approve) → canonicalJson signed with MIDNA_HOME/hands.key → pushed on the device's SSE stream → its result, a timeout or a cancelled tool call (both send cancel), or a disconnect
- **Device approval:** decide() asks Approver for a capability that changes state → Question goes to the device stream, the event stream, and chat at once → First answer from the Mac, chat, Telegram, or phone wins; later answers get 409 → No answer within 2 minutes counts as Deny → Allow for 10 min records a grant; the tool call resumes or fails on the answer → Outcome is pushed on the event stream so every client can close its prompt
- **Re-pair a client:** POST /v1/pair receives a new device plus an optional replaces token → Daemon pairs the new device first → If replaces is a valid token of a live device, that device is revoked → Its hands stream is closed and the retired id is returned as replaced → A wrong, revoked or unknown replaces token retires nothing and the pairing still succeeds

## Key files

- packages/daemon/src/server.ts — Hono app, routes, SSE stream, MCP/token auth, approval answers, pairing and re-pairing, status spend
- packages/daemon/src/daemon.ts — startDaemon, config, scheduler loop, dependency wiring
- packages/daemon/src/config.ts — config loading, including the listen addresses and bridge mode
- packages/daemon/src/bridges.ts — bridge subprocess spawn, logging, backoff restart, and MIDNA_BRIDGE_MODE
- packages/daemon/src/hands.ts — HandsHub: device sessions, Ed25519 signing, dispatch and timeouts, the decide() gate, summarize() for approvals, the audit rows
- packages/daemon/src/approvals.ts — Approvals: asks on the device stream, the event stream and as a chat question; first answer wins, 2-min expiry, 10-min grants, catches replies in POST /v1/messages
- packages/daemon/src/jobs.ts — JobRunner: writes wrapper.sh into each job folder under MIDNA_HOME/jobs/job-…, launches it detached, watches pid and exit file, settles jobs on startup, kills by process group (and unit) at stop or time limit
- packages/daemon/src/version.ts — the daemon's version string, bumped to 0.11.2
- packages/daemon/test/jobs.test.ts — job tests with stand-in systemd-run, systemctl and launchd that apply systemd's $ rewrite
- packages/daemon/test/daemon.test.ts — daemon tests, updated when the budget was removed

## Rules and traps

- Bridges are opaque subprocesses talking only via the public API; never add bridge-protocol knowledge here.
- The /mcp route is gated by the per-run mcpToken; do not expose it to clients or bridges.
- Bridge supervision lives in Bridges.sync/start/stop; server.ts only re-reads config and calls reloadBridges.
- A bridge reads its mode only when it starts, so a changed bridges.telegram.mode takes effect only after POST /v1/bridges/reload or a restart.
- Scheduler timing (tickMs, introDelayMs, coalesceMs, joinMs) and brain injection exist for tests. The tick claims wakeups as turns (claimTurns); each wakeup in a turn gets its outcome.
- The tick's hourly sweep also prunes inbound events older than 30 days whose wakeup is over; until then a resent id is a duplicate.
- Device commands come only from midna's tools behind /mcp; no /v1 route issues one, /v1/hands/* takes desktop tokens only, and nothing is queued for an offline device.
- A long-lived SSE route must write something at once: Bun sends the headers with the first bytes, so a silent stream leaves the client's fetch hanging.
- The daemon refuses approval answers made with its own host token; an answer needs a separately paired client device.
- Any paired client token can answer an approval, so a client's Face ID or PIN protects only that client, not the approval itself.

## What it talks to

- Protocol — every route body and StreamEvent is typed by Zod schemas in packages/protocol/, including the approval shapes and the pair body's replaces field; Status.wakeups carries only turns and usd
- Core — Store supplies devices, settings, schedule, outbox, and event bus behind the API
- Assistant — chat, wakeup, checkModel, handleMcp, and installedBrains do the agent work
- Clients — CLI, Telegram bridge, desktop app, and the iPhone app (clients/mobile) consume only this layer's HTTP/SSE API; the Telegram bridge runs in full or alerts mode from MIDNA_BRIDGE_MODE; desktop, Telegram, and phone answer approvals via POST /v1/approvals; the phone pairs with kind mobile, which needed no daemon change; the CLI and desktop app will send replaces on re-pair once Clients updates its install flows
- Host — config, home directory, service install, and VERSION surround startup
