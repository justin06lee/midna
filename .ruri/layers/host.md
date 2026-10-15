# midna — Host

One layer of midna's stack, owning `packages/daemon/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer host` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer host add|set|drop <section> …`. Where it and the code disagree, the code is right.

The Host layer sets midna up on a machine: it resolves the home directory that holds the database, config, token, and logs, reads and writes settings directly against the database before the daemon has ever run, installs the daemon as a background service of the user's own account (a systemd user unit on Linux, a launchd agent on macOS), and holds the version constant. Before touching it, a newcomer should understand that midnaHome() decides where everything lives, with MIDNA_HOME overriding it, and that the service runs as the user rather than as a system account.

## Where to change what

- **Where midna keeps its data and config:** packages/daemon/src/config.ts
- **Bind address and port:** packages/daemon/src/config.ts
- **Background service install, restart, and removal:** packages/daemon/src/service.ts
- **Settings read and written before the daemon runs:** packages/daemon/src/host.ts
- **Bridge process configuration:** packages/daemon/src/config.ts
- **Version number:** packages/daemon/src/version.ts
- **What the daemon package exports:** packages/daemon/src/index.ts

## How it works

- **Settings access before the first run:** midnaHome() resolves the directory, from MIDNA_HOME or the platform default → ensureHome() creates the directory and returns its paths, including the database file → Store.open() opens the database at that path → store.settings() reads or store.updateSettings(patch) writes the settings → store.close() runs in a finally block, so the database is closed even on error

## Key files

- packages/daemon/src/config.ts — home directory resolution, daemon bind settings, and config read and write
- packages/daemon/src/service.ts — installs, restarts, and removes the background user service
- packages/daemon/src/host.ts — reads and writes settings straight to the database
- packages/daemon/src/index.ts — the package's public exports
- packages/daemon/src/version.ts — the VERSION constant

## Rules and traps

- The service must run as the user's own account; that is what gives the agent the user's signed-in CLIs, so do not move it to a system-wide unit.
- On Linux, run() sets XDG_RUNTIME_DIR from /run/user/<uid> when it is missing, because systemctl --user cannot find the user's manager over SSH without it. Do not remove that step.
- MIDNA_HOME overrides the home directory and is used by tests and second instances, so every path must derive from midnaHome() rather than a hard-coded location.
- The default bind host is loopback on purpose; makima publishes loopback services to the mesh, while Tailscale does not, so other machines are reached through the extra addresses in DaemonConfig.
- Host settings are for setup before the daemon has run; once it runs, clients must go through the API instead of writing the database here.
- A bridge reaches midna only through the public API, as BridgeConfig.command describes; a bridge must not be given direct database access.
- VERSION is defined only in version.ts; import it from there rather than copying the string.

## What it talks to

- Protocol — config.ts imports DEFAULT_PORT from @midna/protocol for the default port
- Core — host.ts uses Store and the Settings type from @midna/core, and the database file path comes from ensureHome()
- Daemon — daemon.ts and server.ts consume the config, and index.ts re-exports startDaemon and createApp from them
- Assistant — index.ts re-exports installedBrains, checkModel, and checkBrainLive from @midna/agent
- Runtime — the service runs under the user's systemd user manager or launchd, so the agent CLIs it starts are the user's own signed-in ones
