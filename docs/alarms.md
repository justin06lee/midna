# Alarms

midna sets alarms on Justin's iPhone that ring like the Clock app's: out loud, through silent mode and any Focus, until he stops them. They are iOS's own alarms (AlarmKit, iOS 26), not notifications.

## Setting it up on the phone

1. Install the build with alarms from TestFlight (build 8 or later) and open midna.
2. Tap **Allow** when iOS asks to let midna schedule alarms. That's all: Settings → Alarms in the app shows how many are set.

If he tapped Don't Allow: iPhone Settings → midna → Alarms, or the Alarms row in the app's Settings, which opens it.

## How it works

midna holds the list; the phone carries it out and says what iOS holds.

- **midna sets an alarm** with `alarm_set`: a one-off (`at`) or a repeating one (`time`, on `days`, every day by default). `alarm_list` and `alarm_cancel` are the other two. A time that moves from day to day, like Fajr, is a one-off set for each day.
- **The list goes to the phone at once** in a silent push (`{ midna: "alarms", alarms, asOf }`, `apns-push-type: background`, kept by Apple up to a day for a phone that's off). The list rides in the push, so the phone needs no connection to midna to set the alarms. A list too long for a push (over about 3.5 KB) is left out, and the phone fetches it.
- **The phone also fetches the list** each time the app is opened or comes back to the foreground, and at most every 15 minutes when a move wakes the app in the background (the location task). That makes up for a push Apple held back.
- **The phone hands the list to iOS** (`clients/mobile/modules/midna-alarms`): an alarm gone from the list, or changed since, is cancelled; one iOS doesn't hold is scheduled. A one-off is a fixed instant; a repeating one is a time on the phone's own clock, so it follows him across time zones.
- **The phone tells midna what iOS holds** (`POST /v1/alarms/report`): whether alarms are allowed, each alarm iOS holds (with the version of it), and any iOS refused. Until that report names an alarm, midna treats it as not on the phone: `alarm_set` waits up to 20 s for it and says `on_phone`, and when it's false, why and what Justin must do. The evening review checks again for alarms due overnight.
- **A late push never undoes a newer list.** Each list carries midna's clock (`asOf`); a push older than the list iOS has makes the phone fetch instead.

While the phone is locked it can't read the pairing's token, so the push and the background fetch use the location-only token (docs/location.md), which may also `GET /v1/alarms` and `POST /v1/alarms/report`. The phone makes one when the app is opened, whether or not location is on.

## What the alarm is

The label over a Stop button, and the system's alarm sound. No snooze: a snooze is a countdown, and iOS wants a widget extension for those (without one it may drop the alarm). For a second chance, midna sets a second alarm a few minutes later.

## Limits

- **iOS 26 or later.** On an older iPhone, or a build without the module, the phone reports "unsupported" and midna says so.
- **At most 20 alarms** (recurring ones and one-offs still to ring). A one-off is forgotten a day after it rang.
- **A one-off stays in the phone's list for an hour after its time**, so a sync that lands while it rings doesn't cancel it.
- **Apple may hold back a silent push** in Low Power Mode, after too many in an hour, or when the app was swiped away. Then the alarm reaches the phone the next time the app is opened; midna knows it hasn't arrived and says so.
- **Deleting the app deletes its alarms.**

## The API

| | |
| --- | --- |
| `GET /v1/alarms` | `{ alarms, asOf, phones }`: the list for the phone, and each phone's last report. The user's own devices and the location-only token. |
| `POST /v1/alarms` | Set one, or with `id` change one: `{ label, at }` or `{ label, time: "HH:MM", days?: [1..7] }` (1 is Monday). The user's own devices. |
| `DELETE /v1/alarms/:id` | Cancel one. |
| `POST /v1/alarms/report` | The phone: `{ authorization, scheduled: [{ id, updatedAt }], problems? }`. |

Shapes are in `packages/protocol/src/alarms.ts`; the store is `packages/core/src/alarms.ts` (migration 18: `alarms`, `alarm_phones`).

## Not checked on a phone yet

Written on a Mac without Xcode. `Alarms.swift` was type-checked against AlarmKit's own interface from the macOS 26.5 SDK (the Mac Catalyst copy, with its "unavailable on Catalyst" marks worked around), and `MidnaAlarmsModule.swift` against stand-ins for Expo's function builders. Neither has been built for iOS or run. The first TestFlight build must confirm:

1. The app builds. If the module's Swift stops the build, `MIDNA_ALARMS=0 make testflight` ships the build without alarms (the app runs without the module) while it is fixed.
2. iOS asks to allow alarms on first open, and Settings → Alarms reads "None set" or "N set".
3. A test alarm two minutes ahead (ask midna: "set an alarm for 2 minutes from now") rings with the phone locked, on silent, in a Focus. `on_phone` should come back true within seconds.
4. The same with the app swiped away, to learn whether the silent push alone gets an alarm onto the phone. If it doesn't, alarms still arrive when the app is opened.
5. Cancelling it (`alarm_cancel`) takes it off the phone.
