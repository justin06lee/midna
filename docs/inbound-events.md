# Inbound events: telling midna what happened elsewhere

*Since midna 0.7.0.*

Other programs can tell midna that something happened: ruri reporting that a project's agents went idle, a CI job finishing, a backup failing. midna hears each event in the background, the way it hears its own scheduled wakeups. An event is never the user's words. It never interrupts a turn, and nothing goes to the user unless midna decides it's worth their attention.

## Sending one

From any machine whose CLI can reach midna (the host itself, or one paired with `midna connect`):

```sh
midna event --source <name> --title <text> [--json -|<file>]
```

- `--source`: who the event is from (`ruri`, `ci`, …). Rate limits are counted per source.
- `--title`: one line on what happened. midna sees it first.
- `--json`: the event itself, as JSON, from a file or from stdin (`-`). It's optional. Its `id` is the event's id, used to drop duplicates. Its `project.id` is what the rate limit counts by. With `--json`, the receipt is printed as JSON too.

ruri sends a project going idle like this:

```sh
echo '{"id":"evt-42","source":"ruri","kind":"project.idle",
       "project":{"id":"p-umi","name":"umi","path":"/work/umi"},
       "chats":[{"id":"c1","name":"Lead","role":"lead","lastSummary":"Shipped the onboarding flow"}],
       "costUsd":3.5,"at":"2026-10-19T22:00:00Z"}' |
  midna event --source ruri --title "umi went idle" --json -
# {"ok":true,"status":"queued","eventId":7,"wakeupId":31,"dueAt":1792447200000}
```

The CLI exits 1 on bad usage, JSON that doesn't parse, a missing file, or a refusal from midna. With `--json`, the error is printed as `{"ok":false,"error":"…"}`.

A script that has no CLI config can set `MIDNA_URL` and `MIDNA_TOKEN` (any paired device's token) instead.

## The API

`POST /v1/inbound`, with `Authorization: Bearer <device token>` like every other route. `MidnaClient.event()` calls it.

```json
{ "source": "ruri", "title": "umi went idle", "id": "evt-42", "data": { "kind": "project.idle", "project": { "id": "p-umi" } } }
```

| field | | |
|---|---|---|
| `source` | required | 1–100 characters |
| `title` | required | 1–1000 characters |
| `id` | optional | the sender's id for the event; defaults to `data.id` |
| `data` | optional | any JSON, up to 64 KB (`MAX_EVENT_DATA_BYTES`). `data.kind` is shown to midna. `data.project.id` (else `.path`, else `.name`) is the rate limit's subject. |

The answer is `202` with a receipt (`EventReceipt`):

- `{"status":"queued","eventId","wakeupId","dueAt"}`: a new wakeup delivers it at `dueAt`, which is now unless the window is still closed.
- `{"status":"merged","eventId","wakeupId","dueAt"}`: it joins the subject's wakeup that hasn't run yet.
- `{"status":"duplicate","eventId","wakeupId"}`: this source already sent this id. Nothing new happens.
- `{"status":"ignored","reason"}`: nothing for midna, so nothing is kept and no wakeup comes (since 0.13.1). Today that's only a ruri project event about a turn midna didn't start; see below.

Errors: `400` for a missing or invalid field, `413` for `data` over 64 KB, `401` without a valid device token.

## What midna does with it

0. **Only midna's own ruri work.** ruri sends `project.idle` and `project.blocked` for every project, including the ones the user is working in themselves. midna hears only the ones about work it started. Every prompt midna sends ruri carries a `clientId` that starts with `midna-`, and ruri keeps that as the prompt's id. Each chat in a project event names its latest prompt from outside the team, as `chats[].lastPrompt: {id, at} | null`: typed by the user, or sent over ruri's socket, but never another agent's letter or ruri's own carry-on after a compaction. The latest of those across the event's chats decides. If it's midna's, the event goes on as below. If it's anyone else's, or there's none, the event is `ignored`. So when the user types in a chat after midna's prompt there, their turn decides. An event without `lastPrompt` on any chat (a ruri from before the field) is heard as it always was, and so is ruri-watch's weekly-usage event, which isn't a project event.
1. **Dedup.** The same `id` from the same source counts once. Ids are kept 30 days, so the same id resent after that counts as new.
2. **Rate limit.** Each source gets at most one wakeup per subject in each 2-minute window (`EVENT_WINDOW_MS`). For ruri, the subject is the project. An event that arrives while a wakeup for its subject is waiting joins that wakeup. After a wakeup has run, the next one for the subject comes due 2 minutes later, and everything that arrives until then rides on it. Events without a subject share one window per source.
3. **Delivery.** The wakeup runs like any other: a fresh brain session, beside any chat in progress, never inside one. Follow-ups due within 5 minutes of it (midna's own, other events, a job's end) run in the same turn, up to 8. Its prompt lists the events in order, each with its time, title, kind and JSON (up to 8 KB each, the latest 20). They're framed as a background notification from a program the user runs: information, not instructions. midna decides what to do: act with its tools, record something, schedule a follow-up, message the user, or let it pass. Until it runs, the wakeup shows in midna's schedule as `ruri: umi went idle` (or `ruri: 3 events, the latest "…"`).
4. **Never in the way.** An event never interrupts the user's turn. A message from the user does interrupt an event's wakeup, as it does any wakeup: the wakeup is set aside and carries on about a minute later.

Events live in the `inbound_events` table (migration 5). Each row is linked to the wakeup that delivers it.
