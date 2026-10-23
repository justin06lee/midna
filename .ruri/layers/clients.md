# midna — Clients

One layer of midna's stack, owning `clients/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer clients` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer clients add|set|drop <section> …`. Where it and the code disagree, the code is right.

The clients layer holds the Bun CLI, a Telegram bridge (native replies, una voice-note transcription, full or alerts-only mode), a desktop app and an iPhone app. The CLI handles setup and local status lines; Telegram, desktop and phone all use the public Midna API through MidnaClient. Clients are thin: the daemon owns state and decisions, and each bridge only filters and forwards what it is given. Re-pairing retires the previous pairing by naming the old token it replaces.

## Where to change what

- **CLI commands (status spend and wakeup lines):** clients/cli/src/main.ts
- **Machine discovery and installation:** clients/cli/src/discover.ts, clients/cli/src/install.ts, clients/cli/src/main.ts
- **Retiring the previous pairing on reinstall or reconnect:** clients/cli/src/install.ts, clients/cli/src/main.ts, clients/desktop/src-tauri/src/lib.rs, test/hosting.e2e.test.ts
- **Telegram pairing, commands, delivery and approval buttons:** clients/telegram/src/bridge.ts, clients/telegram/src/bot.ts
- **Telegram alerts-only mode (which messages Telegram receives):** clients/telegram/src/bridge.ts, clients/telegram/src/index.ts, clients/cli/src/main.ts, test/telegram-alerts.e2e.test.ts
- **Telegram native replies (Telegram reply threads mapped to midna message ids):** clients/telegram/src/bridge.ts, clients/telegram/src/bot.ts, test/telegram.e2e.test.ts
- **Telegram voice notes (download, transcription through una, duration marker):** clients/telegram/src/voice.ts, clients/telegram/src/bridge.ts, clients/telegram/src/index.ts, clients/telegram/src/bot.ts
- **iPhone app (pairing, chat, attachments, approvals behind Face ID, drafts):** clients/mobile/src/screens/Pair.tsx, clients/mobile/src/screens/Chat.tsx, clients/mobile/src/screens/Approvals.tsx, clients/mobile/src/useMidna.ts
- **iPhone keyboard lift (composer stays above the keyboard, including after backgrounding):** clients/mobile/src/keyboard.ts, clients/mobile/src/screens/Chat.tsx, clients/mobile/test/keyboard.test.ts
- **iPhone image attachments (thumbnails in messages, composer chip, full-screen viewer):** clients/mobile/src/attachments.tsx, clients/mobile/src/screens/Chat.tsx
- **iPhone chat rendering (markdown, composer keyboard avoidance):** clients/mobile/src/markdown.tsx, clients/mobile/src/screens/Chat.tsx, clients/mobile/package.json
- **iPhone header (bare midna mark on the left, working spinner to its left, offline greying):** clients/mobile/src/screens/Main.tsx, clients/mobile/assets/mark.svg, clients/mobile/assets/mark.png
- **iPhone fonts (system font, SF Mono for code):** clients/mobile/src/theme.ts, clients/mobile/src/markdown.tsx

## How it works

- **Desktop installation:** Welcome ranks discovered machines → Install shows installation events → host runs the CLI through Tauri or the dev server → the CLI installs and pairs the machine → the desktop app receives a Connection
- **Desktop conversation:** Main creates useMidna with a Connection → useMidna uses MidnaClient for history and live events → Chat renders each midna line (questions add option buttons) and sends
- **Telegram voice note:** bot.ts takes the voice message → voice.ts downloads the audio → una transcribes it → bridge.ts sends the transcript with its duration marker
- **Telegram alerts-only delivery:** The daemon outbox hands each item to the Telegram bridge → bridge.ts checks the mode read at start → Chat replies and fyi items are dropped → Reminders and urgent or normal proactive messages go out, with buttons where asked
- **iPhone:** Pair takes an address and a code → pairs as kind mobile, naming the old token as replaces only to the same host → token goes to the Keychain → useMidna streams /v1/events through expo/fetch, refetching history on foreground → Chat renders markdown and keeps the composer above the keyboard → approvals ask Face ID, then POST /v1/approvals/:id

