# midna — Assistant

One layer of midna's stack, owning `packages/agent/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer assistant` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer assistant add|set|drop <section> …`. Where it and the code disagree, the code is right.

The Assistant layer turns chats and due wakeups into audited episodes and runs the selected agent through yagami. It builds prompts from current Core settings and context, keeps a brain session warm per conversation, and exposes Midna tools through an episode-bound MCP endpoint. Chat replies reach the user directly; wakeups require the message_user tool to do so.

## Where to change what

- **Chat and wakeup orchestration:** packages/agent/src/assistant.ts, packages/agent/src/prompt.ts
- **Agent provider and session behavior:** packages/agent/src/brain.ts, packages/agent/src/assistant.ts
- **Midna tools:** packages/agent/src/tools.ts, packages/agent/src/mcp.ts
- **System and wakeup prompts:** packages/agent/src/prompt.ts
- **Brain availability and sign-in check:** packages/agent/src/check.ts, packages/agent/src/brain.ts
- **Public exports:** packages/agent/src/index.ts

## How it works

- **Chat or wakeup:** Assistant starts an episode using Core data → Prompt functions combine settings, environment, and fresh context → The selected yagami brain runs with an episode MCP endpoint → MCP tool calls use the episode context for the audit log → Assistant handles the reply and conversation session
- **MCP tool request:** handleMcp receives a request and ToolContext → createToolServer registers tools against the Core store → A fresh stateless transport handles the request → The server closes after the request

## Key files

- packages/agent/src/assistant.ts — orchestrates chat turns, wakeups, episodes, and conversation brain sessions
- packages/agent/src/brain.ts — selects and runs the chosen agent harness through yagami
- packages/agent/src/tools.ts — defines Midna's MCP tools and their episode context
- packages/agent/src/prompt.ts — builds system and wakeup prompts
- packages/agent/src/mcp.ts — handles an MCP request with a fresh episode-bound server
- packages/agent/src/check.ts — checks that the selected brain can complete a real turn and reports sign-in failures
- packages/agent/src/index.ts — exports the layer's public API

## Rules and traps

- Bind tool calls to the correct episode ID so they appear under the right audit entry.
- Use the store's timezone when converting model-facing local times; the store uses epoch milliseconds.
- A wakeup reaches the user only through message_user.
- A chat brain session restarts after four idle hours or 40 turns.
- Brain mode controls permissions: autonomous allows tools to run; ask restricts host actions.
- Preserve authentication failure details from yagami so the user can be told how to sign in.

## What it talks to

- Core — supplies the store, settings, planning data, context, episodes, and time helpers
- Daemon — invokes Assistant and serves its MCP handler
- Runtime — yagami runs the selected agent CLI and connects it to MCP tools
