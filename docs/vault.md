# The vault

midna's apps show the logins in [ghostly](https://github.com/justin06lee/ghostly)'s vault — the
Vaultwarden on midna's host — and Hermes can find one by its title. Everything goes through
Bitwarden's own CLI (`bw`): midna does no crypto of its own.

## Where it comes from

The daemon opens the vault with midna's account there, as ghostly's install on the host lays it out:

| | default | `config.json` → `"vault"` |
|---|---|---|
| server | `https://localhost:8222` | `server` |
| account | `midna@ghostly.local` | `email` |
| master password | `<midna home>/secrets/ghostly_midna` (one line, mode 600) | `passwordFile` |
| certificate | `~/.local/share/ghostly/tls/ca.crt` when it exists | `caCert` |
| Bitwarden CLI | `bw` on Node 22+, else on bun (`~/.bun/bin`, `~/.local/bin`, `PATH`) | `bw` (argv) |
| new logins go to | the `midna` collection, when midna's account can see it (so your own Bitwarden apps see them too); otherwise midna's own vault | `collection` |

With no password file or no `bw`, there is no vault: the apps say so, and nothing else changes.
midna keeps its own `bw` state in `<midna home>/vault`, apart from the `ghostly` CLI's, and locks
it after 15 minutes unused. The first call after that logs in or unlocks and syncs: some seconds.

## Secrets

- A new or changed login goes to `bw create|edit` encoded on **stdin**; a password comes back on
  `bw`'s **stdout**. The master password is read by `bw` from its file (`--passwordfile`). The
  session key lives in the daemon's memory and `bw`'s environment. None is ever in argv, on disk or
  in a log: the log says which login, never what is in it (`[midna] vault: iPhone was shown the
  password of "GitHub"`).
- The API never lists a password. `POST /v1/vault/:id/password` returns one, in a response body
  (`cache-control: no-store`), to the user's own devices only (desktop, phone, CLI): a bridge
  (Telegram, Hermes) or midna's host gets 403.
- In the apps a password being typed stays in memory; the other fields keep their drafts like
  every field. Show and Copy fetch the saved password only when asked (behind Face ID on the
  phone); a copied password leaves the clipboard after 30 s if it is still the one there.

## API

```
GET    /v1/vault[?q=]            logins: id, title, username, url, shared, updatedAt
POST   /v1/vault                 { title, password, username?, url? }
PATCH  /v1/vault/:id             { title?, username?, url?, password? } — only what changes
DELETE /v1/vault/:id             to the trash (Bitwarden can restore it)
POST   /v1/vault/:id/password    { password }
```

`MidnaClient`: `vault()`, `addToVault()`, `editVault()`, `removeFromVault()`, `vaultPassword()`.

## Hermes

`midna hermes setup` (also run by `midna host install` and `make update`) adds an MCP server to
Hermes's config, as Hermes's user, and restarts its gateway only when that changed:

```yaml
mcp_servers:
  midna-vault:
    url: http://127.0.0.1:7717/v1/vault/mcp
    headers: { Authorization: "Bearer ${MIDNA_APP_TOKEN}" }   # Hermes's own pairing, from its .env
    trust: untrusted
```

- `vault_find {title}` — read-only, so it runs on its own: the exact title first, then titles that
  hold it, then a username or website. Title, username, website and id; never a password.
- `vault_password {login}` — not read-only, so Hermes asks you first (its approval buttons, or
  midna's approval card during a turn midna gave it). It returns the password itself. A login marked
  "master password re-prompt" in Bitwarden is never handed out.

Only the device paired as Hermes may call `/v1/vault/mcp`.
