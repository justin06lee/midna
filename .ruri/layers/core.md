# midna — Core

One layer of midna's stack, owning `packages/core/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer core` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer core add|set|drop <section> …`. Where it and the code disagree, the code is right.

Core is midna's SQLite-backed state and memory: goals/tasks/commitments/calendar/people/decisions/notes, decaying semantic facts, conversation/message/episode history, devices, wakeups, outbox, jobs, inbound events, and an in-process event bus. Store composes the modules over one Bun SQLite database opened by openDatabase; context.ts renders the capped working context fresh each turn, pinned facts apart for the stable system prompt. Newcomer idea: durable structured record never decays or silently rewrites, while recall strength and delivery timing are computed, not stored as truth.

## Where to change what

- **Goals, tasks, commitments, calendar, people, decisions, notes:** packages/core/src/planning.ts, packages/core/src/db.ts
- **Semantic memory with decay and archive:** packages/core/src/memory.ts, packages/core/src/planning.ts, packages/core/src/time.ts
- **Conversations, messages, episodes (per-turn cost and tokens), spend by day and kind, history:** packages/core/src/log.ts, packages/core/src/attachments.ts
- **Native reply threading on messages (question link, in-reply-to with quote or fallback):** packages/core/src/log.ts, packages/core/src/db.ts, packages/core/src/index.ts
- **Wakeups (claimed as turns, a follow-up's twin), rituals, reminders, quiet-hours outbox delivery:** packages/core/src/schedule.ts, packages/core/src/store.ts, packages/core/src/time.ts, packages/core/src/bus.ts
- **Working context rendering:** packages/core/src/context.ts, packages/core/src/store.ts
- **Devices and pairing tokens:** packages/core/src/devices.ts, packages/core/src/db.ts
- **Message attachments:** packages/core/src/attachments.ts, packages/core/src/log.ts, packages/core/src/db.ts
- **Event fan-out:** packages/core/src/bus.ts
- **Inbound events from other programs (dedup, per-subject rate limit, merging into a waiting wakeup):** packages/core/src/inbound.ts, packages/core/src/db.ts
- **Device hands: each device's last hello, the audit log of what midna had it do, approvals and 10-min grants, pruning after 90 days:** packages/core/src/hands.ts, packages/core/src/db.ts
- **Jobs: long work run detached from turns in transient systemd user units, its record across restarts, and the wakeup that reports its end:** packages/core/src/jobs.ts, packages/core/src/db.ts, packages/core/src/store.ts

## How it works

- **Wakeup to user-visible delivery:** Schedule holds pending followup/ritual/reminder/system wakeup with due_at and optional cron → nextCron computes next firing in the store timezone → Fired wakeup produces an Outbox item → Outbox holds non-urgent items through quiet hours via afterQuietHours → Release assigns stream sequence number in delivery order → Bus emits the event for live clients
- **Conversation turn persistence:** Log owns conversations, messages, episodes, actions → User message stored with client, reply_to, seen_by_brain flags → A native reply sets in_reply_to to a message id, with reply_quote or reply_fallback, kept apart from reply_to → Staged attachments bind to one message or one outbox item → Midna reply creates an outbox item plus message row → History joins messages to outbox delivery state for replay
- **Fact recall and decay:** Fact stored with kind, importance, use counts, links to live entities → Recall scores via strength with disuse decay by importance → Recall renews strength and updates last_used_at/use_count → Ties to active goals/open commitments/people hold facts alive → Weak facts archived, contradicted facts superseded with history kept

## Key files

- packages/core/src/store.ts — composes database, settings, and all modules into one Store
- packages/core/src/db.ts — opens SQLite database and owns ordered append-only migrations
- packages/core/src/planning.ts — goals, tasks, commitments, calendar, people, decisions, notes plus FTS query helper
- packages/core/src/memory.ts — semantic facts with importance-weighted decay, recall scoring, archive/supersede
- packages/core/src/log.ts — conversations, messages, episodes, actions, native reply fields and history replay
- packages/core/src/schedule.ts — wakeups with cron, rituals/reminders, and quiet-hours outbox release
- packages/core/src/context.ts — the capped working context, per turn: renderNow, contextSections (fixed order, unpinned facts), pinnedFacts
- packages/core/src/attachments.ts — message file bytes stored beside their conversation with MIME detection
- packages/core/src/devices.ts — device registration, hashed tokens, pairing codes; pairing again with the old token (replaces) revokes that device
- packages/core/src/bus.ts — in-process fan-out of stream events to listeners
- packages/core/src/time.ts — epoch-ms time, timezone formatting, local parsing, quiet-hours helpers
- packages/core/src/index.ts — public re-exports of the whole layer
- packages/core/src/inbound.ts — inbound events: dedup by (source, ext_id), one wakeup per source and subject per window, merged while it waits
- packages/core/src/hands.ts — device hands: each device's last hello (state updates folded in, nonce dropped) and the device_commands audit log
- packages/core/src/jobs.ts — jobs table (migration 8): status, exit code, pid and its start time, systemd unit; end() queues the wakeup that reports it; logTail()

## Rules and traps

- Migrations in db.ts are append-only: never edit an applied migration, existing midna.db must upgrade cleanly.
- Time is epoch milliseconds in storage; always convert/display through time.ts in the user's timezone.
- Goal changes are by renegotiation with a recorded reason, never silent overwrites.
- Facts are archived or superseded, never deleted; keep the history chain.
- An attachment belongs to at most one outbox item or one message; otherwise it stays loose.
- Outbox release order defines client replay order; held-back items must keep their sequence gap until quiet hours allow.
- Bus listeners must never throw; emit already isolates failures but a broken listener still blinds live clients.
- Only the device token hash is stored; the plain token is visible once at creation.
- An attachment's place in its message is attachments.position, set by link() from the order of the ids it is given; read them ORDER BY position, rowid — rowid is creation order, which is not the sender's order.
- Inbound events and job ends arrive as follow-up wakeups created_by 'event:<source>' / 'job:<id>' (no new wakeups.kind: it has a CHECK). Due follow-ups are claimed as turns (Schedule.claimTurns: 5 min, 8 max); wakeups.joined_to (migration 11) names the lead.
- device_commands rows are an audit log: record() once when a command is decided (refused and denied end then), finish() takes only the first ending. Attachments.copy() sends a file already kept (a device screenshot) on as a new loose attachment, so it stages in call order.
- A stale pairing is retired by its token (PairRequest.replaces), never by name or kind: this Mac's CLI host-install pairing and the desktop app share kind desktop and the same hostname name, and macOS hostname suffixes drift (-3, -1332).
- A job's end is first-ending-wins: Jobs.end() queues its wakeup (none for stopped, or quiet when it never started).
- episodes.cost_usd is the turn's own cost (migration 10); session_cost_usd is the running total Claude Code reports across resumed turns, and endEpisode() subtracts the session's previous one. Never sum session_cost_usd.
- messages.reply_to answers a question (an outbox id); messages.in_reply_to is a native reply (a message id) with reply_quote and reply_fallback (JSON, kept only when no id resolved). Keep them apart.

## What it talks to

- Protocol — Attachment, OutboxItem, Priority, HistoryItem, StreamEvent, and Mode types shape Core's interfaces, including the native reply shape
- Daemon — drives Store/Schedule/Outbox/Bus for HTTP API, event stream, scheduler loop, and bridge supervision
- Assistant — reads renderNow, contextSections and pinnedFacts for its prompts and calls Planning/Memory/Log/Schedule tools for chat and wakeup orchestration
