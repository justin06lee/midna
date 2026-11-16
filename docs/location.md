# Location

midna knows where Justin is, from his iPhone, so it can help with what's around him and notice when he gets home or leaves work.

## What the phone sends, and when

Precise logging (Justin's call, 2026-11-16, replacing "significant changes only").

- **Precise fixes, with Always** (source `precise`): standard updates, `kCLLocationAccuracyBest`, a fix every 30 m of movement (`distanceFilter`), in the background too (`allowsBackgroundLocationUpdates`, `UIBackgroundModes: location`, no blue indicator with Always). `pausesLocationUpdatesAutomatically` lets iOS turn the GPS off once the phone sits still; on a pause the phone sends what waits and watches a 100 m region around where it stopped, and leaving it starts the updates again. On the phone, precise fixes are sent together at most once a minute (`sendNow` in `locationQueue.ts`); everything else goes at once.
- **Significant changes, always** (source `significant`): the safety net. When iOS ends the app, significant changes (about 500 m) relaunch it in the background; expo-task-manager restores the task, which starts the precise updates again.
  - Both live in `clients/mobile/modules/midna-location`, one task consumer (`MidnaSignificantChangesConsumer`, a name kept because expo-task-manager saves it with the task) with a manager each. With only "while using", the precise updates don't run.
- **The app opening** (source `app`): each launch and each return to the foreground takes one fix and sends it.
- **midna asking** (source `requested`): a silent push (`content-available`, `apns-push-type: background`, priority 5, expires in a minute, `{ midna: "locate" }`). `MidnaLocationAppDelegateSubscriber` takes one `requestLocation()` fix with a separate manager, hands it to the task, and tells iOS it's done once the JavaScript has sent it (at most 25 s). iOS may hold back background pushes in Low Power Mode or after the app was swiped away; then midna gets no answer and says so. Needs the phone registered for push (notifications allowed).
  - Geofences are expo-location's (`startGeofencingAsync`), one per saved place. iOS reports every region's state each time they're registered and sometimes reports a crossing twice. The phone keeps the last state of each place and sends only a change from it; the first state heard for a place is just noted (`locationQueue.ts`).
  - "Save here" on a place asks iOS for one fix, because Justin tapped it. That fix goes to midna too, as source `app`.
- **Where it goes:** straight to midna's host over the connection the chat uses, `POST /v1/location`, and nowhere else. No third-party service. Each fix waits in SQLite on the phone (`midna.location.queue`, up to 5,000) until midna has it, so nothing is lost offline. The same fix sent twice is kept once.
- **Permission:** "Always", and Precise Location on. iOS asks twice: while using the app first, then Always. Settings → Location explains this before iOS asks. With only "while using", significant changes run only while the app is open, there are no precise fixes, places aren't watched, and Settings says so and offers iPhone Settings. With Precise Location off, it says that too.
- **Battery:** the GPS runs only while the phone moves; sitting still, iOS pauses it. A day with an hour or two of travel costs a few percent; a long drive, more.

## The token used while the phone is locked

The pairing's token is readable only while the phone is unlocked (docs/mobile.md), and most fixes arrive while it's locked. So once location is turned on, the phone asks for a second token, `POST /v1/location/token`, that can only call `POST /v1/location`. Every other route answers it 403. The phone keeps it in the Keychain readable after first unlock (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`), never synced off the phone.

- On the host it's a device of kind `location`, named "<phone> · location", whose `parent_id` is the phone's pairing.
- Its fixes are kept under the phone's own pairing.
- Minting a new one retires the last.
- Unpairing the phone, or pairing again with `replaces`, retires it with the pairing.
- Turning location off in the app deletes it from the phone.

## What midna keeps

Migration 14 (sources `precise` and `requested`: migration 16): `location_points` (every fix, forever: when the phone took it, where, accuracy, altitude, speed, why it was sent, the saved place it was in, when it arrived) and `places`. A deleted place is only hidden (`deleted_at`), so fixes taken there keep its name. Nothing deletes fixes.

## Places

- Home, the office, the gym, the masjid: the app suggests these, saved where the phone is when Justin taps "Save here".
- Each has a size, 100 to 2,000 m across (150 m by default; iOS is unreliable under 100 m).
- At most 19: iOS watches 20 regions for one app, and the phone keeps one for resuming the precise updates.
- A name is one place, in any case: saving "home" again moves Home.
- Where places overlap, the smallest one around the fix is the one he's in.
- The phone learns of a change midna made the next time it reports (every report's answer carries the places) or the app is opened.

## midna's tools

- `location_now`: the latest fix, the saved place it's in and since when (or the nearest place and how far), how old the fix is, and a maps link. An old fix usually means he hasn't moved. `fresh: true` sends the silent push and waits up to 20 s for a fix that arrives after it (`receivedSince`); otherwise it gives the last fix with `fresh: false` and a note on why.
- `location_history`: fixes between two times (default: the last 24 hours), oldest first, each with its place and why it was sent.
- `places_list`, `place_save` (without coordinates, a new place goes where the phone is now: it asks, as `fresh` does, and falls back to the last fix; `here: true` moves one there; `from_fix` says how old the fix was), `place_delete`.

These are midna's own MCP tools, so every brain behind yagami has them. Hermes (`midna model hermes`) doesn't.

## API

| Route | Who | |
|---|---|---|
| `POST /v1/location` | the phone, or its location token | `{ fixes: [...] }` → `{ kept, places }` |
| `GET /v1/location` | desktop, phone, CLI, host | the latest fix, the place it's in, since when, how many are kept, the places |
| `POST /v1/location/token` | the phone | `{ deviceId, token }` |
| `GET/POST /v1/places`, `PATCH/DELETE /v1/places/:id` | desktop, phone, CLI, host | |

Bridges (Telegram, Hermes) get 403 on every one of them.
