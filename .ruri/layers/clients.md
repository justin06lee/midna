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
- **Desktop appearance (light/dark/system switch) and shared controls:** clients/desktop/src/style.css, clients/desktop/src/appearance.ts, clients/desktop/src/ui.tsx
- **Desktop version and packaging:** clients/desktop/package.json, clients/desktop/src-tauri/Cargo.toml, clients/desktop/src-tauri/tauri.conf.json
- **midna's mark: app icon (and the macOS 26 Icon Composer icon), tray icon, in-app mark, README banner:** clients/desktop/src/helmet.ts, clients/desktop/scripts/icons.ts, clients/desktop/src-tauri/icons/midna.icon, assets/midna.svg
- **Desktop attachments: paste/drag/picker uploads, download and open, PDFs in the viewer, rendered in the order given:** clients/desktop/src/attach.tsx, clients/desktop/src/media.tsx, clients/desktop/src/screens/Chat.tsx, clients/desktop/src/host.ts, clients/desktop/src-tauri/src/lib.rs

## How it works

- **Desktop installation:** Welcome discovers and ranks machines → Install displays installation events → host runs the CLI through Tauri or the development server → the CLI installs and pairs the machine → the desktop app receives a Connection
- **Desktop conversation:** Main creates useMidna with a Connection → useMidna uses MidnaClient for history and live events → Chat renders lines and sends messages
- **Telegram bridge:** A one-time /start code binds the owner chat → Telegram messages, photos and files pass through the bridge to MidnaClient (files uploaded first) → the bridge delivers outbox items to Telegram, attachments as photos or documents → saved offsets and sequence positions support restart

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
- clients/desktop/src/helmet.ts — the helmet outline every icon and the in-app mark are drawn from
- clients/desktop/src/appearance.ts — the light/dark/system choice, kept in localStorage and applied to <html> and the window
- clients/desktop/scripts/icons.ts — renders every icon from the helmet and compiles the macOS 26 Assets.car from icons/midna.icon
- clients/desktop/src/media.tsx — attachments in the order given (image runs share a row, files are chips that open or save), captions, web images, and the viewer for images and PDFs
- clients/desktop/src/attach.tsx — the composer's pending files: uploaded at once (XMLHttpRequest, for progress; two at a time), removable (DELETE takes the upload back) and retryable, sent in the order added

## Rules and traps

- The Telegram bridge accepts only the owner chat bound by a one-time /start code; other chats are ignored.
- Persist Telegram update offsets and Midna outbox sequence positions so restarts do not replay or miss deliveries.
- The desktop web view calls the Midna HTTP API with a device token; host-only operations go through host.ts.
- The desktop can connect to an older host; normalizeStatus supplies fields that host does not report.
- Discovery, the installer's wait loop and the CLI's local wait must pass a cancel signal to MidnaClient.health(), or a dead machine can hang them.
- A desktop version bump must change all five places together: clients/desktop/package.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/tauri.conf.json and packages/daemon/src/version.ts.
- The installer's SSH ControlPath stays under /tmp (sshControlPath): macOS's os.tmpdir() is long enough that ssh's socket path passes the 104-byte Unix socket limit.
- Don't iterate a fetch body with for await in code the desktop runs: the system WebKit's ReadableStream isn't async-iterable. Use getReader() and close the response — WebKit allows 6 connections per host, and leaked event streams starve every other request.
- Window dragging needs data-tauri-drag-region ("deep" on a strip holding text) plus the core:window:allow-start-dragging permission; -webkit-app-region is Electron-only and Tauri ignores it.
- trafficLightPosition y=24 puts the traffic lights' centre at 22 (mid 44px title bar), ending ~80px in, so the sidebar title pads 92px (macTitleBar in host.ts). Change one, re-measure the other.
- macOS 26 lightens and shades an app icon that has no Assets.car: bun run icons compiles src-tauri/icons/midna.icon into the committed icons/Assets.car with Xcode's actool run by path (xcrun refuses: Xcode isn't selected, its licence unaccepted). bundle.icon lists it; icon.icns stays for older macOS.
- An <img> can't send the device token: attachments come through MidnaClient.attachment() and are drawn from cached blob: URLs (the CSP's img-src keeps blob:, and https:/http: for Markdown images). Size an image from its natural dimensions (loadImage): CSS max sizes inside a shrink-to-fit button leave the frame too wide.
- Telegram bot limits: uploads up to 50 MB (bigger attachments get a note pointing to the app), photos up to 10 MB (bigger images go as documents), downloads via getFile up to 20 MB (bigger incoming files are refused with a reason). The bridge sends text first, then attachments in order; a question sends its files first so its buttons stay last.
- Drops: tauri.conf.json sets dragDropEnabled false so WebKit delivers dropped files to the page as File objects (Tauri's handler would swallow them as paths); main.tsx refuses a drop anywhere the chat doesn't take it, or WebKit would open the file in the window.
- Files in: dragDropEnabled is false so WebKit hands drops to the page as File objects (main.tsx refuses a drop outside the chat, or WebKit opens the file in the window). WebKit gives a paste of several Finder files only the first; Rust (copied_files, read_copied: NSPasteboard) reads them all. Uploads use XMLHttpRequest for progress.
- Files out: Rust gets the fetched bytes raw (name percent-encoded in an x-name header), saves into Downloads or opens a cache copy, quarantined for Gatekeeper. PDFs preview in a blob: iframe (CSP frame-src blob:).

## What it talks to

- Protocol — clients use MidnaClient and shared API types; health() takes a cancel signal
- Daemon — the CLI manages the host service; desktop and Telegram connect to its public API
- Host — CLI setup uses host configuration and service operations from the daemon package
