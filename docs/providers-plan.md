# Providers: Claude, Codex, and falling back when Claude is capped

*A plan, written 2026-10-26 against 0.11.3. Nothing here is built yet. Which option to take, and the settings in it, is Justin's call.*

Justin wants midna to think with either Claude (his Claude subscription, through Claude Code) or his $20 ChatGPT plan (through the Codex CLI). When Claude's usage limit is reached, midna should carry on with Codex on its own.

## How a turn runs today

- **One process per turn.** Each chat turn and each wakeup is one agent session, started by `yagamiBrain` in `packages/agent/src/brain.ts` through yagami, the library that runs agent CLIs. The model comes from the `model` setting, a yagami model ref such as `claude:opus` (the default) or `codex:<model>`.
- **Two paths.** `claude:…` runs a Claude Code session (`runClaude`). Any other provider (`codex`, `gemini`, any ACP agent) runs through yagami's provider-neutral session (`runHarness`). For Codex that is `codex app-server`, the engine the Codex terminal app runs on.
- **What both paths get:** midna's system prompt; midna's tools over MCP (HTTP, with a bearer token bound to the episode); the conversation's saved session to resume; ask or autonomous mode; interrupts; tool activity for the app's "working" line; and token counts at the end.
- **Sessions per conversation.** The conversation row keeps `brain_model` and `brain_session`. A turn resumes that session unless it is stale: older than 4 idle hours, past 40 turns, or saved under a different model. A fresh session gets the last 20 messages and the full state note instead (`chatTurn` in `assistant.ts`).
- **Brain trouble.** When the CLI is signed out or missing (`brainProblem` in `check.ts`), wakeups are held and retried, and the user hears about it at most every few hours. Any other failure ends the turn: the chat says "I couldn't finish that — …" and the wakeup is marked failed.

### Switching by hand already works

`midna model codex` (or `codex:<model>`), or the model field in the desktop app's Settings, switches the brain today. The daemon checks that the provider is installed (`checkModel`). The next turn of each conversation starts a fresh Codex session with the last 20 messages, because `brain_model` no longer matches. Switching back works the same way.

What's missing:
- Codex isn't installed and signed in on the Jetson, as far as I know. It is on this Mac (codex-cli 0.164.0). I couldn't reach tenet to check there.
- Nobody has run midna on Codex end to end.
- Nothing switches automatically.

### What happens today when Claude is capped

