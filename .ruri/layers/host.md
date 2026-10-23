# midna — Host

One layer of midna's stack, owning `packages/daemon/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer host` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer host add|set|drop <section> …`. Where it and the code disagree, the code is right.

The Host layer sets midna up on a machine: it resolves the home directory that holds the database, config, token, and logs, reads and writes settings directly against the database before the daemon has ever run, installs the daemon as a background service of the user's own account (a systemd user unit on Linux, a launchd agent on macOS), and holds the version constant. It also hosts the device hands hub, which pairs desktop devices, sends them signed commands through the daemon's API, and gates risky commands behind approvals that the device, desktop chat, or Telegram can answer. It runs the long-job registry, which launches jobs detached from the turn that started them and wakes midna when they end. Native reply threads are accepted on POST /v1/messages and resolved in the daemon's receive path. Before touching it, a newcomer should understand that midnaHome() decides where everything lives, with MIDNA_HOME overriding it, and that the service runs as the user rather than as a system account.

## Where to change what

- **Where midna keeps its data and config:** packages/daemon/src/config.ts
- **Bind address, port, extra listen addresses:** packages/daemon/src/config.ts, packages/daemon/src/daemon.ts
- **Background service install, restart, and removal:** packages/daemon/src/service.ts
- **Settings read and written before the daemon runs:** packages/daemon/src/host.ts
- **Bridge process configuration, including Telegram alerts-only mode:** packages/daemon/src/config.ts, packages/daemon/src/bridges.ts, packages/daemon/src/daemon.ts
- **Version constant reported by the daemon and CLI (bumped at each release):** packages/daemon/src/version.ts
- **Device hands: paired desktop devices, signed commands, policy gate, audit log:** packages/daemon/src/hands.ts, packages/daemon/src/server.ts, packages/daemon/test/hands.test.ts
- **Re-pairing a device retires the one it replaces (/v1/pair with replaces):** packages/daemon/src/server.ts, packages/daemon/test/daemon.test.ts

## How it works

- **Settings access before the first run:** midnaHome() resolves the directory, from MIDNA_HOME or the platform default → ensureHome() creates the directory and returns its paths, including the database file → Store.open() opens the database at that path → store.settings() reads or store.updateSettings(patch) writes the settings → store.close() runs in a finally block, so the database is closed even on error
- **Device command round trip:** A brain calls a device_* tool, which reaches the daemon's HandsHub through HandsHandle → HandsHub runs the policy gate: global and device pause, locked or asleep, capability mode, missing permission → Allowed commands are signed with the device's key and sent with a seq on its session stream → The desktop device checks the signature, seq and connection before acting → The device POSTs its result; the daemon checks device id, command id and that it is used once → The result returns to the brain; screenshots come back as images and every decision is audited
- **Approval round trip:** The daemon records the approval as pending and emits an approval event on /v1/events and the hands stream → Each client shows its prompt: the device panel, the desktop card or chat question, the Telegram keyboard, or the iPhone approvals screen → A client answers with POST /v1/approvals/:id and its client name; a 409 means another client answered first → The approval settles to a final state: allowed, denied, expired or cancelled → Clients close their prompt on that state; GET /v1/approvals lists pending approvals after a reconnect

## Key files

- packages/daemon/src/config.ts — home directory resolution, daemon bind settings, bridge config, and config read and write
- packages/daemon/src/hands.ts — device hands hub: sessions, signed commands, policy gate, audit
- packages/daemon/src/approvals.ts — approval records, their states, and answers from each client
- packages/daemon/src/jobs.ts — long-job registry: detached launch, timeout, group kill, restart reconcile, exit wakeup
- packages/daemon/src/service.ts — installs, restarts, and removes the background user service
- packages/daemon/src/host.ts — reads and writes settings straight to the database
- packages/daemon/src/bridges.ts — bridge supervision: starts bridge processes from config and passes their mode
- packages/daemon/src/server.ts — HTTP routes, including the /v1/hands, /v1/approvals, /v1/pair and /v1/messages endpoints

## Rules and traps

- The service must run as the user's own account; that is what gives the agent the user's signed-in CLIs, so do not move it to a system-wide unit.
- On Linux, run() sets XDG_RUNTIME_DIR from /run/user/<uid> when it is missing, because systemctl --user cannot find the user's manager over SSH without it. Do not remove that step.
- MIDNA_HOME overrides the home directory and is used by tests and second instances, so every path must derive from midnaHome() rather than a hard-coded location.
- host stays loopback: makima publishes loopback to the mesh, Tailscale doesn't, so tailnets come via listen (an IP or interface name, e.g. tailscale0); wildcards are refused; missing addresses retry every 30s.
- Host settings are for setup before the daemon has run; once it runs, clients must go through the API instead of writing the database here.
- A bridge reaches midna only through the public API, as BridgeConfig.command describes; a bridge must not be given direct database access.

## What it talks to

- Protocol — config.ts imports DEFAULT_PORT from @midna/protocol; hands and approval shapes, including HandsErrorCode, are typed in packages/protocol/src/hands.ts; the /v1/pair replaces field, SendMessage.inReplyTo, MessageReceipt and ReplyRef are typed in packages/protocol/src/index.ts; a client's fetch is injected into MidnaClient, and the phone's kind is mobile with no daemon change needed
- Core — host.ts uses Store and the Settings type from @midna/core, and the database file path comes from ensureHome(); hands.ts stores devices, audit rows and approvals through the hands module in @midna/core; device retirement lives in packages/core/src/devices.ts; jobs.ts stores job records through the Jobs module in @midna/core; migration 9 stores messages.in_reply_to, reply_quote and reply_fallback, and outbox ids resolve through messages.outbox_id
- Daemon — daemon.ts and server.ts consume the config, and index.ts re-exports startDaemon and createApp from them
- Assistant — index.ts re-exports installedBrains, checkModel, and checkBrainLive from @midna/agent; hands.ts implements the HandsHandle interface that the device_* tools call; jobs.ts implements the JobsHandle interface that the job_start, job_list and job_stop tools call, so the agent never imports the daemon; receive() in @midna/agent resolves native replies and prompt.ts writes the [Replying to …] line
- Runtime — the service runs under the user's systemd user manager or launchd, so the agent CLIs it starts are the user's own signed-in ones; on Linux, jobs run as midna-job-… user units that appear in systemctl --user list-units
- Clients — bridges.ts starts each bridge from BridgeConfig.command and passes its mode as MIDNA_BRIDGE_MODE; the alerts filter lives in clients/telegram/src/bridge.ts, and the CLI's telegram run passes the mode through from clients/cli/src/main.ts
