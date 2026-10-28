# midna on the iPhone

*v1 is built at `clients/mobile`: an Expo (SDK 58) + TypeScript app, iOS only. Since 2026-10-27 it is signed by the paid team (65UN46K6FA), ships through TestFlight to Justin alone, and gets push notifications (docs/push.md). Justin's answers of 2026-10-20 are below. The options weighed before them (makima on the phone, a relay, Telegram only) are in this file's history at 6150bfd.*

## 1. Decisions (Justin, 2026-10-20)

- **Reachability will be Tailscale, switched on later, when Justin is home.** The phone will run Tailscale and reach midna over the tailnet, at an address typed into the app: `http://midna:7717` (MagicDNS) or a 100.x IP.
  - Until then, nothing changes: no Tailscale installs, and no change to the daemon's listen addresses. The address is just a field, so a tailnet one drops in later.
  - Tests against the real midna use its makima address, `http://10.77.0.1:7717`, from the simulator on the Mac (the phone itself isn't a makima peer). The default for testing is a throwaway local daemon. Pairing the simulator with the live host needs the Lead's OK first.
  - At switch-over, the daemon listens on the tailnet's address too, via a `listen` entry naming `tailscale0` (065fa4b, not yet released).
  - It's plain HTTP inside the tailnet, and the token auth stays.
  - **App Transport Security** (iOS's HTTPS-only rule; `ios.infoPlist` in `clients/mobile/app.json`) lets plain HTTP through to midna's addresses only, now and after the switch-over, with no rebuild:
    - `NSAllowsLocalNetworking`: unqualified names (`http://midna:7717`), `.local` names and IP addresses.
    - Plain HTTP exceptions for makima's mesh, `10.77.0.0/16` (`http://10.77.0.1:7717` today), and Tailscale's addresses, `100.64.0.0/10`. From iOS 17, IP addresses need listing; CIDR ranges are allowed.
    - `ts.net` and its subdomains, for a MagicDNS full name (`http://midna.<tailnet>.ts.net:7717`). The tailnet's own name isn't known yet; once it is, this can narrow to `<tailnet>.ts.net`, which needs a rebuild.
    - Everything else stays HTTPS-only (`NSAllowsArbitraryLoads` is false).
    - Expo replaces the whole dictionary, not merging it, so `NSAllowsLocalNetworking` must stay listed there.
  - makima is not involved.
- **Notifications are Telegram's** for now. The app has no push; revisit with the paid ($99) account. *Done 2026-10-27: push notifications, with Telegram kept as the fallback (docs/push.md).*
- **Face ID before any approval** is answered from the phone: Face ID only, with no passcode fallback, so a phone picked up unlocked can't say yes. This guards the phone, not midna's side: any paired token can still answer through `/v1/approvals` (the forgery item already with Justin).
- **Reinstalling every 7 days** (free provisioning) is accepted. *Over 2026-10-27: TestFlight builds last 90 days and update themselves.*

## 2. What v1 does

- **Pairing:** an address, a code from `midna pair` on the host, and a name for the phone; kind `mobile`.
  - The token is kept in the Keychain, readable only while the phone is unlocked and never synced off it.
  - "Pair again" keeps the old pairing aside until the new one works, and names it as `replaces` only to the same host, so the host retires it.
  - "Unpair" revokes the phone's own device.
- **Chat:** history plus the live stream, through `expo/fetch`, which can stream a response body: `new MidnaClient(url, token, { fetch })`, c84a710.
  - iOS suspends the app in the background. Coming back to the foreground reconnects at once and refetches the latest history, so what was said meanwhile, on any client, appears.
- **ask_user** options are buttons.
- **An approval's question in chat never answers by sending its label,** which would skip Face ID. Its buttons, in chat and on the Approvals screen, ask for Face ID and then answer the approval with `client: "mobile"`.
- **Attachments, both ways:**
  - Photos and videos (HEIC converted to JPEG) and files go up before the message, up to 20 per message.
  - midna's images are drawn inline and open full screen; its files open in Quick Look or the share sheet.
- **Drafts:** the composer's text, and the files already uploaded for it, are kept in SQLite (`expo-sqlite/kv-store`), written synchronously as they're typed, under the desktop's keys (`midna.draft:<url>#<device>`, plus `:files`).
  - They go only once the message is sent, so they survive tab switches, the app being killed, and a failed send.
  - The pairing form's address and name are drafts too. The code is a secret, so it's kept in memory only.

## 3. Annotations, later: the shape, agreed with the protocol's owner

Drawing on a screenshot, marking a video frame, highlighting a time range. These come later, as marks on an attachment, without a breaking change.

```ts
/** On SendMessage (and later OutboxItem and HistoryItem); a daemon before it drops the field. */
annotations?: Annotation[]; // at most 50 per message

interface Annotation {
  /** Any attachment the daemon holds — not only this message's: marking up midna's own screenshot is the main case. */
  attachmentId: string;
  anchor:
    | { kind: "region"; x: number; y: number; w: number; h: number; at?: number } // a box; at: a video's frame
    | { kind: "path"; points: Array<[number, number]>; at?: number } // a drawn stroke, at most 2,000 points
    | { kind: "frame"; at: number } // one video frame
    | { kind: "range"; from: number; to: number }; // a stretch of video or audio
  note?: string;
  color?: string; // "#rrggbb"
  /** The id of this message's burned-in copy, which clients that redraw the marks hide. */
  renderedAs?: string;
}
```

- **Units:** coordinates are 0..1 of the image as displayed, after rotation. `at`, `from` and `to` are milliseconds.
- **Attachments never change.** The app also uploads a flattened copy with the marks drawn in (linked by `renderedAs`), so the brain, Telegram and an older daemon see them.
- **Notes, frames and ranges reach the brain as text** with the message ("marked 0:42–0:51: 'here it freezes'"); it can cut a frame or clip from those times.
- **Building it** needs a migration (an annotations column on messages and outbox items), and history must carry the annotations so clients can redraw them.
- **On the phone,** `Line.attachments` stays as it is; marks attach beside it, keyed by attachment id.

## 4. Signing and TestFlight (paid team, from 2026-10-27)

- **Team** 65UN46K6FA ("Huiyun Lee"), set by `expo.ios.appleTeamId` in `app.json`. **Bundle id** `sh.midna.mobile`, registered on that team with Push Notifications. **App Store Connect app** "midna" (id 6827804165, SKU `midna-ios`).
- **TestFlight, internal only:** the group "Justin" (Justin alone) gets every build. No App Store review.
- **`ios/` is generated** by `expo prebuild` from `app.json` and ignored by git; signing, the push entitlement and versions all come from `app.json`. Never hand-edit `ios/`.
- **A new build:** raise `expo.ios.buildNumber` in `app.json`, then `make testflight` with `ASC_KEY_ID` and `ASC_ISSUER_ID` set (the App Store Connect API key; its `.p8` stays in `~/.appstoreconnect/private_keys`, never in the repo). The script runs prebuild, archives with automatic signing through that key, and uploads. Everything Xcode writes stays in `clients/mobile/build` on the T7, outside `ios/`, so the build cache survives prebuild.
- **The distribution certificate** is "Apple Distribution: Huiyun Lee" (id 67BF3F54S8, until 2027-10-28), made through the API: the App Manager key may not use Apple's cloud signing. Its private key lives only in `~/Library/Keychains/midna-signing.keychain-db`, on the user's keychain list beside the login keychain. That keychain's password is a generic password in the login keychain (`midna-signing-keychain`); the script unlocks it, so codesign never asks. The export signs with it and the App Store profile "midna App Store" (made through the API, installed in `~/Library/Developer/Xcode/UserData/Provisioning Profiles`); both run out on 2027-10-28. If the keychain is lost, revoke the certificate and make another, then the profile.
- **On the phone:** install TestFlight from the App Store, accept the invitation, install midna. TestFlight updates it; a build lasts 90 days.

## 5. Free sideloading, before the paid team

- **No APNs push, and no Network Extension.**
- **A dev build, not Expo Go:** `expo prebuild`, signed in Xcode with the Personal Team. A Release build carries its own JavaScript.
- **The profile expires after 7 days;** the app then stops launching until it's reinstalled from the Mac.
- **Limits:** 3 sideloaded apps per phone, and 10 new app ids a week.
- The steps that were used to put it on the phone are in this file's history before 2026-10-27.
