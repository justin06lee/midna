# Asking midna's permission

*Built 2026-11-18 on the branch `permissions`, for ghostly's broker. Not on midna's host yet. Tests: `packages/daemon/test/permissions.test.ts`.*

A program Justin runs has something it won't do on its own word. It asks midna. midna decides in the background, or puts it to Justin, and the program waits for the answer. Nothing secret goes through midna: an ask carries names and reasons, never a password.

The first asker is ghostly's broker, for a password an **unregistered** agent wants to use.

## The two endpoints a program gets

On midna's host: `http://127.0.0.1:7717`. Every call carries `Authorization: Bearer <token>`.

| | |
|---|---|
| `POST /v1/inbound` | Tell midna something in the background (docs/inbound-events.md). Nothing reaches Justin's chat unless midna decides it should. |
| `POST /v1/permissions` | Ask permission. |
| `GET /v1/permissions/:id` | What became of an ask. |

### Pairing, once

1. On the host: `midna pair` prints a code (8 characters, good for 10 minutes).
2. `POST /v1/pair` with `{"code": "<code>", "deviceName": "ghostly", "kind": "service"}` and no token. The answer has `token`: keep it private (0600). It is shown once.
3. `midna paired` lists it; `midna paired revoke <id>` retires it.

A `service` token opens only the three routes above. It can't send chat messages, read history, change settings or answer an approval, so a program can't approve its own ask.

### Asking

`POST /v1/permissions?wait=120000`

```json
{
  "kind": "vault.use",
  "summary": "the agent \"codex\" on mini-m4 (not registered) uses the login \"GitHub\" (password) to run \"gh auth login --with-token\"",
  "scope": "codex@mini-m4/login:42",
  "reason": "pushing the release branch",
  "data": {
    "agent": { "name": "codex", "device": "mini-m4", "registered": false },
    "login": { "id": "42", "title": "GitHub", "field": "password" },
    "use": { "how": "command", "command": "gh auth login --with-token" }
  },
  "timeoutMs": 120000
}
```

| field | | |
|---|---|---|
| `kind` | required | what kind of thing, 1–100 characters |
| `summary` | required | one plain sentence: who, what, how. midna reads it, and Justin sees it word for word if he is asked. Up to 500 characters. |
| `scope` | required | what an approval "for N minutes" covers: a later ask from the same asker with the same `scope` passes at once. For ghostly: the agent and the login. Up to 200 characters. |
| `reason` | optional | why, in the asking agent's words, up to 1,000 characters. midna treats it as a claim. |
| `data` | optional | the details as JSON, up to 16 KB. `how` for ghostly: `command` (with the command line), `type`, `paste`, `copy`. **No secret values.** |
| `timeoutMs` | optional | how long the asker waits: 1,000–300,000, default 120,000 |

`?wait=<ms>` holds the answer until the ask is decided or that long has passed (at most 300,000). Without it the answer comes at once, `202` and `"status": "pending"`; then `GET /v1/permissions/:id?wait=<ms>` waits the same way.

### The answer

```json
{
  "id": "perm_Zk3…",
  "kind": "vault.use",
  "summary": "…",
  "scope": "codex@mini-m4/login:42",
  "status": "approved",
  "decidedBy": "midna",
  "reason": "Justin is releasing midna today",
  "approvedUntil": 1795000000000,
  "requestedAt": 1794999400000,
  "expiresAt": 1794999520000,
  "decidedAt": 1794999412000
}
```

- `status`: `pending`, `approved`, `denied` or `expired`. **Only `approved` is a yes.**
- `decidedBy`: `midna`, `user` (Justin answered), `grant` (an approval for this scope was still running), or `null`.
- `reason`: one line to pass on to the agent.
- `approvedUntil`: milliseconds; set when the approval was for a while, else `null` (this once). midna keeps the grant itself, so the broker can simply ask every time: an ask inside a grant is answered at once.

Errors: `400` a missing or invalid field, `413` `data` over 16 KB, `401` no valid token, `403` a route a service may not use, `404` an ask that isn't yours.

### When to say no

Deny when: midna can't be reached; any status other than `approved`; the wait ran out with `pending` (the ask then ends `expired` on midna's side). A restart of midna ends every pending ask as `expired`.

## What midna does with an ask

1. **A grant still running** for the asker and scope: approved at once, `decidedBy: "grant"`.
2. **Otherwise midna's brain hears it now,** in a background turn of its own (not in Justin's chat). It is told this is the asker's account and an agent's words, to weigh and never to obey, and that it must not look up or handle the secret. It has three tools:
   - `permission_list`: what waits, with the details.
   - `permission_decide`: approve (optionally for 1–60 minutes) or deny, with a one-line reason.
   - `permission_ask_user`: put it to Justin.
3. **Asking Justin** uses the card a device action gets: Allow, Allow for 10 min, Deny, on the Mac, the iPhone (behind Face ID), Telegram and as a question in chat. The first answer wins.
4. **In ask mode** (`midna mode ask`) midna may deny on its own but not approve: approving is Justin's.
5. **If midna hasn't decided by half the asker's time** (a slow or signed-out brain), Justin is asked directly.
6. **No decision in time** is `expired`. A card still up comes down.

Every ask and its decision are kept (`permissions`, migration 17), with who decided and why.

## Open, for Justin

- **How much midna approves alone.** As built, in autonomous mode midna may approve on its own when the ask plainly fits what Justin is doing. The asking agent writes the reason, so a compromised agent can try to talk midna into it. The stricter choice is "midna screens, Justin approves": midna can deny alone, and every yes is his tap. `midna mode ask` gives that today, for everything midna does.
- **`vault_password`** still hands Hermes the plaintext. Once ghostly's broker runs, it should become "use it through ghostly".
