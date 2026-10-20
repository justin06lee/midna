# midna on the iPhone

*Design note, 2026-10-20. Justin chose an Expo (React Native) + TypeScript app at `clients/mobile`. Nothing is built yet. How the phone reaches midna away from home is his call: section 3 lays out the options without picking one.*

**v1:** chat with midna; push-style notifications for its messages; ask_user answer buttons; attachments in and out; an approvals screen. Distribution is free sideloading (no paid Apple developer account).

## 1. What the app reuses

- **@midna/protocol, as is.** It depends only on zod: every wire type, `Approval`, `APPROVAL_OPTIONS` and `MidnaClient`.
- **One gap: streaming.** `MidnaClient.events()` reads the response body with `getReader()`, which React Native's own `fetch` lacks. `expo/fetch` streams. Either install it as the global `fetch`, or give `MidnaClient` an optional `fetch` (a small change in the protocol layer).
- **Pairing:** kind `mobile` is already in `PairRequest`. The phone takes a URL and a code from `midna pair`, keeps its token in the iOS Keychain (`expo-secure-store`), and sends `replaces` with the old token when it pairs again with the same host, as the CLI does. It answers approvals with `client: "mobile"`.
- **Drafts persist,** like every other text field: across restarts and failed sends.

## 2. What free sideloading allows

- **No push.** A Personal Team can't enable the Push Notifications capability (APNs), so midna can't wake the app with a remote notification. It can't enable Network Extension either, so the app can't carry its own VPN.
- **7 days.** A free profile expires after a week. The app stops launching until it's rebuilt and reinstalled from Xcode on the Mac. At most 3 sideloaded apps per phone, and 10 new app ids a week.
- **A dev build, not Expo Go.** Expo Go has no remote push from SDK 53, the App Store's Expo Go stops at SDK 54, and it loads its JavaScript from a dev server. A development build (`expo prebuild`, signed in Xcode with the Personal Team) runs our own code. A Release build carries its JavaScript and needs no Metro.
- **What "push-style" can mean without APNs:**
  - **Telegram,** as today: its app has push, and midna already delivers there, buttons and attachments included;
  - **ntfy:** the App Store ntfy app has push. midna publishes to a topic, and a tap opens `midna://`. Content passes through ntfy.sh unless midna runs its own ntfy server, which then sends only a wake-up through ntfy.sh;
  - **local notifications** while the app is open or recently backgrounded, plus background refresh, which iOS runs when it likes (minutes to hours, never after a force-quit). Not real-time.

  So v1's notifications are either Telegram or ntfy, until there's a paid account.

## 3. Reaching midna away from home

midna's daemon listens on `127.0.0.1` only. makima's auto-serve publishes it to mesh peers at `10.77.0.1:7717`. A phone that isn't a makima peer can't reach it, at home or away.

| | (a) makima on the phone | (b) a relay | (c) Telegram when away |
|---|---|---|---|
| **What has to exist** | There is no makima iOS client. A native one needs Network Extension: a paid account and a Go-to-iOS port. The data plane is stock WireGuard, so the App Store WireGuard app could be a peer, but only with a makima change. The Jetson runs managed mode: magicsock drops packets from peers the netmap didn't claim, and `peer add` is refused on managed nodes. makima would have to accept a static "foreign" peer and export its config (as a QR code). The phone also needs to reach UDP 51820 at home: a router port-forward, or the Jetson's global IPv6 allowed through the router's firewall. makima's relay can't carry a stock client. | A public HTTPS endpoint that forwards to `10.77.0.1:7717`: a VPS that is a makima node running a reverse proxy, or a tunnel service. Variant: an onion address (Tor already runs on the Jetson for makima), which opens no port but needs Orbot on the phone and is slow. makima has no funnel feature, and its relay only forwards WireGuard frames between members. | Nothing new. The bridge already carries chat, ask_user buttons, approvals and attachments, with Telegram's own push. The app works at home only, and only if the daemon also listens on the LAN (`--listen`), in plain HTTP. |
| **Security** | Nothing faces the internet beyond one WireGuard port, which answers only known keys. The phone's key becomes a mesh credential: revoke it on loss. | A new internet-facing surface: the API, `/v1/pair` with its short codes, and every token usable from anywhere. Needs TLS, rate limits, and probably keeping `/v1/pair` off the relay. | Telegram sees the conversation, as it does today. A plain-HTTP LAN listener exposes the token on the home Wi-Fi. |
| **Cellular / asleep** | The phone dials out, so carrier NAT is fine. The WireGuard app's on-demand rules reconnect on network changes, and an idle tunnel costs little. Without a public endpoint, nothing works on cellular. | Works anywhere HTTPS does. | Away, only Telegram. |
| **Effort** | makima side: medium (Justin's project). App side: none. | Medium: hosting, TLS, hardening. App side: only a URL. | Small: the app plus a LAN listen. |
| **Architecture Justin owns** | makima (managed mode, foreign peers), the home router. | The API boundary: midna's API goes public; who may pair and approve from outside. | Little: a LAN listen. Telegram stays the away path. |

**In every option,** iOS suspends the app in the background. Its event stream stops, and it catches up from `events(since)` when opened. Notifications therefore come from outside the app (section 2). **Approvals:** any paired client's token can answer one (that's how Telegram does it), and midna's own brain can reach some of those tokens. The fixes are proposed and await Justin. A phone token is one more such token, and under (b) a stolen one works from anywhere. The app could require Face ID before it answers; that needs no paid capability.

## 4. Questions only Justin can answer

1. **Reachability:** (a), (b) or (c)? Or (c) now and (a) or (b) later.
2. **If (a):** will makima accept foreign WireGuard peers in managed mode, with a config or QR export? Will the home router forward UDP 51820, or allow it over IPv6? Or wait for a paid account and a native makima client?
3. **If (b):** where does it run (a VPS on the mesh, a tunnel service, an onion address)? May midna's API face the internet at all, and may approvals be answered through it?
4. **Notifications without APNs:** Telegram stays the push channel, or ntfy (ntfy.sh sees the content, or only wake-ups if self-hosted)? Or a paid account later?
5. **Approvals:** may the phone approve shell and input on the Mac, as Telegram may (fork 1)? With Face ID on the phone?
6. **Re-signing:** is reinstalling from Xcode every 7 days acceptable?
7. **Home access:** may the daemon also listen on the LAN, in plain HTTP, for (c)?
