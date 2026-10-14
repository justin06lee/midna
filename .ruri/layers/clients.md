# midna — Clients

One layer of midna's stack, owning `clients/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer clients` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer clients add|set|drop <section> …`. Where it and the code disagree, the code is right.

The clients layer provides the Bun CLI, a Telegram bridge, and a desktop app. The CLI handles setup and local commands; Telegram and the desktop app use the public Midna API through MidnaClient. The desktop shell handles host operations while its web view talks to Midna over HTTP.

## Where to change what

- **CLI commands:** clients/cli/src/main.ts
- **Machine discovery and installation:** clients/cli/src/discover.ts, clients/cli/src/install.ts, clients/cli/src/main.ts
- **Telegram pairing and delivery:** clients/telegram/src/bridge.ts, clients/telegram/src/bot.ts
- **Desktop connection and live conversation state:** clients/desktop/src/useMidna.ts, clients/desktop/src/screens/Main.tsx
- **Desktop onboarding:** clients/desktop/src/screens/Welcome.tsx, clients/desktop/src/screens/Install.tsx, clients/desktop/src/host.ts
- **Desktop chat:** clients/desktop/src/screens/Chat.tsx, clients/desktop/src/useMidna.ts
- **Desktop settings:** clients/desktop/src/screens/Settings.tsx
- **Desktop today screen:** clients/desktop/src/screens/Today.tsx
- **Desktop host integration:** clients/desktop/src/host.ts, clients/desktop/src-tauri/src/lib.rs, clients/desktop/vite.config.ts
- **Desktop appearance and shared controls:** clients/desktop/src/style.css, clients/desktop/src/ui.tsx
- **Desktop version and packaging:** clients/desktop/package.json, clients/desktop/src-tauri/Cargo.toml, clients/desktop/src-tauri/tauri.conf.json

## How it works

- **Desktop installation:** Welcome discovers and ranks machines → Install displays installation events → host runs the CLI through Tauri or the development server → the CLI installs and pairs the machine → the desktop app receives a Connection
- **Desktop conversation:** Main creates useMidna with a Connection → useMidna uses MidnaClient for history and live events → Chat renders lines and sends messages
- **Telegram bridge:** A one-time /start code binds the owner chat → Telegram messages pass through the bridge to MidnaClient → the bridge delivers outbox items to Telegram → saved offsets and sequence positions support restart

## Key files

- clients/cli/src/main.ts — CLI entry point and commands
- clients/cli/src/install.ts — machine installation, pairing, and progress events
- clients/cli/src/discover.ts — machine discovery with a timeout on health checks
- clients/telegram/src/bridge.ts — owner pairing, API exchange, and persistent delivery positions
- clients/desktop/src/useMidna.ts — desktop connection and conversation state
- clients/desktop/src/screens/Main.tsx — connected desktop navigation and screen composition
- clients/desktop/src/host.ts — browser and Tauri host operations
- clients/desktop/src-tauri/src/lib.rs — sidecar execution, connection storage, terminal, and tray integration
- clients/desktop/src/screens/Welcome.tsx — machine selection
- clients/desktop/src/screens/Install.tsx — installation progress
- clients/desktop/src/screens/Chat.tsx — conversation display and input

## Rules and traps

- The Telegram bridge accepts only the owner chat bound by a one-time /start code; other chats are ignored.
- Persist Telegram update offsets and Midna outbox sequence positions so restarts do not replay or miss deliveries.
- The desktop web view calls the Midna HTTP API with a device token; host-only operations go through host.ts.
- The desktop can connect to an older host; normalizeStatus supplies fields that host does not report.
- Discovery, the installer's wait loop and the CLI's local wait must pass a cancel signal to MidnaClient.health(), or a dead machine can hang them.
- A desktop version bump must change all five places together: clients/desktop/package.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/tauri.conf.json and packages/daemon/src/version.ts.
- The installer's SSH ControlPath stays under /tmp (sshControlPath): macOS's os.tmpdir() is long enough that ssh's socket path passes the 104-byte Unix socket limit.

## What it talks to

- Protocol — clients use MidnaClient and shared API types; health() takes a cancel signal
- Daemon — the CLI manages the host service; desktop and Telegram connect to its public API
- Host — CLI setup uses host configuration and service operations from the daemon package
