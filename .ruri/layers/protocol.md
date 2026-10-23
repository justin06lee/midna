# midna — Protocol

One layer of midna's stack, owning `packages/protocol/, packages/protocol/test/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer protocol` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer protocol add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer is the one client-facing contract for midna: Zod schemas in index.ts for wire messages and events, a MidnaClient for calling the daemon, and plain TypeScript types in hosting.ts for device discovery and install output. Device hands wire shapes (registration, the signed command envelope, results) live in hands.ts and are tested against a signed fixture. Every client, including the desktop app, CLI, Telegram bridge, and iPhone app, speaks only this API and has no side door into the daemon. A newcomer must grasp that these shapes are the public surface, so changing one changes what every client receives.

## Where to change what

- **Wire message and event shapes:** packages/protocol/src/index.ts
- **Outbox items, delivery order, and quiet hours:** packages/protocol/src/index.ts
- **Client calls to the daemon (MidnaClient, injected fetch, errors):** packages/protocol/src/index.ts, packages/protocol/test/events.test.ts
- **Device hands: registration, OS, displays, capabilities, policy, signed command envelope, every op's args and result data, approvals:** packages/protocol/src/hands.ts, packages/protocol/src/index.ts, packages/protocol/test/hands.test.ts, packages/protocol/fixtures/hands.json
- **Remote pause setting, daemon key on pairing, and the old token a re-pairing replaces:** packages/protocol/src/index.ts
- **Device discovery shape:** packages/protocol/src/hosting.ts
- **Host install steps and install events:** packages/protocol/src/hosting.ts
- **Default port and service name:** packages/protocol/src/index.ts
- **Attachments: the shape on outbox items, history and user messages, upload and fetch:** packages/protocol/src/index.ts
- **Inbound events: SendEvent, EventReceipt, MAX_EVENT_DATA_BYTES, EVENT_WINDOW_MS, MidnaClient.event:** packages/protocol/src/index.ts

## How it works

- **Host install as the desktop app drives it:** Reach the machine (INSTALL_STEPS.reach) → Put midna on it (binary) → Check its brain (brain) → Start midna (start) → Pair this computer (pair) → Each step reports an InstallEvent, and the result comes back as the install JSON
- **Outbox item delivery:** Midna creates an OutboxItem with kind, priority, and optional options → If deliverAfter is set, the item is held back (quiet hours) → When released for delivery, it is assigned its seq stream position → Clients receive it on the event stream → Any item can be replayed by its id

## Key files

- packages/protocol/src/index.ts — the Zod wire schemas, MidnaClient, and the API's exports
- packages/protocol/src/hands.ts — device hands shapes: registration, signed command envelope, results
- packages/protocol/src/hosting.ts — types for devices and install output that the desktop app reads
- packages/protocol/test/hands.test.ts — checks the signed fixture verifies and a tampered copy fails
- packages/protocol/test/events.test.ts — tests the event stream and MidnaClient with an injected fetch
- packages/protocol/fixtures/hands.json — signed envelope fixture the hands tests verify against

## Rules and traps

- No client gets a side door into the daemon; all access goes through the types and MidnaClient defined here.
- seq is assigned only when an OutboxItem is released for delivery, not when it is created.
- deliverAfter holds an item back for quiet hours; clients may show it early.
- An OutboxItem's options are suggested answers only; the user may still reply in free text.
- The desktop app never speaks SSH itself; it drives hosting only through `midna devices --json` and `midna host install --json`.
- DiscoveredDevice.id is a stable key of the form "local", "makima:tenet", or "tailscale:tenet"; keep it stable.
- Tailscale does not carry loopback, so a device with a listen address needs midna to listen there to be reachable that way.
- MidnaClient.events() closes its connection however the stream ends (its own AbortController, aborted in finally) and treats 60s without a byte as a dead connection; the daemon's 25s keepalive keeps a live one under that.
- A hands command is signed as text: signed = canonicalJson(HandsCommand), sig = Ed25519 over its UTF-8 bytes; the device verifies the bytes as received, then parses, and checks its nonce, a rising seq and a new id. Keep fixtures/hands.json in step (HANDS_FIXTURE=write bun test packages/protocol).
- Attachments: any type up to MAX_ATTACHMENT_BYTES (100 MB; POST /v1/attachments?name=… with a raw body and Content-Type answers 413 above it), at most MAX_ATTACHMENTS_PER_MESSAGE (20) per message, in the sender's order, which every client keeps. Unsent uploads: DELETE /v1/attachments/:id (409 once sent), and the daemon sweeps them hourly after UNSENT_ATTACHMENT_TTL_MS (24h). Attachment.caption (0.5+) and kind 'file' for an image sent as a file are the sender's choice; older hosts omit caption (0.4) or attachments (<0.4): read ?? null / ?? [].
- Inbound events go to POST /v1/inbound (GET /v1/events is the outbound SSE stream). The contract with ruri is fixed: midna event --source --title [--json -|file]; id defaults to data.id, the rate-limit subject is data.project.id (else path, name). docs/inbound-events.md documents it.
- A client that cannot use the global fetch passes its own as the third argument, `new MidnaClient(url, token, { fetch })`; the iPhone app needs this for its event stream.
- Status.spend (SpendDay[]: 7 local days, today first, byKind chat|followup|event|job|ritual) and Status.wakeups {turns, usd} (a count, no limit) are from 0.11; older hosts omit them. There is no wakeupBudget setting since 0.11.2; 0.11.0/0.11.1 hosts still send wakeups.budget.

## What it talks to

- Clients — the Bun CLI, the Telegram bridge, and the iPhone app (clients/mobile) use only the public API these schemas and MidnaClient define; the iPhone app injects its own fetch into MidnaClient. The Clients teammate builds the desktop app side of device hands against hands.ts
- Daemon — the HTTP API and event stream carry the messages typed in index.ts; the device hands stream and result routes will carry the shapes in hands.ts
- Host — the midna binary prints the JSON that hosting.ts describes for devices and installs
- Desktop app — drives host discovery and installation through the hosting.ts shapes
