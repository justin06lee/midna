# midna — Protocol

One layer of midna's stack, owning `packages/protocol/, packages/protocol/test/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer protocol` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer protocol add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer is the one client-facing contract for midna: Zod schemas in index.ts for wire messages and events, a MidnaClient for calling the daemon, and plain TypeScript types in hosting.ts for device discovery and install output. Every client, including the desktop app, CLI, and Telegram bridge, speaks only this API and has no side door into the daemon. A newcomer must grasp that these shapes are the public surface, so changing one changes what every client receives.

## Where to change what

- **Wire message and event shapes:** packages/protocol/src/index.ts
- **Outbox items, delivery order, and quiet hours:** packages/protocol/src/index.ts
- **Client calls to the daemon (MidnaClient, errors):** packages/protocol/src/index.ts
- **Device discovery shape:** packages/protocol/src/hosting.ts
- **Host install steps and install events:** packages/protocol/src/hosting.ts
- **Default port and service name:** packages/protocol/src/index.ts
- **Attachments: the shape on outbox items, history and user messages, upload and fetch:** packages/protocol/src/index.ts

## How it works

- **Host install as the desktop app drives it:** Reach the machine (INSTALL_STEPS.reach) → Put midna on it (binary) → Check its brain (brain) → Start midna (start) → Pair this computer (pair) → Each step reports an InstallEvent, and the result comes back as the install JSON
- **Outbox item delivery:** Midna creates an OutboxItem with kind, priority, and optional options → If deliverAfter is set, the item is held back (quiet hours) → When released for delivery, it is assigned its seq stream position → Clients receive it on the event stream → Any item can be replayed by its id

## Key files

- packages/protocol/src/index.ts — the Zod wire schemas, MidnaClient, and the API's exports
- packages/protocol/src/hosting.ts — types for devices and install output that the desktop app reads

## Rules and traps

- No client gets a side door into the daemon; all access goes through the types and MidnaClient defined here.
- seq is assigned only when an OutboxItem is released for delivery, not when it is created.
- deliverAfter holds an item back for quiet hours; clients may show it early.
- An OutboxItem's options are suggested answers only; the user may still reply in free text.
- The desktop app never speaks SSH itself; it drives hosting only through `midna devices --json` and `midna host install --json`.
- DiscoveredDevice.id is a stable key of the form "local", "makima:tenet", or "tailscale:tenet"; keep it stable.
- Tailscale does not carry loopback, so a device with a listen address needs midna to listen there to be reachable that way.
- MidnaClient.events() closes its connection however the stream ends (its own AbortController, aborted in finally) and treats 60s without a byte as a dead connection; the daemon's 25s keepalive keeps a live one under that.
- OutboxItem.attachments defaults to [] and a host older than 0.4 sends none: clients read item.attachments ?? []. SendMessage.text may be empty only when attachments are given; an attachment's bytes come from GET /v1/attachments/:id with the bearer token, never a URL with the token in it.

## What it talks to

- Clients — the Bun CLI and Telegram bridge use only the public API these schemas and MidnaClient define
- Daemon — the HTTP API and event stream carry the messages typed in index.ts
- Host — the midna binary prints the JSON that hosting.ts describes for devices and installs
- Desktop app — drives host discovery and installation through the hosting.ts shapes
