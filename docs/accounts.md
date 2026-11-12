# Two Claude accounts

Justin has two Claude accounts, set up on each machine as the `claude-as` helper (`~/.local/bin/claude-as`) has them:

- **work**, the company's: Claude Code's default config, `~/.claude` with `~/.claude.json`.
- **personal**: `CLAUDE_CONFIG_DIR=~/.claude-personal`.

Each is signed in separately on every machine (`claude-as personal`, then `/login`). midna never copies credentials between them.

## Which account runs what

Every Claude Code process midna starts runs as one account: the brain's turns, prompt jobs, and the live brain check (`midna doctor --live`, the brain check in the apps). Work runs with `CLAUDE_CONFIG_DIR` unset, even if midna itself was started with one; personal runs with it set.

- **The brain** thinks as the `account` setting's account, work unless set:

  ```sh
  midna account                 # the account, who each is signed in as, any caps
  midna account personal        # think as the personal account from the next turn
  midna account work
  ```

  `PATCH /v1/settings` takes `{ "account": "personal" }`. A conversation's Claude session lives in its account's config, so the next turn after a switch starts a fresh session with the recent messages, as a model change does.
- **A prompt job** runs as the account `job_start` names (`account: "work" | "personal"`), or the setting's. Naming an account runs the job on Claude even while midna thinks with Codex. Its command line shows which: `CLAUDE_CONFIG_DIR='…/.claude-personal' claude -p …`, or `env -u CLAUDE_CONFIG_DIR claude -p …` for work.

## Account fallback (off by default)

`accountFallback` decides whether an account at its usage limit hands over to the other one:

```sh
midna account --fallback on   # or off
```

- **Off (the default).** A capped account never moves to the other account. The brain goes on to the `fallback` models (Codex, say), or waits for the reset as before. A prompt job for a capped account is refused with when it resets, so midna can tell the user; it still runs on the other account if the user asks for it by name.
- **On.** The brain carries on with the same model on the other account, then the `fallback` models. A prompt job for a capped account runs on the other one. This works in both directions, work to personal and personal to work.

Off is the default because one account's work spending the other's usage should be the user's choice. A plain on/off switch keeps it simple; the rule "personal may fall back to work only for work tasks" would need midna to know which tasks are work, which it doesn't.

midna only learns of a cap when Claude Code reports one. An account with paid extra usage turned on doesn't report a cap at its plan's limit: it keeps going and bills. Keep extra usage off on both accounts in Claude's settings.

## Usage, per account

Caps are kept per account (`claude@work`, `claude@personal` in `brainCaps` and in `Status.caps`). Each Claude turn records its account (`episodes.account`), and `Status.spend[].byAccount` breaks Claude's spend down by it. `midna status` prints it:

```
  claude    today work $1.20 (8) · personal $0.40 (2); 7 days work $9.10 (61) · personal $0.40 (2)
```

Prompt jobs aren't in the spend: `claude -p` with text output doesn't report a cost.
