# midna — Assistant

One layer of midna's stack, owning `packages/agent/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer assistant` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer assistant add|set|drop <section> …`. Where it and the code disagree, the code is right.

The Assistant layer turns chats and due wakeups into audited episodes and runs the selected agent through yagami. It builds a byte-stable system prompt and ends each turn's prompt with the current Core state, keeps a brain session warm per conversation, and exposes Midna tools through an episode-bound MCP endpoint. Chat replies reach the user directly, while wakeups require the message_user tool to do so; interrupts, /queue and reply retries are in the flows and rules.

## Where to change what

- **Chat and wakeup orchestration:** packages/agent/src/assistant.ts, packages/agent/src/prompt.ts
- **Native reply threads (inReplyTo: the [Replying to …] note, highlighted quote, fallback, answering-your-question line):** packages/agent/src/prompt.ts, packages/agent/src/assistant.ts, packages/daemon/test/replies.test.ts
- **Chat reply guarantees and interrupts (empty or swallowed replies, fallback, /queue, coalescing, wakeups set aside, leftovers after restart):** packages/agent/src/assistant.ts, packages/daemon/test/daemon.test.ts, packages/agent/test/noreply.test.ts, packages/agent/test/interrupt.test.ts
- **Agent provider and session behavior:** packages/agent/src/brain.ts, packages/agent/src/assistant.ts
- **System and wakeup prompts:** packages/agent/src/prompt.ts
- **Midna tools, incl. device_* (look, input, AppleScript, shell, files, clipboard) via ToolContext.hands and job_start/job_list/job_stop via ToolContext.jobs:** packages/agent/src/tools.ts, packages/agent/src/mcp.ts, packages/agent/src/hands.ts, packages/agent/src/jobs.ts
- **Brain availability and sign-in check:** packages/agent/src/check.ts, packages/agent/src/brain.ts, packages/agent/test/check.test.ts
- **Public exports:** packages/agent/src/index.ts
- **Images and files midna sends and receives:** packages/agent/src/attachments.ts, packages/agent/src/tools.ts, packages/agent/src/assistant.ts

## How it works

- **Chat or wakeup:** Assistant starts an episode using Core data → a byte-stable system prompt (settings, environment, pinned facts); the turn's prompt has a native reply's [Replying to …] note, the user's message under its own header, and ends with stateNote (the clock, then every context section, or for a resumed session only the changed ones) → The selected yagami brain runs with an episode MCP endpoint → MCP tool calls use the episode context for the audit log → Assistant handles the reply and conversation session → An empty or 'No response requested' reply is asked again in the same session → If still empty, a fallback reply goes out with a 60 s follow-up wakeup, and the messages are marked seen
- **MCP tool request:** handleMcp receives a request and ToolContext → createToolServer registers tools against the Core store → A fresh stateless transport handles the request → The server closes after the request
- **Interrupt:** receive() gets a user message without /queue → aborts the conversation's chat turn and every running wakeup → brain.ts interrupts the CLI (error_during_execution; transcript keeps finished tool results) and keeps the session id → the turn ends quietly with its messages unseen → kick waits for a 3 s lull, so a burst is one interrupt → the next turn resumes that session; its prompt lists every unanswered message first, then a note on what was cut short → a set-aside wakeup is postponed 60 s and resumes in its own session

## Key files

- packages/agent/src/assistant.ts — orchestrates chat turns, wakeups, interrupts, inbound events (hear()), episodes, reply retries, native reply resolution, and conversation brain sessions
- packages/agent/src/brain.ts — selects and runs the chosen agent harness through yagami, one Claude Code process per turn
- packages/agent/src/tools.ts — defines Midna's MCP tools, their descriptions, and their episode context
- packages/agent/src/prompt.ts — builds the byte-stable system prompt, the end-of-turn state (stateNote), wakeup prompts, the inbound-events task (eventsTask), the native-reply note, and the turn prompt that leads with the user's message
- packages/agent/src/mcp.ts — handles an MCP request with a fresh episode-bound server
- packages/agent/src/check.ts — runs a real brain turn and classifies sign-in and not-installed failures
- packages/agent/test/noreply.test.ts — tests swallowed replies, fallback wakeups, mid-turn messages, and failed turns
- packages/agent/test/check.test.ts — tests the brain check against yagami's real toApiError
- packages/agent/src/index.ts — exports the layer's public API
- packages/agent/src/attachments.ts — turns host paths, URLs and Markdown images of local files into attachments; copies the user's attachments into the workspace for the brain
- packages/agent/test/interrupt.test.ts — tests the /queue prefix and the tool-detail summary used in interrupt notes

## Rules and traps

- Bind tool calls to the correct episode ID so they appear under the right audit entry.
- Use the store's timezone when converting model-facing local times; the store uses epoch milliseconds.
- A wakeup reaches the user only through message_user. One turn may carry several wakeups due together; schedule_wakeup refuses a near-twin follow-up. No wakeup budget or over-budget note, on purpose (removed 0.11.2).
- A chat brain session restarts after four idle hours or 40 turns.
- Brain mode: autonomous lets tools run; ask restricts host actions but passes midna's MCP tools, so HandsHub gates device_* tools itself.
- Keep yagami's authentication failure details so the user can be told how to sign in; match sign-in and not-installed errors against yagami's toApiError wording, never hand-written strings, which drift from the real contract.
- An empty reply or a bare 'No response requested' is not an answer; retry in the same session before any fallback.
- Mark a user's messages seen only after a turn answers them. A new message interrupts the running chat turn and any wakeup; '/queue …' (prefix stripped) waits for the turn in progress instead. Wakeups and notifications never interrupt a chat turn.
- A failed or interrupted turn leaves its messages for the next turn, which answers them together. An interrupted one sends no error or fallback and keeps its session for the next turn to resume. After a restart, answerLeftovers() answers MAIN's unseen user messages from the last 6 h, once.
- Harness notifications such as task-notification can be merged into a turn's prompt; keep the user's message first under its own header so it is not read as automated.
- Each chat turn is its own Claude Code process, so background shells and subagents die at turn end or interrupt; long work goes through job_start (the daemon's job registry), which outlives turns and restarts and wakes midna when the job ends.
- Nothing volatile in the system prompt (daemon.test.ts checks it stays byte-identical); state ends the turn's prompt via stateNote, and Assistant.stateSeen gives a resumed session only the changed sections.

## What it talks to

- Core — supplies the store, settings, planning data, context, episodes, time helpers, and resolves native reply links (messages.in_reply_to, outbox ids)
- Daemon — invokes Assistant (receive() returns the stored message id and resolves inReplyTo) and serves its MCP handler
- Runtime — yagami runs the selected agent CLI and connects it to MCP tools; each chat turn starts a fresh CLI process that resumes the conversation's session and exits when the turn ends
- Wire contract — SendMessage.inReplyTo and the ReplyRef carried by history and user_message are typed in packages/protocol/src/index.ts
