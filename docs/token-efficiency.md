# midna's token efficiency: the plan

Justin's brief: make midna token-efficient at the root, in this codebase, without side scripts. Items 1–3 are in 0.11.0, cut and not yet rolled out. Item 5 is built on master, after the tag. Item 4 is on hold.

## The baseline

Measured read-only against the live `midna.db` on the Jetson (0.10.1), over the 24 hours to 2026-10-22 15:10 PDT. Every turn ran on `claude:opus` (Opus 5.5: $4 in / $20 out per million tokens; cache writes $8 (1 h), cache reads $0.20).

| | turns | real cost | per turn |
|---|---|---|---|
| wakeups | 193 | **$65.07** | $0.34 |
| chat | 72 | **$14.82** | $0.21 |
| total | 265 | **$79.90** | |

- **`episodes.cost_usd` overcounts.** Claude Code reports a session's running total, not the turn's own cost. The probe below confirms it, and summing the column gives $295.11 (chat alone $230.04, 15× its real cost). The "real" figures above are each turn's increase over the previous total recorded in its session. `midna status`'s `spendLast7DaysUsd` sums the raw column, so it is wrong too.
  - **Probe (tenet, Haiku, five turns across two interleaved sessions, each turn a fresh process like midna's):** `total_cost_usd` and `modelUsage` carry on from the session's earlier turns; `usage` counts only the turn itself.
- **The last 7 days, real cost per 24 h, oldest first:**
  - chat: $2.04, $20.41, $8.41, $2.46, $12.94, $31.63, $14.82
  - wakeups: $11.48, $18.09, $18.28, $14.86, $19.85, $52.55, $65.07
- **What the wakeups were:**

  | origin | turns | cost | sent the user anything |
  |---|---|---|---|
  | midna's own follow-ups that check on a team, a project or progress | 117 | $38.94 | 32 |
  | midna's other follow-ups | 23 | $9.15 | 5 |
  | ruri events (`project.idle` 46, `project.blocked` 17) | 63 | $15.47 | 10 |
  | rituals | 2 | $1.15 | 2 |
  | a job's end | 1 | $0.35 | 1 |
  | reminders (no brain turn) | 11 | $0 | — |

  Three wakeup turns in four sent the user nothing.
- **Bunching:** 97 of the 185 wakeups that fired came within 5 minutes of the one before.
- **Repeats:** 59 follow-ups repeat an earlier one's opening, digits aside. The top repeats are "ruri: mira is idle" (10×), cobalt (8×) and ucscmsa.com (8×).
- **Failures:** 35 turns ended in an error.
  - 21 were interrupted by Justin's messages.
  - 14 hit Claude's usage limits: the 5-hour session limit 9 times, the weekly limit 5 times.
- **Why a wakeup costs more than a chat turn while doing less:**
  - each wakeup starts a fresh brain session, so its whole prefix (tools, system prompt, working context) is written to the cache at twice the input price;
  - a chat turn resumes a warm session and mostly reads the cache.

  This is likely but unmeasured until item 1 stores tokens per turn.
- **ruri already pushes events.** ruri itself posts `project.idle` and `project.blocked` to `POST /v1/inbound`, with each chat's last summary. midna's stopgap `workspace/scripts/ruri-watch.py` (the `ruri-watch.timer` user timer, every 3 min) adds permission requests and usage thresholds. Polling persists anyway, because midna isn't told it can rely on the events.

## The items

### 1. Honest cost accounting (built now)

- **Migration 10:**
  - `episodes.cost_usd` becomes the turn's own cost;
  - a new `session_cost_usd` keeps the running total as reported;
  - new per-turn token columns: input, cache read, cache write, output.

  The migration backfills old rows the same way, from each session's running totals, so history is honest too.
- **At the end of a turn:** the brain reports the session's running total. Core subtracts the previous total recorded in that session. If the total ever drops, the session started counting afresh, and the turn's cost is the total itself.
- **`midna status` and `GET /v1/status`:**
  - spend today by kind: chat, follow-up, event, job, ritual;
  - the last 7 days, one figure per day.
- **Saves:** nothing by itself. It makes every number after it true, and status stops reporting about 3.7× the real spend.

### 2. Events instead of polling (changed after ruri's answer)

The brief asked for a ruri bridge on the Jetson that subscribes to ruri's WebSocket. ruri's team answered with these facts, from ruri master `f6e58cc`:

- **ruri already pushes the events.** Since v0.77 (2026-10-19) its hooks run `midna event --source ruri` → `POST /v1/inbound`:
  - `project.idle`, with each finished chat's last reply in `chats[].lastSummary` (about 600 characters);
  - `project.blocked`, 15 s after a chat starts waiting: "Asks: …", "Waiting on approval: …" or "Stopped on an error: …".

  Each event carries a stable `data.id`, which midna de-duplicates on. These are the 63 `event:ruri` wakeups in the baseline.
- **The WebSocket can't be reached from the Jetson.** It is bound to the Mac's loopback, with a token regenerated at every launch.
- **The only door from another machine needs a full-access key.** That is the devices door: TLS on 7775, open only while sharing is on. Its key can answer ruri's permission cards. On the Jetson, midna's brain shares the bridge's Unix user and could read it.
- **The read-only route isn't on master.** `/status` and `/status/live` with a status-scoped key sit on the unmerged `feat/mobile-status` branch, and merging it is Justin's call. It carries no usage either.
- **Weekly usage has no event anywhere.** The socket reports the percentage every 5 min, with no threshold event.

So a WebSocket bridge would duplicate idle and blocked, and would put a key that can approve ruri's actions where the brain can read it. That isn't built. What is built:

- **The system prompt** tells midna that ruri reports idle and blocked on its own, and that a job reports its end, so it doesn't schedule "is it done yet" checks.

**Open, for midna:**

- **Retire `ruri-watch.py`'s idle and permission parts now.** They duplicate ruri's hooks, under ids that don't match, so midna hears each idle twice. Only the usage thresholds have no other source.
- **Usage thresholds:** the clean fix is in ruri, a hook event such as `usage.weekly` when weekly usage crosses 70, 78 or 80%, sent like idle. ruri's liaison offered to take it to its team. Until then the stopgap keeps only that part.

**Saves:** the 117 progress checks ($39/day) go once midna stops scheduling them. Expected −$20 to −$30/day, as before.

### 3. Guardrails on wakeups (built now)

- **Coalescing:**
  - When a follow-up comes due, other follow-ups due within the next 5 minutes join it, and they run as one turn: event, job-end and midna's own follow-ups, at most 8.
  - The prompt lists each with the time it was set for.
  - Rituals, reminders and system upkeep keep running alone.
  - A set-aside or failed group retries as a group.
- **De-duplication:** `schedule_wakeup` doesn't add a follow-up that's nearly the same as a pending one due within an hour of it. It answers with the existing one's id and time instead.
- **A daily budget:**
  - a setting, default 60 wakeup turns or $20 a day, whichever comes first;
  - past it, every wakeup prompt and every `schedule_wakeup` answer says how far over midna is, and asks it to fold checks together and rely on events;
  - `midna status` shows today against the budget;
  - it warns and never blocks;
  - reminders stay free and outside it.
- **Saves:** coalescing pays the fresh session's cache write once for the whole group. With half of the wakeups bunched, expect 40–50% fewer wakeup turns, −$10 to −$20/day. De-duplication covers part of the 59 repeats.

### 4. A model per wakeup or job (after midna's review)

- `schedule_wakeup` and `job_start` (for `claude -p` jobs) can name a cheaper model, `claude:sonnet` or `claude:haiku`, for routine runs. Chat with Justin stays on Opus.
- **Prices:** Sonnet 5.5 is half Opus 5.5's input and output price, with the same cache read price. Haiku 5.5 is about a fortieth of Opus.
- **Saves:** moving half of what's left of the wakeup spend to Sonnet saves −$5 to −$10/day. Caches are per model, so a cheaper model pays its own cache writes.

### 5. A cache-stable prompt (built after the 0.11.0 tag)

- **The system prompt is byte for byte the same every turn:** who midna is, its rules, the environment, the hands guide once any computer offers its hands, and the pinned facts (they never fade or reorder). A daemon test holds it to that across turns whose state changes.
- **The state ends each turn's prompt instead:** the clock, then the working context's sections (objectives, calendar, tasks, commitments, wakeups, decisions due, people to reconnect with, the strongest unpinned memories, the user's computers).
  - A new session gets every section with something in it.
  - A session carrying on gets only the sections that changed since its last finished turn, so its transcript doesn't fill with copies. What each session last saw is kept in memory; after a restart, a session gets the whole state again.
- **Found while measuring:** Claude Code keeps a resumed session's first system prompt and drops the one passed with later turns. Every request in a resumed session carries the same system prompt hash.
  - So in 0.11.0 and before, a resumed chat saw the working context as it was at the session's first turn, up to 40 turns or 4 idle hours old. A task added mid-session never reached it.
  - The same holds now for the static part: a change to the pinned facts or the mode text reaches a chat session when it starts over. The state's clock line carries the current mode every turn.
- **Not built:** trimming tool output and rolling the chat session over with a summary.

**Measured on tenet, Haiku 5.5, a throwaway daemon, the same scripted runs before (v0.11.0) and after.** Cache-read ratio = cache read ÷ (input + cache read + cache write).

| turn | before: read / write | ratio | after: read / write | ratio |
|---|---|---|---|---|
| chat, fresh session | 24432 / 8724 | 0.737 | 24432 / 8858 | 0.734 |
| chat, resumed after the state changed | 27737 / 6303 | 0.815 | 27871 / 5840 | 0.827 |
| wakeup, fresh (wrote a file) | 55715 / 9299 | 0.857 | 27063 / 4354 | 0.861 |
| wakeup, fresh, after the state changed | 24432 / 6916 | 0.779 | 27063 / 4419 | 0.860 |

Four chat turns in one session, 20 s apart, the state changed before the fourth:

| turn | before: write | ratio | after: write | ratio |
|---|---|---|---|---|
| 1, fresh | 8810 | 0.867 (two requests) | 6227 | 0.813 |
| 2 | 885 | 0.974 | 273 | 0.992 |
| 3 | 1975 | 0.945 | 241 | 0.993 |
| 4, state changed | 151 | 0.996 | 1127 | 0.968 |

- **Fresh sessions read midna's static system prompt from the cache** (2631 tokens here: 27063 against 24432) instead of writing it. A single-request wakeup wrote 36% less and cost 22% less.
- **Resumed chat turns read their whole history either way.** Before, that was because Claude Code froze the system prompt. Now each turn adds its state changes: a few hundred tokens, about a thousand when tasks or wakeups change. Before, turns 2 and 3 also carried Claude Code's own tool-list changes, which is noise.
- **Saves, on Opus:** each fresh session stops writing about 3k tokens: the static prompt, the hands guide and the pinned facts. At 1-hour cache-write prices that's about $0.02 per wakeup or new chat session, $2–4/day at the baseline's wakeup count and less after item 3. This is far below the 30–50% guessed here before measuring. The larger gain is that a resumed chat now sees the current state.

## Before and after

The "after" numbers can only come from the live database after a rollout. To compare them with the baseline:

- `midna status`: the spend lines (today by kind, last 7 days) and the wakeup budget line.
- **In SQL, read-only:**
  ```sql
  -- real spend and turns, last 24 h, by kind (after migration 10, cost_usd is per turn)
  SELECT kind, COUNT(*), ROUND(SUM(cost_usd), 2) FROM episodes
  WHERE started_at >= (strftime('%s','now') - 86400) * 1000 GROUP BY kind;
  -- wakeups by origin, last 24 h
  SELECT CASE WHEN created_by LIKE 'event:%' THEN created_by WHEN created_by LIKE 'job:%' THEN 'job' ELSE kind || ':' || created_by END AS origin,
         COUNT(*) FROM wakeups WHERE fired_at >= (strftime('%s','now') - 86400) * 1000 GROUP BY origin;
  -- wakeups that joined another's turn, last 24 h
  SELECT COUNT(*) FROM wakeups WHERE joined_to IS NOT NULL AND fired_at >= (strftime('%s','now') - 86400) * 1000;
  -- cache hit rate, last 24 h
  SELECT kind, ROUND(1.0 * SUM(cache_read_tokens) / SUM(input_tokens + cache_read_tokens + cache_write_tokens), 3) FROM episodes
  WHERE started_at >= (strftime('%s','now') - 86400) * 1000 GROUP BY kind;
  ```
