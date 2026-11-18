# Notifications on the Mac

The desktop app tells you when midna says something and you aren't looking at its window: a chat reply, a reminder, a question. Each comes as a system notification with a sound, the Dock icon counts what you haven't seen, and a click opens the chat. From 0.13.3.

## What you get

| midna sends | Banner | Sound | Counts in the Dock badge |
| --- | --- | --- | --- |
| A chat reply, a reminder, a question, anything normal or urgent | yes | yes | yes |
| Something fyi | no (it goes to Notification Center) | no | yes |
| Anything that arrives more than 10 minutes late (the Mac slept, the app was closed) | no | no | yes |
| Anything, while the midna window is the one in front | no | no | no |

- **The words** are midna's text without its markdown, a question's choices on a second line, and the name of a file sent with it. Urgent ones start with ❗.
- **A click** brings the window forward on the chat.
- **Looking at the window** clears the badge and removes midna's notifications from Notification Center.
- **Every Mac that runs the app** notifies, whichever device you wrote from. The phone only rings for replies to what you wrote on the phone (docs/push.md).

## Turning them on

macOS asks once, the first time the app runs paired with a midna. If that prompt was missed or refused:

- The app shows "Notifications are off on this computer" above the chat, with **Turn on**.
- Settings → This computer → **Notifications** shows On or Off, with **Turn on**, or **Send a test** when they are on.
- Turn on asks again if macOS never got an answer. If they were refused, it opens System Settings → Notifications → midna: switch **Allow notifications** on, and pick **Banners** or **Alerts** (Alerts stay until dismissed).

## Focus

A Focus (Do Not Disturb, Work, Sleep) holds midna's notifications back like any other app's. To let them through: System Settings → Focus → the Focus → Allowed Notifications → Apps → add **midna**.

Replies and urgent alerts are already marked time-sensitive, but macOS only honours that for an app with the `com.apple.developer.usernotifications.time-sensitive` entitlement, which a Developer ID app gets from a provisioning profile. That isn't set up yet; until then macOS treats them as ordinary. See "Not yet" below.

## How it works

- `clients/desktop/src-tauri/src/notify.rs` holds its own stream of midna's events (`GET /v1/events`), apart from the window's. So notifications arrive with the window closed to the tray, and at login before the window was ever shown.
- Its place in the stream is kept per pairing in `notify.json`, in the app's config folder. A restart neither repeats a notification nor misses a line: what came while the app was closed is counted in the badge.
- On macOS it posts through `UNUserNotificationCenter`: the request's id is `outbox-<id>`, so the same line never shows twice. A delegate shows notifications even when midna is the app in front (the code only posts when its window isn't being looked at), and handles the click.
- On Linux, and under `tauri dev`, it posts through the Tauri notification plugin.
- midna's `device_notify` (docs/device-hands.md) goes the same way.

### Why they didn't arrive before 0.13.3

- The app posted through the Tauri notification plugin, which uses `NSUserNotification`, an API Apple deprecated in macOS 11. It can't ask for permission. On macOS 26, the first notification from an app that was never allowed is dropped: macOS shows a small "midna Notifications" hint for a few seconds, and until someone clicks Allow on it, every notification is dropped silently.
- The only way to be asked properly was the "Notify you" row on the Computer screen. A Mac where that was never clicked got nothing.
- Where they were allowed, they had no sound and no badge, a click did nothing, and they were raised by the window's JavaScript.

## When they don't arrive

1. Settings → This computer → Notifications: is it On? **Send a test** should show a banner and play a sound. If macOS refused it, the reason is shown beside the button.
2. System Settings → Notifications → midna: Allow notifications on, style Banners or Alerts, "Play sound for notification" on.
3. Is a Focus on? See above.
4. Is the app running? Its icon is in the menu bar. Settings → This computer → Open at login keeps it there.
5. Can it reach midna? The chat shows "Can't reach midna" when it can't.

## Not yet

- **Time-sensitive through a Focus.** It needs, once: the app id `sh.midna.desktop` registered on the team with the Time Sensitive Notifications capability; a Developer ID provisioning profile for it, embedded as `Contents/embedded.provisionprofile`; and three entitlements on the app's signature (`com.apple.developer.usernotifications.time-sensitive`, `com.apple.application-identifier` = `65UN46K6FA.sh.midna.desktop`, `com.apple.developer.team-identifier`). A wrong profile stops the app from launching, so it has to be tried on a Mac before it ships.
- Answering a question from the notification itself.
