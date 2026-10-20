# Device hands: the desktop app as midna's hands

*Design note, 2026-10-19. Proposal for midna's approval; nothing here is built yet.*

midna lives on the Jetson. To act on Justin's MacBook Air (and later his Arch desktop, tenet) it needs eyes and hands there, with the OS permissions that takes. The desktop app is already installed, paired and running on those machines. This note makes it midna's hands: the app registers as a **device** that offers capabilities, the daemon exposes them to midna as MCP tools, and the app holds every OS permission, granted once.

**Hard rule, all phases:** never restart, reinstall or redeploy the live daemon on the Jetson to build or test this. Develop against a throwaway local daemon (`MIDNA_HOME=/tmp/… midna serve`); daemon changes reach the Jetson only in a release Justin schedules.

## Decisions at a glance

- **Transport:** the app keeps one outbound connection to the daemon: an SSE stream for commands, and POSTs for results. No port is opened on the Mac. It is the same auth, keepalive and reconnect pattern the app already uses, but on its own endpoint, never on `/v1/events`.
- **Where it runs:** in the app's Rust side, not the web view. It keeps working with the window closed (tray only) and is never throttled like a hidden WebKit view.
- **Protocol:** typed commands and results. Every command is signed by the daemon's own key, pinned by the device. Each command runs at most once and is never queued for an offline device. Screenshots and big files travel as attachments, which already exist.
- **Tools:** a fixed set of `device_*` MCP tools on midna's existing server. Each takes a device name.
- **Ask mode and the per-capability policy are enforced in the daemon,** not by the harness. Today's harness policy lets every `mcp__midna__*` tool through, so it can't be relied on.
- **Approvals block and wait.** A gated action shows Allow/Deny in the app on that machine and as a question in chat and Telegram. The first answer wins, and no answer within 2 minutes means no.
- **Justin's controls:**
  - each capability can be set Off, Ask or On, in the app;
  - Pause is in the window, the tray, behind a global shortcut, and in a daemon setting reachable from Telegram;
  - real input from Justin stops midna's input at once.
- **Audit:** every command, its decision (allowed, approved by whom, denied) and its outcome, in the daemon's database next to the existing `actions` log. The app also shows its own recent list.
- **macOS signing:** a stable self-signed identity, "midna local signing", in the login keychain. `app.ts` signs with it, so TCC grants survive every update.

## What exists today (and matters here)

- **Devices** (`packages/core/src/devices.ts`): pairing codes, hashed bearer tokens, revocation. The desktop app is already a `desktop` device with its own token. Hands reuse that device and that token: there's no second pairing.
- **Event stream:** `GET /v1/events` (SSE) carries chat events to every client, the Telegram bridge included, so hands commands must not ride on it. It sends a 25 s keepalive and `MidnaClient.events()` gives up after 60 s of silence.
- **MCP:** `/mcp/:episode`, opened by a per-run `mcpToken` that only the brain's sessions hold. Each request builds a fresh tool server bound to its episode. The `tool()` wrapper writes every call to `actions` (episode, tool, input, time) before running it.
- **Ask mode:** `brain.ts` denies host tools such as Bash in ask mode, but lets every `mcp__midna__*` tool through; the other harnesses allow `server === "midna"`. Device tools served there would skip ask mode unless they gate themselves, which is why the daemon gates them (Security, below).
- **Attachments:** `POST /v1/attachments` (any type, up to 100 MB) and `GET /v1/attachments/:id`, both behind the device token. Loose attachments are swept after 24 h, so a screenshot nobody sends cleans itself up.
- **The app:** Tauri 2 with a tray icon, a single instance, autostart, and the clipboard, notification and opener plugins. It stores its connection in `connection.json` in the app config folder, which Rust can read.
- **Signing:** builds today are ad hoc and linker-signed. The signature's identifier is `midna_desktop-<hash>`, not `sh.midna.desktop`, and its designated requirement is a cdhash, so every build looks like a new app to TCC.

## 1. Transport

The daemon is on the Jetson and the app is on the Mac, often behind NAT, reached over makima (sometimes its relay) or Tailscale. The app can already reach the daemon. The daemon can't reliably reach the app.

