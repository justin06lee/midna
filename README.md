# midna

**A proactive personal assistant that lives on your own machine.**<br>
*Chief of staff, thinking partner and memory — built around your objectives, running on the agent CLIs you already signed into.*

---

midna runs continuously on one computer you own (the *host*), keeps track of your life in a SQLite database, and reaches you on your phone and computers. It is not a chatbot that waits for questions: it holds your objectives, schedules its own follow-ups, sends a morning brief and an evening review, tracks what you promised people and what they promised you, and pushes back when a new commitment would crowd out what you said matters.

The brain is whichever agent CLI you pick, through [yagami](../yagami): Claude Code by default, or Codex, Gemini CLI, OpenCode and any other ACP agent. The brain has the run of the host and midna's own tools over MCP.

## Status

**Phase 2 — the desktop app.** The daemon, database, memory, objectives, scheduler, rituals, API, CLI and Telegram bridge work end to end, with live turns through Claude Code and Codex. The desktop app (Linux and macOS) finds your machines over makima or Tailscale, makes the one you click midna's home, and is where you talk to it. Not built yet: the unified inbox (mail connectors and spam filtering), calendar sync, the overnight memory pass that uses a model, voice notes.

## Install

```sh
make            # the CLI on your PATH, and the desktop app for this machine
```

That is the golden path: `bun install`, the single-file `midna` binary into `~/.local/bin`, and the desktop app built for this machine and installed. On macOS that means the `.app` in `~/Applications`. On Linux it's a `.deb` where there is dpkg, an `.rpm` where there is rpm, or an AppImage anywhere else, Arch included. The app needs a Rust toolchain, plus WebKitGTK on Linux. `cd clients/desktop && bun run app:build` builds without installing. `make check` runs the typecheck, boundary rule and tests. `make update` rebuilds, reinstalls and restarts a host's service.

### Choosing where midna lives — from the app

Open the app and it asks **where midna should live**. It lists this computer and every machine it can see on makima or Tailscale, and probes each one for a midna already running. Click one:

1. **Reach the machine.** Over SSH: to its makima address, or its Tailscale name. A host key seen for the first time is trusted, because the tunnel has already proved which machine it is. A key that *changed* still fails.
2. **Put midna on it.** The right build for that machine: the app's own `midna` when the platforms match, otherwise a compressed build it carries. The bundle includes Linux kits; `MIDNA_KITS_FOR` picks others. The build streams over SSH and is unpacked on the far side. An older midna there is replaced and kept as `midna.prev`.
3. **Check its brain.** One tiny real turn through the chosen model *on that machine*. If Claude Code isn't signed in there, the app says so and opens a terminal there for you to sign in.
4. **Start midna.** As a systemd user service with lingering on Linux, or a launchd agent on macOS. It gets the login shell's PATH, so the brain's tools resolve the way they do in your terminal. An existing install keeps its own settings and is only restarted onto the new build.
5. **Pair this computer.** A one-time code minted there and spent from here. makima publishes the new loopback service to the mesh within seconds. On Tailscale, midna also listens on the tailnet address.

The same thing works from a terminal: `midna devices`, then `midna host install tenet`.

### Without the app

On the host itself:

```sh
make build install && midna setup
```

`setup` asks for the brain (`claude:opus`, `codex:gpt-5.6-sol`, …), the timezone and the permission mode, then installs the service and optionally connects Telegram. `midna setup --yes --model … --timezone …` asks nothing. `bun run build:all` cross-builds `dist/midna-{linux,darwin}-{x64,arm64}`.

## Using it

The app has four views:

- **Chat** — everything said on any device, with midna's questions as buttons.
- **Today** — the calendar, what's due, open promises, and what midna will do on its own.
- **Objectives** — the goal tree everything hangs from. It is read-only: goals change by talking them through, and each change keeps its reason.
- **Settings** — the brain, the mode, quiet hours, your phone, and paired devices.

Closing the window keeps midna in the tray, and notifications arrive while you're elsewhere. If midna can't think (its brain is signed out or missing), a banner says so and offers the fix.

From a terminal:

```sh
midna chat                  # talk to it in the terminal
midna send "remind me to call mom at 6pm"
midna status
midna mode ask              # ask before acting; `midna mode autonomous` to undo
midna model codex:gpt-5.6-sol
```

