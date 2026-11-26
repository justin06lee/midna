# The ledger (King of Greed)

midna can keep the user's money: where [King of Greed](https://github.com/justin06lee/king-of-greed)'s CLI, `kog`, is installed and set up on midna's host, midna's brain gets the ledger as tools and is told how to use them. On a host without `kog`, nothing of it exists: no tools, no word in the prompt.

midna holds no money data itself. The entries, budgets, riba, purification and zakat are King of Greed's (a Firefly III server, or a file on the host); midna only hands its brain `kog`'s own tools.

## When it is on

`~/.local/bin/kog` exists and `kog status` exits 0 (it has been through `kog init` and the ledger answers). midna asks at startup and before a turn:

- once `kog status` has said yes, the ledger stays on while the CLI is installed, so the prompt and the tools don't flip when the ledger's server is slow for a moment (a call then fails and says why);
- a no is asked again after a minute, so a ledger set up while midna runs is found without a restart. The log says so once: `[midna] ledger: King of Greed, through /home/…/.local/bin/kog`.

`kog` is a script that runs on bun, so bun has to be on the PATH midna's service runs with (it is: the service takes the login shell's PATH when it is installed).

## How the brain gets it

A second MCP server named `kog`, beside `midna`:

- **Claude Code** starts `kog mcp` itself, over stdio, and stops it with the turn.
- **The other harnesses** (Codex, OpenCode, Gemini and the rest, through yagami) take only HTTP servers. For them the daemon answers at `/mcp-kog`, behind the same per-run token as midna's own tools: each request starts `kog mcp`, passes the list or the call through, and stops it.
- **Hermes** keeps its own tools and gets neither.

In ask mode the ledger's tools pass like midna's own: it is the user's book, kept at their word.

What midna records is tagged by `kog` with the name it was set up under (`kog init --name midna`).

## What the prompt says

A "Money" section, only when the ledger is on: log spending the user mentions without being asked ("5,600원 starbucks"), answer "how much did I spend on X" from the ledger, check budgets, track riba, purification and zakat; never invent an entry or guess an amount; and in the morning brief and the evening review, one line on the month's spending against the budgets, only when there is something worth saying.

## Code

- `packages/agent/src/ledger.ts`: `ledgerWatch` (is it set up) and `handleLedgerMcp` (the HTTP bridge).
- `packages/agent/src/brain.ts`: the `kog` server in both brain paths (`BrainRun.ledger`).
- `packages/agent/src/prompt.ts`: `LEDGER_GUIDE`.
- `packages/daemon/src/server.ts`: `/mcp-kog`. `startDaemon({ ledger })` names another CLI, or `null` for none (the default when a brain is injected, as in tests).
- Tests: `packages/agent/test/ledger.test.ts`, `packages/daemon/test/ledger.test.ts`, against the stand-in `packages/agent/test/fake-kog.ts`.