| Option | For | Against |
|---|---|---|
| **A. SSE down, POST up** (recommended) | Same stack the app and every client already use: bearer token, keepalive, reconnect with backoff. Works through anything that carries the chat stream today, and debuggable with curl. | Two directions on two requests. A result costs one extra HTTP request, which is noise next to the brain's thinking time. |
| B. WebSocket | One full-duplex connection with built-in ping. | New server wiring (Bun's `websocket` handler beside Hono) and a new client in Rust. Unproven through makima's relay. Gains little at a few commands per second. |
| C. Daemon connects to the app | Simple dispatch. | Needs an inbound port on the Mac: NAT, the macOS firewall prompt, and makima publishes anything listening to the whole mesh. Rejected. |
| D. midna SSHes into the Mac | No app work. | Processes started by sshd get sshd's TCC identity, not midna.app's, and can't see or drive the GUI session reliably. This is the problem the app solves. Rejected. |

**Recommended: A.** The endpoints, all behind the device token, are:

- `POST /v1/hands/hello` with a `HandsHello` (section 2). It answers `{ session, daemonKey }` and replaces any earlier session for this device.
- `GET /v1/hands/stream?session=…` (SSE): commands, cancels and acks, with a 25 s keepalive. The device treats 60 s of silence as a dead connection and reconnects with backoff, saying hello again.
- `POST /v1/hands/results/:commandId` with a `HandsResult`.
- `POST /v1/hands/state` on any change: paused, locked, a capability toggled, a permission granted.

The daemon keeps live sessions in memory, in a `HandsHub` inside the daemon process. MCP tool calls run in that same process (`handleMcp` is in-process), so a tool can await a device result directly with no extra plumbing. A device with no live session is **offline**: tools fail fast with when it was last seen. Commands are never queued for later, because acting on a stale intention is worse than failing.

The Rust side runs this as a tokio task started at launch whenever `connection.json` exists. It is independent of the window and the web view.

## 2. Capability protocol

The shapes are added to `packages/protocol` as Zod schemas, like everything else on the wire, and mirrored as serde types in the app's Rust. A shared JSON fixture test catches drift between the two.

```ts
type Capability = "screen" | "input" | "script" | "shell" | "files" | "clipboard" | "open" | "notify";
type Policy = "on" | "ask";                      // "off" = not offered at all
type DeviceState = "ready" | "paused" | "locked" | "display_asleep";
type Permission = "screen_recording" | "accessibility" | "automation" | "full_disk_access" | "notifications" | "local_network";
type PermissionState = "granted" | "denied" | "not_asked" | "needs_relaunch" | "n/a";

// device → daemon, on every (re)connect
interface HandsHello {
  protocol: 1;
  app: { version: string };
  os: { family: "macos" | "linux"; version: string; arch: string; hostname: string;
        session?: "quartz" | "x11" | "wayland"; desktop?: string };          // desktop: "GNOME", "Hyprland", …
  displays: Array<{ id: string; name: string; primary: boolean; x: number; y: number;
                    width: number; height: number; scale: number }>;         // points, global layout
  offers: Partial<Record<Capability, Policy>>;
  permissions: Partial<Record<Permission, PermissionState>>;
  automation?: Record<string, PermissionState>;                               // per target bundle id
  state: DeviceState;
  nonce: string;                                                              // fresh per connection
}

// daemon → device, one SSE event each
interface HandsCommand {
  id: string;            // "cmd_…"; the device runs an id at most once
  seq: number;           // strictly increasing within the session
  op: Op; args: object;
  timeoutMs: number;
  episodeId: number;     // for the app's activity list
  approval?: { by: string; at: number };   // present when a person approved it
  sig: string;           // ed25519 over canonical JSON of {nonce, seq, id, op, args, timeoutMs}
}
// also on the stream: { cancel: commandId }

// device → daemon
type HandsResult =
  | { id: string; ok: true; data: unknown; attachments?: string[]; ms: number }
  | { id: string; ok: false; ms: number;
      error: { code: "off" | "paused" | "locked" | "permission" | "user_active" | "timeout"
                     | "cancelled" | "unsupported" | "bad_args" | "failed";
               message: string; permission?: Permission } };
```

**Operations.** Each has a default timeout; the brain may lower it, or raise it up to the cap.

| Op | Args → result | Capability | Timeout (cap) |
|---|---|---|---|
| `screenshot` | `{display?, full?}` → attachment + `{width, height, display, scale, cursor}` | screen | 10 s |
| `click` / `move` / `drag` / `scroll` | `{x, y, display?, button?, count?}`, `{path}`, `{dx, dy}` → `{}` | input | 5 s |
| `type` / `key` | `{text}` / `{keys: "cmd+shift+4"}` → `{}` | input | 5 s per 200 chars |
| `script` | `{source, language: "applescript" \| "jxa"}` → `{result, stdout}` | script | 30 s (5 min) |
| `shell` | `{command, cwd?, env?}` → `{exit, stdout, stderr, truncated}`, long output as an attachment | shell | 60 s (10 min) |
| `file_read` / `file_list` | `{path, offset?, length?}` → text, or an attachment when binary or over 64 KB | files | 30 s |
| `file_write` | `{path, text \| attachmentId, mode: "create" \| "overwrite" \| "append"}` → `{bytes}` | files | 60 s |
| `clipboard_read` / `clipboard_write` | → `{text}` or an image attachment / `{text \| attachmentId}` | clipboard | 5 s |
| `open` | `{url \| app \| path}` → `{}` | open | 10 s |
| `notify` | `{title, body}` → `{}` | notify | 5 s |

**Coordinates.**
- Screenshots are scaled on the device so the long edge is at most 1568 px, the size models read best. `full: true` sends native resolution.
- Input takes coordinates in the pixel space of the latest screenshot of that display, and the device maps them to global points. midna never has to know about Retina scale or display layout.

**Large payloads reuse attachments.**
- **Screenshots:** the device uploads the PNG (`screenshot-<display>-<time>.png`) and returns its id. The daemon returns it to the brain as MCP image content, so the model sees it. Harnesses that can't take image results get a workspace path instead.
- **Sending one on:** midna sends a screenshot to Justin by passing the attachment id to `attach` / `message_user`, which learn to take `att_…` ids. One that is never sent is swept after 24 h.
- **Files:** `file_write` from an attachment covers anything big that midna moves onto the device; the device fetches it with `GET /v1/attachments/:id`.

**Failure semantics.**
- A daemon-side timeout sends `cancel`. The device kills the shell's process group, or stops sending input.
- A timed-out `shell`, `script` or `file_write` comes back to midna as "may or may not have run", never as "did not run".
- The device remembers recent command ids, so a resent command can't run twice.

## 3. The MCP tools

The tools go on midna's existing MCP server: `packages/agent/src/tools.ts`, through the same audited `tool()` wrapper. They reach the hub through a `hands` handle on `ToolContext`, an interface defined on the agent side and implemented by the daemon, so the agent never imports the daemon.

| Tool | Does |
|---|---|
| `device_list` | Every paired device that offers hands: name, OS, online/offline (last seen), state, each capability with its policy and what's missing ("screen: needs Screen Recording"), and its displays. |
| `device_screenshot` | `{device, display?, full?}` → the image, plus its size and the cursor position. |
| `device_click`, `device_move`, `device_drag`, `device_scroll` | Pointer input in screenshot coordinates. Each returns a fresh screenshot unless `then_screenshot: false`, which saves a round trip per step. |
| `device_type`, `device_key` | Keyboard input: text, or a chord like `cmd+space`. |
| `device_applescript` | AppleScript or JXA, e.g. reading or sending in Messages. macOS only. |
| `device_shell` | A shell command as the logged-in user (`zsh -lc` / `bash -lc`), in their home. |
| `device_file_read`, `device_file_list`, `device_file_write` | Files under home (section 4). |
| `device_clipboard_read`, `device_clipboard_write` | Text or an image. |
| `device_open` | A URL, an app, or a file in its default app. |
| `device_notify` | A system notification on that machine. |

- **Choosing a device:** `device` is a device's name or id. It may be left out when exactly one online device offers the capability.
- **Names:** a device's name is its pairing name, renamable in the app ("MacBook Air", "tenet"). The rename field keeps its draft like every other field.
- **The prompt:** a short section lists the devices online now and what each offers. It tells midna:
  - look before acting with GUI tools;
  - don't fight a user who is using the machine;
  - never type passwords unless Justin asked for exactly that;
  - an approval wait is normal in ask mode.

**Order inside every tool:**
1. The device exists and isn't revoked.
2. The global pause is off.
3. The device is online and its state allows the operation.
4. The capability is offered and its permission granted.
5. The policy and mode gate (section 4), which may wait for an approval.
6. Sign and send.
7. Await the result, or time out.
8. Record the outcome.

The first refusal is returned as text the brain can act on, e.g. "paused by Justin" or "MacBook Air is locked".

## 4. Security

**Only midna's daemon can drive a device.**
- **The device opens nothing.** It never listens on a port, registers no URL scheme that runs commands, and exposes no IPC command to its own web view that runs an operation. The web view can only read status, change toggles and pause.
- **Commands are signed.** The daemon keeps an Ed25519 key in `MIDNA_HOME`. The device pins its public key: at pairing for new devices, and on first hello for devices already paired, with the fingerprint shown in the app. Every command is signed over the connection's nonce and a strictly rising `seq`. A command from anyone else, or a replay from an earlier connection, is refused. This holds whatever the path: makima, its relay, Tailscale or a LAN, encrypted or not.
- **Only brain sessions can issue commands.** Commands come only from MCP tool calls, which need the per-run `mcpToken`. No `/v1` route lets a client issue one, so the Telegram bridge's token can't drive the Mac. A revoked device is disconnected at once.

**Per-capability toggles.**
- Each capability is Off, Ask or On, set in the app on that machine. Only the device can turn on what it offers; midna can't.
- Suggested defaults, a fork for midna: screen, notify and open On; input, script, files, clipboard and shell Ask.
- Each capability also lists the permissions it needs, and is reported unavailable until they're granted.

**Ask mode and policy.** Operations are either *observe* (screenshot, file read/list, clipboard read) or *act* (everything else; `notify` counts as harmless).

| Policy | autonomous | ask mode |
|---|---|---|
| Off | refused | refused |
| Ask | approval each time | approval each time |
| On | runs | observe runs; act needs approval |

This matches today's ask-mode promise ("read anything, ask before acting"). Whether screenshots and clipboard reads should count as observe is a fork.

**Approvals.**
- **What it is:** a pending approval names the device, the operation and a plain summary ("run `brew upgrade` on MacBook Air", "type 42 characters into Messages").
- **Where it shows:**
  - on that device, as a non-activating Allow / Allow for 10 min / Deny panel plus a notification with the same actions;
  - in every client, as a question: in chat, and as buttons in Telegram, so Justin can approve from his phone.
- **How it resolves:**
  - the first answer wins, and every other prompt closes;
  - "Allow for 10 min" covers the same capability on the same device, so a click-and-type loop doesn't ask at every step;
  - no answer within 2 minutes is a denial.
- **The brain waits.** The tool call simply waits for the answer; nothing has to be retried on a later turn. `brain.ts` must set the harness's MCP tool timeout (Claude Code: `MCP_TOOL_TIMEOUT`) above the approval window.
- **New pieces:**
  - a `{type: "approval"}` stream event and `POST /v1/approvals/:id`, so an answer never reaches the brain as a new chat message;
  - an `approvals` table holding who answered, from which client, and when.
- **Later:** the same mechanism could later replace ask mode's deny-and-retry for the brain's own Bash.

**Kill switch and pause.**
- **Pause:** in the app window, in the tray menu, and behind a global shortcut (⌃⌥⌘P, a registered hotkey, so it needs no Input Monitoring permission).
- **While paused:** every command is refused, including screenshots. The command in flight is cancelled: its process group killed, its input stopped. Pause survives an app restart until Justin resumes.
- **Remote pause:** a daemon setting, `hands: "on" | "paused"`, set through `PATCH /v1/settings` from any client, stops every device at once. Justin can do it from Telegram when the Mac is out of reach.
- **Justin takes over:** before each synthetic input event, the device compares the system's idle time (HIDIdleTime, readable without Input Monitoring) with its own last injection. Input it didn't inject means Justin is using the machine. The command stops with `user_active`, and input pauses for 30 s.

**Files.**
- Paths resolve through symlinks and must stay inside home.
- Always refused: `~/.ssh`, `~/.gnupg`, `~/Library/Keychains`, and the app's own config (its token).
- Whether to allow more of the disk than home is a fork.

**The audit log.**
- **What's recorded:** the `tool()` wrapper already writes each call to `actions`. A new `device_commands` table (append-only migration) adds:
  - the command id, episode, device and operation;
  - its arguments, with `type` text marked secret redacted;
  - the decision: allowed by policy, approved by whom from which client, denied, or refused, with the reason;
  - start and end times;
  - the outcome, with a summary capped at 4 KB, the exit code and any attachment ids.
- **Who can read it:** a `GET /v1/devices/:id/commands` route. The app's "This computer" screen shows the same list for its own machine, even when the host is unreachable, from a local copy of the last 200.

**Locked, asleep, quit.**
- **Screen locked:** checked with `CGSessionCopyCurrentDictionary` → `CGSSessionScreenIsLocked`, and logind `LockedHint` on Linux. The state goes to `locked`. Screen, input and script refuse with "locked", rather than capturing the lock screen or typing into the login window. Shell, files, clipboard, open and notify still work, since the session is alive.
- **Display asleep:** the state goes to `display_asleep`. A screenshot wakes it only if midna passes `wake: true`, via a user-activity power assertion.
- **System asleep, app quit, or no network:** the stream drops and the device is offline; tools say so with when it was last seen. Nothing is queued for later.
- **Long commands:** while one runs, the app holds a prevent-idle-sleep power assertion, so a long `shell` isn't cut off by idle sleep.
- **Keeping the app up:** "Open at login" already exists. The Permissions screen points it out when hands are on.

## 5. macOS code signing

**Why grants get lost.** TCC stores each grant with the app's **designated requirement** (DR). An ad-hoc signature's DR is its cdhash, which changes on every build. The old grant then still shows as on in System Settings, but no longer matches the new build: it's granted, yet nothing works, until it's reset.

**The fix.** A certificate-based DR reads:

```
identifier "sh.midna.desktop" and certificate root = H"<sha1 of our cert>"
```

Every build signed with the same certificate satisfies it, so grants survive updates and reinstalls into `~/Applications`. A self-signed certificate is enough for this; it doesn't need Apple's chain.

**Create the identity once per Mac.** `clients/desktop/scripts/codesign-setup.ts` would wrap these commands:

```sh
NAME="midna local signing"
/usr/bin/openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout midna-signing.key -out midna-signing.crt -subj "/CN=$NAME" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning"
/usr/bin/openssl pkcs12 -export -inkey midna-signing.key -in midna-signing.crt \
  -name "$NAME" -out midna-signing.p12 -passout pass:midna     # Homebrew OpenSSL 3: add -legacy
security import midna-signing.p12 -k ~/Library/Keychains/login.keychain-db -P midna -T /usr/bin/codesign
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db midna-signing.crt
security find-identity -v -p codesigning       # must list "midna local signing"
```

- **`-T /usr/bin/codesign`:** lets codesign use the key without a keychain prompt on every build.
- **`add-trusted-cert`:** asks for Justin's password once.
- **The key:** never commit it. Keep the `.p12` in his password manager. If it's lost, a new identity means re-granting once.

**How `app.ts` signs.**
- **Choosing the identity:**
  - if `security find-identity -v -p codesigning` lists the identity, `app.ts` runs `tauri build` with `APPLE_SIGNING_IDENTITY="midna local signing"`;
  - if not, it builds ad hoc as today and warns loudly that permissions won't survive this build.
- **What the bundler signs:** the app and its `midna` sidecar, with hardened runtime on.
- **New files:**
  - `src-tauri/entitlements.plist` with `com.apple.security.automation.apple-events`, which hardened runtime needs to send Apple Events;
  - `src-tauri/Info.plist`, which Tauri merges into the bundle, carrying the usage strings: `NSAppleEventsUsageDescription`, `NSLocalNetworkUsageDescription`, and the Desktop, Documents and Downloads folder strings. Without a usage string, macOS refuses those requests silently.
- **Check after a build:** `codesign -d -r- ~/Applications/midna.app` must show the identifier `sh.midna.desktop` and the certificate root.
- **Once, when switching from ad hoc:** `tccutil reset All sh.midna.desktop` clears the stale grants, then Justin grants each permission once.
- **Exit test for this phase:** grant the permissions, build twice, and confirm every grant still works.

**Not covered:** a self-signed app isn't trusted on other Macs, and can't be notarized. Both are fine for Justin's own machines; Developer ID is the fork if that changes.

**macOS 15+ caveat:** Screen Recording is periodically re-confirmed (a monthly "continue to allow?" prompt) for apps that capture without the system picker. midna can't answer it; the app notices the permission dropping and tells Justin.

## 6. Permissions screen

The app gets a new **"This computer"** screen next to Settings:
- each capability, with its toggle and the permissions it needs;
- each permission's live status;
- Pause;
- the recent activity list.

**Status is checked live.** Rust checks every permission every 2 s while the screen is visible and whenever the window gains focus, and sends any change to the daemon as device state, so `device_list` is always current. Each row shows granted / not asked / denied / needs relaunch, with **Ask** (where an API prompts) and **Open System Settings** buttons.

| Permission | Needed for | Live status | Ask | Opens |
|---|---|---|---|---|
| Screen Recording | screen | `CGPreflightScreenCaptureAccess()`; true only after a relaunch, hence "Relaunch midna" | `CGRequestScreenCaptureAccess()` | `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` |
| Accessibility | input; UI scripting via System Events | `AXIsProcessTrusted()` | `AXIsProcessTrustedWithOptions(prompt: true)` | `…security?Privacy_Accessibility` |
| Automation, per app: Messages, System Events, Finder | script | `AEDeterminePermissionToAutomateTarget(bundleId, ask: false)`: 0 granted, −1743 denied, −1744 not asked, −600 app not running | the same with `ask: true`, after launching the target hidden | `…security?Privacy_Automation` |
| Full Disk Access | files outside the user folders; Messages' `chat.db`; Mail | no API: probe-read `~/Library/Application Support/com.apple.TCC/TCC.db` (EPERM = not granted) | none; Justin adds midna.app | `…security?Privacy_AllFiles` |
| Notifications | notify; approval prompts | `UNUserNotificationCenter` settings | `requestAuthorization` | `x-apple.systempreferences:com.apple.preference.notifications?id=sh.midna.desktop` |
| Local Network | only when the daemon is reached on a LAN address (makima's and Tailscale's tunnels don't need it) | result of connecting | the first connection prompts | `…security?Privacy_LocalNetwork` |

- **Input Monitoring isn't needed:** posting events needs only Accessibility, and nothing reads keystrokes.
- **Child processes run under the app's grants:** anything the app spawns (`osascript`, `screencapture`, the user's shell) is attributed to midna.app. Full Disk Access granted to the app therefore covers `sqlite3 ~/Library/Messages/chat.db` run through `device_shell`.
- **Before building:** check the deep links on macOS 26, since anchors move between releases.
- **Linux:** the same screen becomes a readiness list (section 8).

## 7. Activity indicator

midna's control must be visible even when the window is hidden, which is most of the time.

- **Tray:** while a command runs, and for 3 s after, the tray icon switches to an "active" variant of the helmet. The tray menu leads with "midna is using this Mac: clicking in Safari" and **Pause**.
- **Window:** a strip above the chat, in the same place as the "can't reach" banner, says the same with Pause. The "This computer" screen lists what was done.
- **Overlay, during GUI operations** (screen, input, script): a small pill at the top centre of the active display, "midna is using this Mac · Pause". It is:
  - a non-activating, always-on-top panel that ignores clicks except on Pause;
  - excluded from midna's own screenshots: on macOS, its window sharing type is set to none (verify on macOS 26; otherwise hide it for the instant of capture).
- **macOS's own indicator:** macOS shows its screen-capture indicator by itself while capturing.
- **Other clients:** the chat stream's existing `activity` event names the tool, so Telegram and the other clients can show "using MacBook Air" too.

## 8. Linux: tenet

The protocol, tools, policy, approvals and audit are OS-agnostic. Only the backends differ. In Rust, the capability layer is a set of traits, `Screen`, `Input`, `Script`, `Shell`, `Files`, `Clipboard`, `Launcher`, `Notifier` and `Session` (lock state, idle time), with a backend per OS and session. The device advertises only what its backends can do.

| Capability | X11 | Wayland: GNOME / KDE | Wayland: wlroots (Hyprland, sway) |
|---|---|---|---|
| screen | XGetImage (e.g. the `xcap` crate) | ScreenCast portal + PipeWire, `persist_mode = 2`, so one consent is kept as a restore token | wlr-screencopy (`grim`) |
| input | XTest | RemoteDesktop portal + libei (GNOME 46+, KDE 6.1+), with a restore token | virtual-pointer / virtual-keyboard protocols; `ydotool` (uinput) as a fallback |
| script | not offered (D-Bus scripting could come later) | same | same |
| shell, files | the same code as macOS | same | same |
| clipboard | the clipboard plugin (arboard) | arboard with Wayland data-control | same |
| open, notify | `xdg-open`, org.freedesktop.Notifications | same | same |
| lock and idle | logind `LockedHint`, ScreenSaver idle time | same | same |

- **No TCC.** The Permissions screen becomes a readiness list: session type, portals present, restore tokens held, `/dev/uinput` writable where `ydotool` is used, and a tray (StatusNotifierItem) available.
- **Overlay:** a layer-shell surface on wlroots and KDE; elsewhere a persistent notification with a Pause action.
- **No signing:** the AppImage that `app.ts` already builds is enough.
- **The open question:** whether tenet runs X11 or Wayland, and which compositor. That decides which column is built first.

## 9. Where the code goes

| Layer | Changes |
|---|---|
| Protocol | Hands schemas (hello, state, command, result, approval); approval and device-command calls on `MidnaClient`; the `approval` stream event; `hands` in `SettingsPatch` |
| Core | Append-only migrations: a hands snapshot per device (last hello and pinned-key fingerprint), `device_commands`, `approvals`; the `hands` setting |
| Daemon | `HandsHub`: sessions, signing, dispatch, timeouts, cancel, policy and mode gate, approvals. Routes `/v1/hands/*` and `/v1/approvals/*`. The daemon key in `MIDNA_HOME` |
| Assistant | The `device_*` tools through `ToolContext.hands`; the prompt section; returning images from tools; `attach` taking `att_…` ids; the MCP tool timeout |
| Clients: desktop | The Rust `hands` module (connection, executor, backends, permissions, pause, overlay, local activity log); the "This computer" screen and tray menu; `codesign-setup.ts`; signing in `app.ts`; `entitlements.plist`, `Info.plist` |
| Clients: Telegram | Approval buttons |

## 10. Phasing

Each phase is its own release. Each is built and tested against a local throwaway daemon and the installed app, and reaches the Jetson only when Justin schedules the rollout.

0. **Groundwork, with no remote control yet.** The signing identity and `app.ts` signing; entitlements and usage strings; the "This computer" screen with live permission status and deep links; a one-time `tccutil` reset. Exit: Justin grants once, two rebuilds later everything is still granted.
1. **The channel and eyes.**
   - The protocol, `HandsHub` and signed commands.
   - Hello and state reporting, `device_list`, `device_screenshot`, `device_open`, `device_notify`.
   - Toggles, both pauses, the indicator (tray, window, overlay), the locked and asleep states, and the audit table.
   - macOS only.
2. **Hands.** Pointer and keyboard tools with screenshot-space coordinates and screenshot-after, stopping when Justin takes over, and approvals end to end (device panel, chat, Telegram).
3. **Reach.** AppleScript and JXA with Automation status per app; clipboard; files under home; shell as the user, with process-group kill, output caps and long output as attachments.
4. **tenet.** The Linux backends for its session, the readiness screen, and the tray and overlay.

## 11. Forks that need midna's call

1. **Approvals.** Block and wait, approvable from the device, chat and Telegram, first answer wins (recommended). Or keep today's ask-mode pattern: deny, then ask, then retry on a later turn. Also: may remote approval (Telegram) approve shell and input on the Mac, or only someone at the machine?
2. **Defaults and what counts as observing.** Which capabilities start On / Ask / Off. Whether screenshots, file reads and clipboard reads run in ask mode as "reading", or need approval like acting.
3. **Transport.** SSE plus POST (recommended: reuses what works today) or WebSocket (one duplex connection, new server and client code).
4. **Tool shape.** A fixed set of daemon-defined `device_*` tools (recommended: one audit and gating path, stable descriptions). Or devices advertise their own MCP tools, tunnelled through the daemon (more flexible, much harder to gate and audit).
5. **File reach.** Home only, minus the deny list (recommended), or anything Full Disk Access allows.
6. **Signing identity.** A self-signed identity per Mac now (free, re-grant once if the key is lost). Or an Apple Developer ID now (paid; notarized, works on any Mac). Switching later costs one round of re-granting.

Not a fork but needed before phase 4: tenet's display session (X11 or Wayland, and the compositor).
