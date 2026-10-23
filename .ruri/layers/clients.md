# midna — Clients

One layer of midna's stack, owning `clients/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer clients` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer clients add|set|drop <section> …`. Where it and the code disagree, the code is right.

The clients layer provides the Bun CLI, a Telegram bridge with native replies and voice-note transcription through una, a desktop app and an iPhone app. The CLI handles setup and local commands, including the spend and wakeup status lines; Telegram, the desktop and the phone use the public Midna API through MidnaClient, the phone at an address it is given (Tailscale later). The desktop shell handles host operations, its web view talks to Midna over HTTP, and its Rust side is a signed device-hands endpoint that runs input, shell, AppleScript, file and clipboard operations for the daemon. Approval requests for risky actions reach the user on the Mac, in chat, on Telegram and on the phone, behind Face ID. Re-pairing retires the previous pairing: each install or reconnect names the old token it replaces.

## Where to change what

- **CLI commands (status spend and wakeup lines):** clients/cli/src/main.ts
- **Machine discovery and installation:** clients/cli/src/discover.ts, clients/cli/src/install.ts, clients/cli/src/main.ts
- **Retiring the previous pairing on reinstall or reconnect:** clients/cli/src/install.ts, clients/cli/src/main.ts, clients/desktop/src-tauri/src/lib.rs, test/hosting.e2e.test.ts
- **Telegram pairing, commands, delivery and approval buttons:** clients/telegram/src/bridge.ts, clients/telegram/src/bot.ts
- **Telegram native replies (Telegram reply threads mapped to midna message ids):** clients/telegram/src/bridge.ts, clients/telegram/src/bot.ts, test/telegram.e2e.test.ts
- **Telegram voice notes (download, transcription through una, duration marker):** clients/telegram/src/voice.ts, clients/telegram/src/bridge.ts, clients/telegram/src/index.ts, clients/telegram/src/bot.ts
- **iPhone app (pairing, chat, attachments, approvals behind Face ID, drafts):** clients/mobile/src/screens/Pair.tsx, clients/mobile/src/screens/Chat.tsx, clients/mobile/src/screens/Approvals.tsx, clients/mobile/src/useMidna.ts
- **iPhone plain-HTTP addresses (App Transport Security exceptions):** clients/mobile/app.json, docs/mobile.md
- **Desktop connection and live conversation state:** clients/desktop/src/useMidna.ts, clients/desktop/src/screens/Main.tsx
- **Desktop onboarding:** clients/desktop/src/screens/Welcome.tsx, clients/desktop/src/screens/Install.tsx, clients/desktop/src/host.ts
- **Desktop chat (including the composer hint line and approval buttons):** clients/desktop/src/screens/Chat.tsx, clients/desktop/src/useMidna.ts

## How it works

- **Desktop installation:** Welcome discovers and ranks machines → Install displays installation events → host runs the CLI through Tauri or the development server → the CLI installs and pairs the machine → the desktop app receives a Connection
- **Desktop conversation:** Main creates useMidna with a Connection → useMidna uses MidnaClient for history and live events → Chat renders every midna line as a plain message, whatever its kind (questions add option buttons), and sends
- **Telegram voice note:** bot.ts takes the voice message → voice.ts downloads the audio → una transcribes it → bridge.ts sends the transcript to Midna with its duration marker
- **iPhone:** Pair takes an address (now the makima one, http://10.77.0.1:7717, from the simulator; a tailnet name later) and a code → pairs as kind mobile, naming the old token as replaces only to the same host → token in the Keychain → useMidna streams /v1/events through expo/fetch, refetching history on return to the foreground → approval buttons ask Face ID, then POST /v1/approvals/:id
- **Re-pairing:** hostInstall reads the token saved in client.json → install.ts sends it as replaces only when the saved address matches the host and port being paired → the daemon pairs the new device and retires the replaced one → the CLI saves the new client.json as kind cli → the desktop app keeps the old connection as connection.previous.json and passes its token to the bundled CLI through an environment variable → saving the new connection deletes connection.previous.json

## Key files

- clients/cli/src/main.ts — CLI entry point, commands, and hostInstall reuse of the saved token
- clients/cli/src/install.ts — machine installation, pairing with replaces, and progress events
- clients/cli/src/discover.ts — machine discovery with a timeout on health checks
- clients/telegram/src/bridge.ts — owner pairing, API exchange, /queue handling, approval buttons, persistent delivery positions, native reply context and id mapping
- clients/telegram/src/bot.ts — the bot's command menu, Telegram API wiring, and reply and voice message intake
- clients/telegram/src/voice.ts — voice note download, una transcription and duration marker
- clients/telegram/src/index.ts — Telegram bridge entry point
- clients/mobile/src/useMidna.ts — phone connection: history, event stream through expo/fetch, foreground reconnect, approvals, uploads
- clients/mobile/app.json — App Transport Security exceptions for plain HTTP to the phone's address
- clients/desktop/src/useMidna.ts — desktop connection, conversation state, and approval answers
- clients/desktop/src/screens/Main.tsx — connected desktop navigation and screen composition

## Rules and traps

- The Telegram bridge accepts only the owner chat bound by a one-time /start code; other chats are ignored.
- Persist Telegram update offsets and Midna outbox sequence positions so restarts do not replay or miss deliveries.
- Bridge state must be loaded before any handler reads it; reading it earlier yields stale or empty values.
- Pass PATH explicitly to Bun.which or child lookups; the ambient PATH may not reflect later changes.
- una forces English by default, so Korean speech comes back translated; language=ko keeps Korean but writes English words in Hangul, and the per-bridge language override is the only control.
- The bridge must not delete voice notes from una's history; kept notes may be learned from, and only test clips are deleted.
- A tap on a closed approval gets a 409: say so (Telegram: the tap's toast, buttons cleared), and guess its outcome only while its record still reads pending, or the guess overwrites the stream's real answer.
- The daemon refuses approval answers sent with the host's own token, so any client that answers must be paired separately.
- midna's input stops only when the user touches the mouse or keyboard within the last 2 s and the event did not come from midna.
- A version bump is five places, all matching: clients/desktop/package.json, clients/desktop/src-tauri/Cargo.toml, clients/desktop/src-tauri/Cargo.lock, clients/desktop/src-tauri/tauri.conf.json and packages/daemon/src/version.ts.

## What it talks to

- Protocol — clients use MidnaClient and shared API types; health() takes a cancel signal; hands wire shapes, including approval events and every op's arguments and results, are in packages/protocol/src/hands.ts; pair takes an optional replaces token and returns the retired device id; SendMessage.inReplyTo names a native reply's target (messageId, outboxId, quote, fallback), POST /v1/messages returns messageId in MessageReceipt, and HistoryItem and user_message carry inReplyTo
- Daemon — the CLI manages the host service and shows its spend and wakeup status; desktop, Telegram and the phone use its public API; the desktop is also a hands device over /v1/hands (hello, SSE stream, state, results), trusting the daemon key from pairing or its first hello; approval requests arrive on that stream and answers go to POST /v1/approvals/:id; pairing with replaces retires the named device, whatever its kind
- Host — CLI setup uses host configuration and service operations from the daemon package
- una — speech-to-text for Telegram voice notes; the Telegram bridge sends the downloaded audio and receives the transcript
