# Push notifications

midna sends the iPhone app a push notification for each **alert**: reminders, questions and cards (`ask_user`), and urgent or normal notifications (`message_user`). These are the same items Telegram's alerts mode carries (`isAlert` in `packages/protocol`). It also pushes each **chat reply when the user last wrote from the phone** (`wantsPush` in `packages/daemon/src/push.ts`): the app is usually closed by the time a reply comes. A reply to what was said on the desktop, Telegram or the CLI arrives there, not on the phone. Anything fyi stays in the app. The Mac app's own notifications are in [desktop-notifications.md](desktop-notifications.md).

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
- **The notification:** midna's name as title; the text (cut at 1,200 characters), a question's choices, and the name of a file sent with it, with the default sound. Urgent alerts start with ❗. Urgent alerts and replies are **time-sensitive**: they break through a Focus that allows time-sensitive notifications and skip the scheduled summary. That needs the app's `com.apple.developer.usernotifications.time-sensitive` entitlement (`app.json`, from build 8). Without it iOS treats them as ordinary. Pushes for the same item collapse into one. While the app is open the chat shows the item, so no banner appears, and opening the app clears what was delivered.
- **The badge** counts the pushes since the phone last asked midna for anything (`devices.last_seen_at`). The app makes a request as it goes to the background, so what was read in the app isn't counted, and it sets the badge to 0 when opened.
- **On the phone:** Settings → Notifications → midna: Allow, Sounds, Badges and Time Sensitive Notifications on. To get replies during a Focus, either keep that Focus's "Time Sensitive Notifications" on (Settings → Focus → the Focus → Apps), or add midna to its allowed apps.
- **Not yet:** answering a question from the notification itself.

## Turning on time-sensitive (once, before build 8)

The App Store profile holds only the capabilities the app id had when the profile was made. `scripts/testflight.sh` checks it against `app.json`. If an entitlement is missing, it runs `scripts/profile.ts`, which turns the capability on through the App Store Connect API, makes the profile again and installs it, then checks once more. To do it by hand instead: developer site → Identifiers → `sh.midna.mobile` → tick **Time Sensitive Notifications** → Save. Then Profiles → "midna App Store" → Edit → Save → Download, and open the file to install it.

## When notifications don't land

1. `midna status` on the host: `alerts  push and Telegram · 1 phone for push`. "no APNs key" or 0 phones means the host never pushes. The host's log says why for each push that failed (`push: outbox #N reached no phone (…)`).
2. The app's Settings → Notifications should say On. "Failed" means the host didn't take the token.
3. TestFlight builds use the production APNs host. The app says so when it registers. If a token is sent with the wrong environment, Apple answers `BadDeviceToken`; midna then tries the other host once and keeps the one that works.
4. The phone itself: Settings → Notifications → midna, and Settings → Focus (above).
