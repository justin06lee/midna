# Location

midna knows roughly where Justin is, from his iPhone, so it can help with what's around him and notice when he gets home or leaves work.

## What the phone sends, and when

- **Only two things make it report:** iOS's significant location changes (about 500 m, from cell towers and Wi-Fi; no GPS), and arriving at or leaving a saved place (geofences). Nothing continuous, and no blue location indicator.
  - expo-location's own background updates also start the GPS (`startUpdatingLocation`), so the app doesn't use them. `clients/mobile/modules/midna-location` is a small native module whose task consumer only calls `startMonitoringSignificantLocationChanges`. expo-task-manager restores it at every launch, so it carries on after the app is closed or the phone restarts, and iOS relaunches the app in the background to deliver a move.
  - Geofences are expo-location's (`startGeofencingAsync`), one per saved place. iOS reports every region's state each time they're registered and sometimes reports a crossing twice. The phone keeps the last state of each place and sends only a change from it; the first state heard for a place is just noted (`locationQueue.ts`).
  - "Save here" on a place asks iOS for one fix, because Justin tapped it. That fix goes to midna too, as source `app`.
- **Where it goes:** straight to midna's host over the connection the chat uses, `POST /v1/location`, and nowhere else. No third-party service. Each fix waits in SQLite on the phone (`midna.location.queue`, up to 5,000) until midna has it, so nothing is lost offline. The same fix sent twice is kept once.
- **Permission:** "Always". iOS asks twice: while using the app first, then Always. Settings → Location explains this before iOS asks. With only "while using", significant changes run only while the app is open, places aren't watched, and Settings says so and offers iPhone Settings.

## The token used while the phone is locked

The pairing's token is readable only while the phone is unlocked (docs/mobile.md), and most fixes arrive while it's locked. So once location is turned on, the phone asks for a second token, `POST /v1/location/token`, that can only call `POST /v1/location`. Every other route answers it 403. The phone keeps it in the Keychain readable after first unlock (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`), never synced off the phone.

- On the host it's a device of kind `location`, named "<phone> · location", whose `parent_id` is the phone's pairing.
- Its fixes are kept under the phone's own pairing.
- Minting a new one retires the last.
- Unpairing the phone, or pairing again with `replaces`, retires it with the pairing.
- Turning location off in the app deletes it from the phone.

## What midna keeps

Migration 14: `location_points` (every fix, forever: when the phone took it, where, accuracy, altitude, speed, why it was sent, the saved place it was in, when it arrived) and `places`. A deleted place is only hidden (`deleted_at`), so fixes taken there keep its name. Nothing deletes fixes.

## Places

- Home, the office, the gym, the masjid: the app suggests these, saved where the phone is when Justin taps "Save here".
- Each has a size, 100 to 2,000 m across (150 m by default; iOS is unreliable under 100 m).
- At most 20, which is iOS's limit for one app.
- A name is one place, in any case: saving "home" again moves Home.
- Where places overlap, the smallest one around the fix is the one he's in.
- The phone learns of a change midna made the next time it reports (every report's answer carries the places) or the app is opened.

## midna's tools

- `location_now`: the latest fix, the saved place it's in and since when (or the nearest place and how far), how old the fix is, and a maps link. An old fix usually means he hasn't moved.
- `location_history`: fixes between two times (default: the last 24 hours), oldest first, each with its place and why it was sent.
- `places_list`, `place_save` (without coordinates, a new place goes where the phone last was; `here: true` moves one there), `place_delete`.

These are midna's own MCP tools, so every brain behind yagami has them. Hermes (`midna model hermes`) doesn't.

## API

| Route | Who | |
|---|---|---|
| `POST /v1/location` | the phone, or its location token | `{ fixes: [...] }` → `{ kept, places }` |
| `GET /v1/location` | desktop, phone, CLI, host | the latest fix, the place it's in, since when, how many are kept, the places |
| `POST /v1/location/token` | the phone | `{ deviceId, token }` |
| `GET/POST /v1/places`, `PATCH/DELETE /v1/places/:id` | desktop, phone, CLI, host | |

Bridges (Telegram, Hermes) get 403 on every one of them.
