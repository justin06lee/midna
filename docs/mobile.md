# midna on the iPhone

*v1 is built at `clients/mobile`: an Expo (SDK 58) + TypeScript app, iOS only, sideloaded with a free Apple account. Justin's answers of 2026-10-20 are below. The options weighed before them (makima on the phone, a relay, Telegram only) are in this file's history at 6150bfd.*

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
- **Notifications are Telegram's** for now. The app has no push; revisit with the paid ($99) account.
- **Face ID before any approval** is answered from the phone: Face ID only, with no passcode fallback, so a phone picked up unlocked can't say yes. This guards the phone, not midna's side: any paired token can still answer through `/v1/approvals` (the forgery item already with Justin).
- **Reinstalling every 7 days** (free provisioning) is accepted.

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

## 4. Free sideloading: what it allows

- **No APNs push, and no Network Extension.**
- **A dev build, not Expo Go:** `expo prebuild`, signed in Xcode with the Personal Team. A Release build carries its own JavaScript.
- **The profile expires after 7 days;** the app then stops launching until it's reinstalled from the Mac.
- **Limits:** 3 sideloaded apps per phone, and 10 new app ids a week.

## 5. Onto Justin's iPhone

1. **On the Mac:**
   - Accept Xcode's licence once (`sudo xcodebuild -license accept`).
   - Add the Apple ID in Xcode → Settings → Accounts; this creates the Personal Team.
2. **Generate the native project:** `cd clients/mobile && bunx expo prebuild -p ios`. Open `ios/midna.xcworkspace`.
3. **Set signing:**
   - Under Signing & Capabilities, pick the Personal Team.
   - If Xcode says the id is taken, change the bundle id from `sh.midna.mobile` to something unique to him, e.g. `dev.justin06lee.midna`.
4. **Get the phone ready:**
   - Connect it by cable and trust the Mac.
   - Turn on Settings → Privacy & Security → Developer Mode (it restarts).
5. **Build and run:**
   - Choose the iPhone as the destination.
   - Set Product → Scheme → Edit Scheme → Run → Build Configuration to Release, so the JavaScript is bundled and no Metro is needed.
   - Run.
   - Or, in one command: `bunx expo run:ios --device --configuration Release`.
6. **Trust the developer on the phone:** Settings → General → VPN & Device Management → his Apple ID → Trust.
7. **Pair:**
   - Open midna and pair with `http://midna:7717` and a code from `midna pair`, run on the host or on the Mac (its CLI is paired).
   - This waits for the Tailscale switch-over: Tailscale on the phone, and `tailscale0` in the daemon's `listen`.
8. **Every 7 days,** repeat step 5. The pairing and the drafts survive a reinstall over the same app id.