## Key files

- clients/cli/src/main.ts — CLI entry point, commands, mode passed to telegram run, and hostInstall reuse of the saved token
- clients/cli/src/install.ts — machine installation, pairing with replaces, and progress events
- clients/cli/src/discover.ts — machine discovery with a timeout on health checks
- clients/telegram/src/bridge.ts — owner pairing, API exchange, /queue handling, approval buttons, alerts-only filter, persistent delivery positions, native reply context and id mapping
- clients/telegram/src/bot.ts — the bot's command menu, Telegram API wiring, and reply and voice message intake
- clients/telegram/src/voice.ts — voice note download, una transcription and duration marker
- clients/telegram/src/index.ts — Telegram bridge entry point
- clients/mobile/src/useMidna.ts — phone connection: history, event stream, foreground reconnect, approvals, uploads
- clients/mobile/src/screens/Chat.tsx — phone chat screen with composer, keyboard lift and message list
- clients/mobile/src/keyboard.ts — pure keyboard lift calculation from the measured frame and keyboard frame
- clients/mobile/src/attachments.tsx — image thumbnails, composer chip and full-screen viewer with share
- clients/mobile/src/screens/Main.tsx — phone header with the bare midna mark, working spinner and offline greying
- clients/mobile/assets/mark.svg — bare midna mark glyph used by the phone header
- clients/mobile/src/theme.ts — phone font and monospace settings
- clients/mobile/test/keyboard.test.ts — unit tests for the keyboard lift

## Rules and traps

- The Telegram bridge accepts only the owner chat bound by a one-time /start code; other chats are ignored.
- Persist Telegram update offsets and Midna outbox sequence positions so restarts do not replay or miss deliveries.
- Bridge state must be loaded before any handler reads it; earlier reads give stale or empty values.
- Pass PATH explicitly to Bun.which or child lookups; the ambient PATH may not reflect later changes.
- una forces English by default, so Korean speech comes back translated; language=ko keeps Korean but writes English words in Hangul, and the per-bridge language override is the only control.
- The bridge must not delete voice notes from una's history; kept notes may be learned from, and only test clips are deleted.
- A tap on a closed approval gets a 409: say so (Telegram: the tap's toast, buttons cleared), and guess its outcome only while its record still reads pending, or the guess overwrites the stream's real answer.
- The daemon refuses approval answers sent with the host's own token, so any client that answers must be paired separately.
- midna's input stops only when the user touches the mouse or keyboard within the last 2 s and the event did not come from midna.
- Alerts mode drops chat replies and fyi items; a reply to a Telegram-sent message is dropped too, since kind cannot show where a message came from.
- Alerts mode is read at bridge start: after editing config.json, POST /v1/bridges/reload or restart midna.
- An unknown mode falls back to full with a log line, so a typo cannot silence Telegram.
- The alerts notice goes out once per local day, its day kept as alertsNoticeDay in telegram.json.

## What it talks to

- Protocol — clients use MidnaClient and shared API types; hands wire shapes are in packages/protocol/src/hands.ts; pair takes an optional replaces token and returns the retired device id; SendMessage.inReplyTo names a native reply's target; HistoryItem and user_message carry inReplyTo
- Daemon — the CLI manages the host service and shows spend and wakeup status; desktop, Telegram and the phone use its public API; the desktop is also a hands device over /v1/hands, trusting the daemon key from pairing or its first hello; the daemon reads bridges.telegram.mode and passes it to the bridge as MIDNA_BRIDGE_MODE
- Host — CLI setup uses host configuration and service operations from the daemon package
- una — speech-to-text for Telegram voice notes; the bridge sends the downloaded audio and receives the transcript
