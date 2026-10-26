# Claude, Codex, and falling back when one is capped

midna thinks with one model at a time: the `model` setting, a yagami model ref such as `claude:opus` (the default), `codex` or `codex:<model>`. The `fallback` setting is an ordered list of models to think with while the main one's provider is at its usage limit. With it, midna keeps working through a Claude cap on Justin's ChatGPT plan (Codex) and goes back to Claude when the limit resets.

This is option B of [providers-plan.md](providers-plan.md), built for 0.12.

## Turning it on

```sh
midna model claude:opus --fallback codex   # think with Claude; Codex while Claude is capped
midna model --fallback none                # no fallback: wait for the reset
midna status                               # the model, its fallbacks, which is thinking now, and any caps
```

The desktop app's Settings has a fallback field under the model, and `PATCH /v1/settings` takes `{ "fallback": ["codex"] }`. midna checks each fallback is installed on the host, as it does the model.

## What happens at a cap

- **Detecting it.** Claude Code reports a usage limit as a rate-limit event or a `rate_limit` error with the time it resets. A Codex turn on a used-up plan fails with yagami's `UsageLimitError` (code `usage_limit`), which carries the reset time Codex reports. midna keeps each capped provider and its reset time in its state (`brainCaps`). It survives a restart. When a provider gives no reset time, midna holds it for 15 minutes and tries again.
- **With a fallback.** The turn that hit the cap runs again at once on the first fallback whose provider isn't capped. It starts a fresh session with the conversation's recent messages, memory and the state note. It is told which of midna's tools the cut-off turn had already used, so it checks before doing any of them twice. The user gets one notice per cap, for example "Claude's usage limit is reached until 4:00 pm; I'm thinking with codex till then."
- **Back at the reset.** Once the reset time passes, the main model thinks again. The next turn of each conversation starts a fresh Claude session, because a session saved under another model is never resumed.
- **With every model capped**, or no fallback:
  - A chat gets a reply saying when midna will answer, and midna answers a minute after the first reset.
  - Wakeups wait until then instead of failing, so nothing scheduled is lost.
  - The brain check doesn't spend what's left of a limit.
- **Background jobs.** A `job_start` with a prompt runs `codex exec` while midna thinks with Codex, and `claude -p` otherwise. A job that names a model whose provider is capped runs on the model thinking now.
- **Long tool calls.** Under Codex, midna's tools get 15 minutes per call, as under Claude, not Codex's 60-second default. A `device_shell` that waits for the user's yes would otherwise time out.
- **Spend.** A ChatGPT plan has no price per turn. Codex turns count as turns with no price (`SpendDay.unpriced`), and `midna status` says how many of today's had none.

## Setting up Codex on the Jetson (Justin, about 5 minutes)

Do this as the user midna's service runs as (the one whose `systemctl --user` runs `midna.service`):

1. Install the Codex CLI: `bun add -g @openai/codex`. It lands in `~/.bun/bin`, which is already on the service's PATH. No reinstall of midna needed.
2. Sign in with the ChatGPT account. The Jetson has no browser, so use `codex login --device-auth`: it prints a code and a link to open on your phone. Or copy `~/.codex/auth.json` from a machine that is signed in.
3. Check it: `midna doctor --live codex` runs one tiny real turn and should end with `codex answers.`
4. Turn on the fallback: `midna model claude:opus --fallback codex`.

Codex's own web search may need turning on in `~/.codex/config.toml`; check it on the Jetson.

## Releasing it

midna takes yagami from the sibling checkout (`file:../../../yagami`). The release has to be built against yagami `5363b44` or later, which adds `UsageLimitError` and the per-server tool timeout. Without it, a capped Codex turn looks like an ordinary failure and long tool calls time out after 60 seconds.

## Not tested yet

- No live Codex turn through midna: Codex isn't signed in where midna runs, and the Mac's Codex wasn't used, so as not to spend Justin's ChatGPT plan.
- No real capped stream from either provider has been seen. The tests feed midna made-up caps. Claude's `resetsAt` is taken to be in seconds; midna also reads milliseconds.
- On Codex, ask mode is stricter than on Claude, because Codex labels shell reads such as `cat` as commands. Pictures the user sends rely on Codex's own image viewer. Neither has been tried.
- The desktop app's fallback field hasn't been looked at in a running app.