**From your phone:** in the app go to Settings → Your phone, paste a bot token from @BotFather, and send the bot the `/start <code>` it shows. `midna telegram setup` does the same from a terminal. The bot answers exactly one chat, yours, and ignores everyone else. `/pause` switches to ask mode and `/resume` switches back.

**Another terminal:** run `midna pair` on the host, then `midna connect <url> <code>` on the other machine. Every device pairs with its own revocable token, even on a private mesh.

## How it fits together

```
phone ── Telegram bridge ──┐
laptop ── desktop app ─────┼── midna API (HTTP + event stream) ──┐
         └─ bundled `midna` (find machines, set one up over SSH)  │
                           └──────────── host ────────────────────┤
                                 midnad: scheduler · outbox · SQLite
                                 brain: yagami → claude / codex / any ACP agent
                                        └─ midna's tools over MCP (/mcp)
```

```
packages/protocol    the API contract and the app↔binary contract — the only thing clients may import
packages/core        objectives, tasks, commitments, calendar, people, decisions, notes, memory, schedule, outbox
packages/agent       the brain (yagami), midna's MCP tools, the system prompt, the orchestrator, brain health
packages/daemon      midnad: API, event stream, scheduler, bridge supervisor, service install
clients/cli          the `midna` command: hosts the daemon, finds machines, installs over SSH, runs the bridge
clients/telegram     the Telegram bridge
clients/desktop      the desktop app: Tauri 2 + React; a thin Rust shell around the bundled `midna`
```

**Every client is deletable.** The Telegram bridge and the desktop app are ordinary clients of the public API, each with its own device token. Nothing in `packages/` knows either exists, and the daemon knows bridges only by name and launch command. `bun run boundaries` enforces the dependency rule against real import statements. Replacing Telegram with a native phone app means writing another client of the same API.

## What midna keeps

| Layer | What | Lifecycle |
|---|---|---|
| **Structured state** | the objective tree, tasks, commitments both ways, calendar, people, the decision journal, notes, midna's own wakeups | Never forgotten. Things close, finish or get dropped, and the record stays |
| **Episode log** | every message, every episode, every tool call (the audit log) | Kept and full-text searchable; never loaded whole |
| **Facts** | small claims with an importance, links to what they're about, and a use history | Decay unless used or tied to something alive. Contradictions supersede, keeping history |
| **Working context** | a summary rendered from all of the above at the start of each session, every section capped | Rebuilt every time. This is what the model always sees |

**Forgetting:** a fact's strength halves with disuse, at a rate set by its importance (3 days for trivia, 2 years for core identity). Recall renews it. A link to an active goal, an open commitment, a person or an unreviewed decision holds it up. Each night, facts below the line are archived: taken out of recall, not deleted. Pinned facts never fade.

**Objectives:** every task points up to a goal, and the context flags tasks that don't. Changing a goal is a renegotiation: it takes a reason, and the change is recorded. That is how midna tells a change of mind from drift.

## Proactivity

- **Wakeups:** midna schedules its own future, e.g. "check whether Bob replied", "the deadline is in two days". Reminders you ask for are delivered verbatim at their time, without waking a model.
- **Rituals:** a morning brief at 08:00, an evening review at 21:00, a weekly review on Sunday at 18:00, and memory upkeep at 03:30. All are configurable.
- **Interruption budget:** every message is *urgent*, *normal* or *fyi*. Non-urgent news waits out quiet hours (23:00–08:00 by default). Clients replay by stream position, so a held message is never missed.
- **Continuity:** when you reply to something midna sent on its own, the chat brain sees what it sent. Several quick messages arrive as one turn.

## Permission modes

- **autonomous** (the default): the brain runs with permissions bypassed, so shell, files and network all go through without asking. It judges actions against your objectives.
- **ask**: reads and midna's own tools run freely. Anything else is refused with an instruction to propose it to you first.

In both modes, every tool call is in the audit log, and instructions found inside emails, web pages or documents are treated as data, never obeyed.

## Development

```sh
bun run check       # typecheck (both projects) + boundaries + tests (no tokens spent)
bun run smoke       # one live turn through claude:sonnet (small token cost)
bun run smoke codex # …or any other brain
bun run dev         # the daemon from source
cd clients/desktop && bun run dev   # the app's interface in a browser, driving the CLI from source
```

`MIDNA_HOME` moves everything (database, config, tokens, workspace) somewhere else. The default is `~/.local/share/midna` on Linux and `~/Library/Application Support/midna` on macOS.
