# Component library

Every piece of this project's interface ruri has on file: the user's own
name for it, its handle, its files, and a picture. When the user names
something here, this is what they mean — go straight to its files rather
than searching for their words. Before building interface, look here
first and reuse what exists: `ruri show <slug>` reads one with its code,
`ruri add <slug>` copies it into place, `ruri help` says the rest.

ruri maintains this file. Don't edit it by hand; it is rewritten whenever
the library changes.

## machine-picker — the machine picker
First screen when the app isn't connected: "Where should midna live?" — this computer plus makima/Tailscale machines (via `midna devices --json`), best home first, one click to Connect / Set up here; the start-with options (brain, timezone, mode) fold underneath.
Its files: clients/desktop/src/screens/Welcome.tsx
Reaches into: clients/desktop/src/host.ts, clients/desktop/src/ui.tsx
Tags: onboarding, device list, hosting
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/56d7f451-0ed1-4a39-8fbe-7fbb7fd30ea3-shot-17.png

## setup-steps — the setup steps
Setting up / connecting to a machine: five steps (reach, put midna on it, check its brain, start, pair) streamed from `midna host install --json`, with upload progress and a failure card that offers the fix (e.g. a terminal to sign in there) and Try again.
Its files: clients/desktop/src/screens/Install.tsx
Reaches into: clients/desktop/src/host.ts, clients/desktop/src/ui.tsx
Tags: onboarding, progress, hosting
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/706906ab-a82b-47bd-83d0-542a74ba54c1-mcp-bridge-blob-1790903593639-4fodao.png

## chat — the chat
The conversation with midna: user bubbles, midna's replies as safe markdown, notes/urgent/fyi with a left rule, questions with tappable answers (greyed once answered), day separators, the thinking/using-tool line, and the composer. Pages older history on scroll-up.
Its files: clients/desktop/src/screens/Chat.tsx, clients/desktop/src/markdown.tsx
Reaches into: clients/desktop/src/useMidna.ts, clients/desktop/src/style.css
Tags: chat, messages, composer
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/61d628e5-b091-46a4-8501-590acac4c911-shot-25.png

## today-view — the today view
The day at a glance from /v1/overview: today and tomorrow's calendar, what's due (overdue in bold), promises both ways, and what midna will do on its own (its wakeups and its own tasks).
Its files: clients/desktop/src/screens/Today.tsx
Reaches into: clients/desktop/src/ui.tsx
Tags: dashboard, agenda
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/656133a5-121c-4551-baa2-a50ae53ae1ce-shot-13.png

## objectives-view — the objectives view
The goal tree by horizon (life → week) with why / done-when, the tasks under each goal, and tasks that serve no goal. Read-only on purpose; "Review with midna" drops a prompt into the chat.
Its files: clients/desktop/src/screens/Objectives.tsx
Reaches into: clients/desktop/src/ui.tsx
Tags: goals, dashboard
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/1afd63ca-6321-44a8-8300-d8ffb9e3c0d5-shot-27.png

## settings — the settings
Brain (model + health + sign-in/check), how midna acts (on its own / ask first), timezone and quiet hours, your phone (Telegram connect via the bridge API), open at login, and where midna lives with paired devices.
Its files: clients/desktop/src/screens/Settings.tsx
Reaches into: clients/desktop/src/host.ts, clients/desktop/src/ui.tsx
Tags: settings, telegram, devices
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/62aa612b-cccb-4c1a-af98-5279ab97cd5d-shot-15.png

## main-window — the main window
The connected shell: sidebar (crescent, "on <host>", Chat/Today/Objectives/Settings with ⌘1–3/⌘,, connection + brain state at the bottom) and the "midna can't think right now" banner with Sign in on <host> / Check again.
Its files: clients/desktop/src/screens/Main.tsx, clients/desktop/src/Boundary.tsx
Reaches into: clients/desktop/src/useMidna.ts, clients/desktop/src/App.tsx
Tags: shell, sidebar, banner
Screenshot (read it if you need to see it): /tmp/ruri-ab-all/config/uploads/705071ff-2973-46b3-8b90-6abdb8078b53-shot-11.png