As far as the code goes (I haven't reproduced it): Claude Code ends the turn with an error result whose text says the limit is reached and when it resets. `runClaude` turns that into `BrainError("claude turn failed: …")`. `brainProblem` doesn't recognise it as brain trouble, so:
- **Chats:** the user gets "I couldn't finish that — claude turn failed: …" for every message until the reset.
- **Wakeups:** a due wakeup that needs the brain is marked failed and is not retried. Rituals, follow-ups, job reports and inbound events in those hours are lost.

The second point is a bug whichever option is chosen; see "Do this whatever the choice" below.

## How a cap can be detected

- **Claude** says it in typed form, so midna needn't match message text. Claude Code streams a `rate_limit_event` whose `rate_limit_info` has a `status` (`allowed`, `allowed_warning`, `rejected`), `resetsAt`, `rateLimitType` (`five_hour`, `seven_day`, …) and `utilization`. An assistant message that failed on the limit also carries `error: "rate_limit"`. yagami passes these SDK messages through to `runClaude` unchanged, and midna ignores them today.
- **Codex** reports a capped turn as a failed turn with an error message. yagami keeps only that message, as a `ProviderError`. To tell a cap from a crash without matching text, yagami would need a typed `UsageLimitError` (with the reset time where Codex gives one). Codex's app-server also has account rate-limit notifications; yagami doesn't read them yet, and I haven't checked their shape.
- `allowed_warning` and `utilization` also make an early switch possible, before the cap is hit (option C).

## What changes on Codex

What I found reading `brain.ts` and yagami's Codex session (`../yagami/src/core/providers/codexSession.ts`). None of it has been run yet.

| Feature | On Codex | Work needed |
|---|---|---|
| midna's tools (MCP over HTTP, bearer header) | Supported: yagami adds them as `mcp_servers.midna` with `http_headers`. | None. |
| **Long tool calls** (a `device_shell` waiting up to 2 min for the user's yes, then running up to 10 min) | **Breaks.** Codex times out an MCP tool call after its default `tool_timeout_sec` (60 s). For Claude, midna raises this to 15 min. yagami rebuilds the `midna` server entry from the spec, so midna can't pass the timeout through `native.config`. | Small yagami change: a per-server tool timeout in `McpServerSpec`, written as `tool_timeout_sec`. Then set it in `runHarness`. |
| Resuming a session | Works (`thread/resume`). A failed resume throws rather than starting an empty thread, and midna then starts fresh with history, as for Claude. | None. |
| Crossing providers | Sessions don't carry over. The new brain sees the last 20 messages, memory, plans and the state note, but not what the old session did in its tool calls. | None. This is how a model change already behaves. |
| System prompt | Sent as Codex `developerInstructions`. | Wording: the prompt names `run_in_background`, subagents and `claude -p`, which are Claude Code terms. Make that paragraph provider-neutral. |
| Autonomous mode | `sandbox: danger-full-access`, `approvalPolicy: never`: the same run of the host Claude gets. | None. |
| Ask mode | Reads, searches, fetches and midna's own tools pass; everything else is denied. Codex labels many shell reads (`cat`, `ls`) as commands, so ask mode is stricter on Codex than on Claude. | Acceptable as is; tune later if it gets in the way. |
| Interrupts (the user's next message) | Works (`turn/interrupt`). Claude Code's background-notice quirk doesn't exist on Codex. | None. |
| Pictures and files the user sends | midna puts them in the workspace and names their paths in the prompt; the brain opens them with its own tools. Codex has an image-view tool. | Test it. |
| Cost and spend | Codex reports tokens but no dollars, and a ChatGPT plan has no per-turn price anyway. Codex turns count as $0 in `midna status` spend and the app's spend lines. | Show Codex turns as tokens, or label them "on the ChatGPT plan". |
| Prompt cache | Codex caches on its own (it reports cached input tokens). midna's byte-stable system prompt helps there too. | None. |
| `job_start` with a `prompt` | **Always `claude -p`** (`packages/daemon/src/jobs.ts`), so it is capped when Claude is. | Either run `codex exec` for prompt jobs while on Codex, or refuse them with a clear reason until Claude is back. |
| Sign-in check (`midna doctor --live`, the app's brain banner) | Works for any provider: it runs one tiny real turn and reads yagami's sign-in and missing-CLI errors. | None. |
| Web search | Codex has its own web search tool, which may need turning on in `~/.codex/config.toml`. | Check on the Jetson. |
| Codex's own limits | The $20 plan has its own 5-hour and weekly limits, smaller than Claude's. A busy day can cap it too. | Both capped: wakeups wait for the earlier reset and chats say when (options B and C). |

Setting Codex up on the Jetson (Justin, about 5 minutes): install the Codex CLI for the `midna` service user, sign in with his ChatGPT account (`codex login`; the Jetson has no browser, so use Codex's device-code sign-in or copy `~/.codex/auth.json` from a machine that has signed in), then run `midna doctor --live codex`.

The ChatGPT plan can't be reached any other way: the OpenAI API is billed separately and the $20 plan doesn't include API credit. So an option built on the OpenAI API with midna's own agent loop is out. It would cost extra money, and midna would also lose the CLI's tool loop.

## The options

### A. Manual switch, made to work properly

Keep switching by hand (`midna model codex`, desktop Settings), and make Codex a brain midna can live on:
- the yagami tool-timeout change, and set it in `runHarness`;
- provider-neutral wording in the system prompt;
- prompt jobs on Codex use `codex exec`, or are refused while on Codex;
- spend shows Codex turns honestly;
- one end-to-end run on a throwaway daemon on tenet: chat, a wakeup, an interrupt, a device command waiting for approval, a picture, ask mode;
- Codex installed and signed in on the Jetson.

**What breaks:** nothing new. But someone has to notice the cap, switch by hand, and switch back after the reset. midna can't do it itself, since a capped brain can't think.
**Effort:** about half a day of work, plus Justin's sign-in on the Jetson.

### B. Automatic fallback on the cap (recommended)

A, plus:
- **Settings:** `model` stays the primary. A new `fallback` setting (say `["codex"]`, or none) names what to use when it's capped. Set it with `midna model claude:opus --fallback codex` or in desktop Settings. The default is no fallback, so nothing changes until it's set.
- **Detection:** `runClaude` reads `rate_limit_event` and `error: "rate_limit"` and throws a typed capped error with `resetsAt`. On Codex, the typed yagami error does the same. No message text is matched.
- **On a cap:** the daemon records "claude capped until 4:00 pm" in state and runs the same turn again on the fallback at once. That is a fresh session with the last 20 messages, the path a model change already takes. The user hears it once, in the reply: "Claude's limit is reached until 4 pm; I'm on Codex till then."
- **Switching back:** the first turn after `resetsAt` goes to the primary again, and each conversation starts a fresh Claude session with the last 20 messages. There's no polling.
- **Both capped:** wakeups wait for the earlier reset (like signed-out brain trouble today), and chats say when midna can answer.
- **Visibility:** each episode records the model it actually ran on. `midna status` and the apps show "on codex until 4:00 pm".
- **Tests:** a scripted brain that caps, in the existing daemon e2e style.

**What breaks:** the switch drops the in-flight session's tool context in both directions, as a manual switch does. A turn that hits the cap mid-way, after some tool calls, is rerun from the start on Codex. That can repeat an action the Claude turn already took, such as sending a message. Most caps land on the first call of a turn, which is safe to rerun. For the mid-turn case, B passes the fallback a note: "your previous brain was cut off mid-turn; check before you redo anything".
**Effort:** about 2 days on top of A. That covers the yagami typed error, the brain and assistant changes, the setting in protocol, core, CLI and desktop Settings, the status line, tests, and a doc.

### C. Route by kind of work, plus fallback

B, plus a per-kind model: chats on Claude, background wakeups on Codex (or on Claude Haiku). Optionally, switch background work to the fallback early, once Claude reports `allowed_warning` or `utilization` above a threshold, so the last of Claude's allowance goes to Justin's chats.

**What breaks:** the same as B. Wakeups also never share a session with chats, which is already true today. Background work on Codex will read and act a little differently from chat.
**Effort:** about 1 more day on top of B. This overlaps item 4, "a cheaper model for wakeups", which is on hold for Justin. C settles both at once if he wants that.

## Recommendation

**B, built in two steps.**
1. **First A,** plus the bug fix below. This is useful alone: Codex becomes a brain midna can actually run on, and a cap no longer loses wakeups.
2. **Then the automatic fallback.**

I'd leave C for later. B's `fallback` setting can grow into per-kind models later without being reworked, and item 4 is still Justin's to decide.

## Do this whatever the choice

Treat a usage cap as brain trouble, not as a failed turn. Due wakeups are held until `resetsAt` instead of being marked failed, and the chat says "Claude's limit is reached until 4 pm" instead of "claude turn failed: …". This is about half a day, and it fixes what happens today when Claude is capped.

## What Justin decides

1. **Which option:** A, B or C.
2. **The order:** Claude primary and Codex fallback, and which Codex model. Plain `codex` uses Codex's default.
3. **When to fall back:** only when capped, or early at a threshold for background work (C).
4. **Switching back:** automatic at the reset (recommended), or stay on the fallback until he switches.
5. **Prompt jobs while on Codex:** run them with `codex exec`, or refuse them until Claude is back.
6. **Codex sign-in on the Jetson** with his ChatGPT account, and Codex getting full access to the host in autonomous mode, the same as Claude has today.
