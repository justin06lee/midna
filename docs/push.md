# Push notifications

midna sends the iPhone app a push notification for each **alert**: reminders, questions and cards (`ask_user`), and urgent or normal notifications (`message_user`). These are the same items Telegram's alerts mode carries (`isAlert` in `packages/protocol`). Chat replies and anything fyi stay in the app.

## Where alerts go: `midna alerts`

| Setting | Push | Telegram |
| --- | --- | --- |
| `both` (default) | every alert, to each registered phone | every alert, as before |
| `push` | every alert | only the alerts no push carried: no APNs key, no phone registered, or Apple refused it |
| `telegram` | none | every alert |

`both` is the default so Telegram stays exactly as it was while push proves itself. Once it has, `midna alerts push` makes Telegram the fallback. Telegram's own mode (full or alerts) still decides whether it gets chat replies; the setting above is only about alerts.

How the fallback works: the daemon pushes each alert as it is released and records the outcome (`push_sends`, migration 12). Before sending an alert, the Telegram bridge asks `GET /v1/outbox/:id/delivery?wait=12000`. Under `push`, the daemon holds that answer until Apple has replied (at most 15 s), then says whether bridges should send it. An older host, an error or a timeout means Telegram sends it. A push still pending after a restart counts as failed.

## Turning it on at the host

1. **The APNs key.** A `.p8` key from the developer site's Keys page, with Apple Push Notifications service, for Sandbox & Production. Copy it to the host as the user midna runs as, beside its database, private:
   - Jetson (systemd): `~/.local/share/midna/AuthKey_<KEYID>.p8`, `chmod 600`.
   - Mac: `~/Library/Application Support/midna/AuthKey_<KEYID>.p8`.
   - Never into a repo, a log or CI.
2. **config.json** in the same folder:
   ```json
   "push": { "apns": { "keyId": "<KEYID>", "teamId": "65UN46K6FA" } }
   ```
   `keyFile` names another path; `bundleId` defaults to `sh.midna.mobile`.
3. **Restart midna** (`midna service restart`): the key is read at start. Its log says `push  0 phone(s), alerts: both`; a missing or broken key is logged and push stays off. Nothing else stops.
4. **Open the app on the phone** and allow notifications. It registers its token on every launch and return to the foreground. `midna status` then shows `alerts  push and Telegram · 1 phone for push`, and the app's Settings shows Notifications: On.
5. **When push has proven itself:** `midna alerts push`.

## Details

- **Apple:** token-based auth (ES256 JWT, reused for 40 min), HTTP/2 to `api.push.apple.com`, or `api.sandbox.push.apple.com` for a build run from Xcode. A token Apple calls `BadDeviceToken` is tried once in the other environment, and the one that works is kept. `Unregistered` (410) drops it.
- **A token belongs to the pairing** that registered it (`push_tokens`, migration 12). Revoking the pairing stops its pushes. The host's own token can't register a phone.
- **The notification:** midna's name as title; the text (cut at 1,200 characters), a question's choices, and the name of a file sent with it. Urgent ones start with ❗ and are time-sensitive. Pushes for the same item collapse into one. While the app is open the chat shows the item, so no banner appears, and opening the app clears what was delivered.
- **Not yet:** answering a question from the notification itself, and pushes for chat replies while the app is closed.
