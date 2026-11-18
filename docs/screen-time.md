# Screen Time: holding back the apps that eat the day

*Written 2026-11-18. Justin loses 1–2 h a day to scrolling and wants midna to steer that time to reading (Justice), study and work. Built on the branch `phone-focus-screentime`. The phone's Swift is **not compiled yet**: there was no Xcode on charizard. It stays off unless the build sets `MIDNA_FOCUS=1`, which TestFlight can do only after Apple grants Family Controls. Justin decided on 2026-11-18 (below): midna holds the rules and the phone fetches them; coarse minutes go to midna for the morning and evening check-ins; shields go up any time, and a lift needs his stated reason.*

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
- **What to submit:** see "The request, step by step" below.
- **After approval** (midna's job):
  1. Developer site → Identifiers: on `sh.midna.mobile`, turn on **Family Controls** and **App Groups** (`group.sh.midna.mobile`). Register `sh.midna.mobile.focus-monitor`, `.focus-shield` and `.focus-shield-action` with the same two.
  2. Make an App Store profile for each of the four.
  3. `scripts/testflight.sh` exports with a single profile: add the three extension profiles to its `provisioningProfiles` (not done yet).
  4. Build with `MIDNA_FOCUS=1`, and fix what the first compile finds.

### The request, step by step (Huiyun Lee, the Account Holder)

Only the Account Holder of team 65UN46K6FA can send it. It takes about five minutes.

1. On a computer, sign in at <https://developer.apple.com/account> with the Apple Account that holds the team (Huiyun Lee).
2. Open <https://developer.apple.com/contact/request/family-controls-distribution>. If it asks which team, choose **Huiyun Lee (65UN46K6FA)**.
3. Fill it in with these answers. The form's own wording may differ a little; the answers stay the same.
   - **App name:** midna
   - **Bundle ID:** `sh.midna.mobile`. If it asks for the app's extensions too: `sh.midna.mobile.focus-monitor`, `sh.midna.mobile.focus-shield`, `sh.midna.mobile.focus-shield-action`.
   - **App Store Connect Apple ID of the app** (if asked): 6827804165
   - **Is this a parental-control app / who is managed:** No. Individual: the user limits their own iPhone (`AuthorizationCenter.requestAuthorization(for: .individual)`).
   - **How is it distributed:** TestFlight, internal testing only, to one user.
   - **Describe how your app uses Family Controls** (paste):

     > midna is a personal assistant that one person runs for themselves. With that user's own Screen Time authorization (individual, not parental), the app lets the user choose, in FamilyActivityPicker, the apps and websites they want to spend less time in. It then shields them on demand or in daily windows the user sets, using ManagedSettings and DeviceActivity. The shield offers what the user would rather do instead (a book, a study block). The user can lift the shield for a few minutes by stating a reason. A DeviceActivityMonitor extension records only coarse daily totals for the chosen apps (threshold events in 15-minute steps) and how often a shield was shown. The app sends those totals to the user's own assistant server for their morning and evening reviews. The picked apps stay opaque tokens on the device, no data about anyone else is collected, and nothing is sold, shared or used for ads.

   - **Contact:** the Account Holder's email.
4. Submit. Apple answers by email to the Account Holder, usually within a few days (sometimes weeks). Forward the answer to Justin.
5. If nothing comes within a week, reply to Apple's confirmation email, or file a code-level support request quoting the Team ID.

## Until Apple approves: Instagram opens → Justice opens (Shortcuts)

This needs no app change and works today. Set it up once on the iPhone:

1. Open **Shortcuts** → the **Automation** tab → **+** (or **New Automation**).
2. Choose **App**. Tap **Choose** and tick **Instagram**, **YouTube**, **X** and **TikTok** (any app that eats the day) → **Done**.
3. Leave **Is Opened** ticked and **Is Closed** unticked. Choose **Run Immediately**, and turn **Notify When Run** off → **Next**.
4. Tap **New Blank Automation** (or **Add Action**). Search **Open App**, add it, tap **App**, and choose where Justice is: **Books** (Apple Books opens on the book last read), or **Kindle**.
   - For a paper copy, use **Show Notification** instead, with the text "Justice instead? 20 pages."
5. Optional, to keep the habit honest: add **Show Notification** above it with the text "Not now. Justice first."
6. Tap **Done**.

Each time one of those apps opens, the book opens over it at once. When he really needs the app, he goes back to it: the automation runs only on opening, so returning from the app switcher doesn't trigger it again. Or he turns the automation off in Shortcuts for a while. To limit it to certain hours, put the action inside **If** → **Current Date** → **is between** (for example 21:00 and 23:59).

## Other options without the entitlement

- **More Shortcuts automations** (Shortcuts → Automation → App → "Is Opened", Run Immediately, with "Notify When Run" off), one per app:
  - **Open the better thing:** "Open App" Books, or a link to Justice. This works today and needs no midna change.
  - **Tell midna:** "Get Contents of URL", POST to `/v1/inbound` with a device token, `{"source":"phone","title":"Opened Instagram","data":{"kind":"app.opened","app":"Instagram"}}`. midna then hears **named** app opens from a TestFlight build, with no Apple approval. Each event wakes midna (one turn per 2-minute window), so it needs a log-only path first: decision 1.
  - An automation runs after the app has opened. It can't block anything.
- **Focus** (a "Study" or "Reading" Focus, on a schedule or set by a Shortcut) silences apps' notifications and can hide home-screen pages. It doesn't block apps. A Focus filter (`SetFocusFilterIntent`) would let the app tell midna which Focus is on. Not built.
- **Screen Time's own app limits** (Settings, with a passcode someone else keeps) are the bluntest option, with no midna in the loop.

## What's built (`phone-focus-screentime`)

**midna's side** (tested: `packages/daemon/test/push.test.ts`, "Screen Time"):
- `packages/protocol/src/focus.ts` defines the rules (`FocusRules`: a hold, optionally until a time, daily windows, the offer, the latest lift), a lift (`FocusLiftAsk`: minutes and a reason, optionally ending the hold) and the phone's report (`FocusReport`: two weeks of minutes and shields met, and how Screen Time stands).
- Storage is `packages/core/src/focus.ts`, with migration 17: `focus_days`, plus `focus_lifts` with every reason. The rules live in settings.
- Routes in `packages/daemon/src/server.ts`:
  - `GET /v1/focus` and `PATCH /v1/focus/rules` are for his own devices. Letting go of a hold there is refused (409): that is a lift.
  - `POST /v1/focus/lift` is the phone only.
  - `POST /v1/focus/report` takes the phone's own token, or its location-only token while locked.
- Every change goes to the phone in a silent push that carries the rules (`midna: "focus"`, `focusPayload` in `push.ts`), and asks the phone for its numbers.
- midna's tools (`packages/agent/src/tools.ts`):
  - `screen_time`: days, lifts and rules. With `fresh`, it asks the phone and waits 20 s.
  - `screen_time_rules`: puts the shield up (now, until a time, or in windows) and sets the offer. No reason is needed.
  - `screen_time_lift`: needs minutes and Justin's reason in his own words.
- The morning brief and evening review call `screen_time`. A phone that never reported is never asked.

**The phone** (Swift not compiled yet):
- `modules/midna-focus/ios/`: `MidnaFocusModule.swift` is the app's side. `Focus.swift` is the shared state in the app group `group.sh.midna.mobile`; each extension links to it. It applies midna's rules: a hold that ends by itself (a DeviceActivity interval), windows, the offer, and each lift once, by its id. It keeps two weeks of minutes and shields met for the report.
- `targets/` (through `@bacons/apple-targets`):
  - `focus-monitor` opens and closes windows, ends holds and lifts, and records minutes.
  - `focus-shield` draws the shield: "Instagram can wait · Justice is waiting. 45 min in these today", with **Open Justice** and **Ask midna** buttons.
  - `focus-shield-action` leaves a notification for each button.
- `src/focus.ts` syncs on launch and on each return: it fetches the rules, applies them and reports. A background task does the same on midna's silent push, and reports with the location-only token.
- Settings → Screen Time (`src/screens/Focus.tsx`): choosing the apps stays on the phone. A hold, a window or the offer goes to midna first and is applied as midna answers. A lift or "Let go of the hold" needs a reason, and midna keeps it.
- `app.config.js` adds the entitlements, the app group and the targets only with `MIDNA_FOCUS=1`.

## Decided (Justin, 2026-11-18)

1. **Usage:** coarse minutes go to midna, for the morning and evening check-ins.
2. **Control:** midna holds the rules and the phone fetches them. Shields go up any time; a lift needs his stated reason.
3. **Getting it onto the phone:** build 8 shipped the notification fix without Screen Time. Huiyun Lee asks Apple for Family Controls (above). Until then, the Shortcuts automation.
4. **Notifications:** replies to what was said on the Mac or Telegram don't ring the phone for now.
