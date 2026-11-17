# Screen Time: holding back the apps that eat the day

*Written 2026-11-18. Justin loses 1–2 h a day to scrolling and wants midna to steer that time to reading (Justice), study and work. Built on the branch `phone-focus-screentime`. It is **not compiled yet**: there was no Xcode on charizard that night. It stays off unless the build sets `MIDNA_FOCUS=1`.*

## What Apple's Screen Time API allows, on his own phone

FamilyControls, ManagedSettings and DeviceActivity, with **individual** authorization (iOS 16+):

- **Permission.** He allows it once with Face ID or the passcode, and he can take it back any time in Settings → Screen Time. Deleting the app also drops every shield. Only a parent's authorization over a child's phone can stop someone turning it off. This is a commitment device, not a lock.
- **Choosing the apps is only through Apple's picker** (`FamilyActivityPicker`): apps, whole categories, and websites. The app gets opaque tokens. Code never sees which app a token is, and a token means nothing off that phone, so **midna can't say "shield Instagram" by name**. Justin picks once on the phone; midna speaks of "the held apps". Two exceptions name things in code: websites (`webContent.blockedByFilter` with `WebDomain(domain:)`), and `application.blockedApplications` with a bundle id. The second hides an app instead of shielding it and is reported to work, but is untested here.
- **Shields** (`ManagedSettingsStore`) stay up with the app closed and across restarts. A shield-configuration extension sets its look: a title, a subtitle, and two buttons. **A shield's button can't open an app.** It can only close the app or stay on the shield. The usual way round, used here, is that the button leaves a notification, and tapping that opens the link.
- **Schedules** (`DeviceActivitySchedule`, at least 15 min each, about 20 per app) run in a monitor extension with the app closed. That covers daily windows and a lift running out.
- **Usage is the hard limit.** Exact minutes can only be shown in a `DeviceActivityReport`. That is a SwiftUI view drawn by a sandboxed extension, with no network and no way to write data out. Apple staff confirmed this is on purpose ([forum](https://developer.apple.com/forums/thread/818174), [forum](https://developer.apple.com/forums/thread/809823)). What can leave is **threshold events**: "the held apps passed 45 min today", fired in the monitor extension, which can write to the app group. Usage is therefore known in steps (15 min here), and so is how often a shield was met. Whether the monitor extension may make network calls itself is unconfirmed, so plan on the app forwarding the numbers.
- **Apple has no channel to change Screen Time from a server.** The phone applies every change itself, through one of three routes: a background push wakes the app (best effort; iOS throttles it and skips an app he swiped away), the app pulls when it opens, or a button in the chat.

## The Family Controls entitlement

- **Development** comes with the paid team. A build signed for development and installed from Xcode works on his phone today, without asking Apple. It replaces the TestFlight app (same bundle id), and its profile lasts a year.
- **Distribution** (TestFlight and the App Store) needs Apple's approval. It is requested at <https://developer.apple.com/contact/request/family-controls-distribution> by the team's **Account Holder** (team 65UN46K6FA, "Huiyun Lee"; only that person can submit). According to Apple's developer support in 2026, approval covers the whole team, so the extensions need no requests of their own ([forum](https://developer.apple.com/forums/thread/824198)). Developers report anything from a day to several weeks. If an extension stays "Submitted", file a code-level support request with the Team ID.
- **Have this ready for the form.** I couldn't open the form itself (it needs a sign-in), so check its fields against this list:
  - Team ID `65UN46K6FA`, app name **midna**, App Store Connect app id 6827804165.
  - Bundle ids `sh.midna.mobile`, `sh.midna.mobile.focus-monitor`, `sh.midna.mobile.focus-shield`, `sh.midna.mobile.focus-shield-action`.
  - Use: **individual** (the user limits their own device), not parental control. Distribution: TestFlight, internal testing only.
  - A description, for example: *"midna is a personal assistant the user runs for themselves. With the user's own Screen Time authorization (individual), it shields apps and websites the user chose in FamilyActivityPicker, on demand or in daily windows the user sets. The shield offers what the user would rather do (a book, a study block). The user can lift it for a few minutes by giving a reason. The app reads only coarse daily totals (threshold events in 15-minute steps) for the user's own daily review. Nothing about other people is collected, and nothing is sold or shared."*
- **After approval:**
  1. Developer site → Identifiers: on `sh.midna.mobile`, turn on **Family Controls** and **App Groups** (`group.sh.midna.mobile`). Register the three extension ids with the same two.
  2. Make an App Store profile for each of the four.
  3. `scripts/testflight.sh` exports with a single profile: add the three extension profiles to its `provisioningProfiles` (not done yet).
  4. Build with `MIDNA_FOCUS=1`.

## Without the entitlement

- **Shortcuts automations** (Shortcuts → Automation → App → "Is Opened", Run Immediately, with "Notify When Run" off), one per app:
  - **Open the better thing:** "Open App" Books, or a link to Justice. This works today and needs no midna change.
  - **Tell midna:** "Get Contents of URL", POST to `/v1/inbound` with a device token, `{"source":"phone","title":"Opened Instagram","data":{"kind":"app.opened","app":"Instagram"}}`. midna then hears **named** app opens from a TestFlight build, with no Apple approval. Each event wakes midna (one turn per 2-minute window), so it needs a log-only path first: decision 1.
  - An automation runs after the app has opened. It can't block anything.
- **Focus** (a "Study" or "Reading" Focus, on a schedule or set by a Shortcut) silences apps' notifications and can hide home-screen pages. It doesn't block apps. A Focus filter (`SetFocusFilterIntent`) would let the app tell midna which Focus is on. Not built.
- **Screen Time's own app limits** (Settings, with a passcode someone else keeps) are the bluntest option, with no midna in the loop.

## What's built (`phone-focus-screentime`)

- `modules/midna-focus/ios/`: `MidnaFocusModule.swift` is the app's side. `Focus.swift` is the shared state in the app group `group.sh.midna.mobile`; each extension links to it.
  - The state: the chosen apps, held on demand, daily windows, a lift and when it runs out, today's minutes (15-minute threshold events up to 5 h, counting earlier use on iOS 17.4+), how often a shield was met, and the offer.
  - The shield is up when the apps are held (on demand or in a window) and no lift is running.
- `targets/`, through `@bacons/apple-targets`:
  - `focus-monitor` (`DeviceActivityMonitorExtension`): opens and closes windows, ends a lift, records minutes.
  - `focus-shield` (`ShieldConfigurationExtension`): "Instagram can wait · Justice is waiting. 45 min in these today", with **Open Justice** and **Ask midna** buttons.
  - `focus-shield-action` (`ShieldActionExtension`): each button leaves a time-sensitive notification.
- **A lift** lasts *N* minutes of use of the held apps, or 15 minutes of the clock if that is longer, whichever ends first. The monitor extension puts the shield back with the app closed.
- **App:** Settings → Screen Time (`src/screens/Focus.tsx`, `src/focus.ts`, `src/focusTime.ts`). It allows Screen Time, chooses the apps, holds them now or lets them go, and edits the daily windows and the offer (title and link).
  - The lift takes a reason and 5, 15 or 30 min. The reason goes to midna as a chat message: `[Screen Time] I lifted the shield for 15 min: …`.
  - Tapping **Open Justice** opens the link. Tapping **Ask midna** opens the lift.
- **Gate:** `app.config.js` adds the entitlements, the app group, `MidnaFocus` in Info.plist and the targets only with `MIDNA_FOCUS=1`. Otherwise the module reports itself unavailable and Settings shows nothing. Prebuild was checked both ways: three targets and their entitlements with the flag, none without it.
- **Not yet:** compiled in Xcode, or run on a phone. The Swift was written without a compiler, so expect a round of fixes on the first build.

## For Justin to decide

1. **Where usage data lives.**
   - (a) It stays on the phone: midna sees only the lift messages.
   - (b) **Recommended:** the app sends the day's numbers (minutes in 15-minute steps, shields met, lifts with reasons) to a small `screen_time` table on the host when it opens and on the silent push midna already uses for location. The morning brief and evening review read it.
   - (c) Also Shortcut app-open events, kept as a log that doesn't wake midna.
2. **How midna commands the phone.**
   - (a) **Recommended:** midna holds the policy (windows, offer, "hold now until 17:00"), and the phone pulls it when it opens and on a silent push. Then midna can say "I've put Instagram away until your study block ends."
   - (b) Buttons in midna's chat messages that the phone carries out when tapped. This is reliable, but needs him to tap.
   - (c) Phone-only control, as built: midna advises, he acts.
   - Whichever is chosen: may midna *lift* the shield too, or only put it up?
3. **Getting it onto his phone.**
   - (a) **Recommended:** a development build from Xcode now. This needs a short dev-install script, and it replaces the TestFlight app until approval.
   - (b) Wait for Apple's distribution approval, then use TestFlight.
4. **Notifications (docs/push.md):** replies are pushed only when he last wrote from the phone. Should replies to the desktop or Telegram ring the phone too?
