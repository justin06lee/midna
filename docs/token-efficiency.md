# midna's token efficiency: the plan

Justin's brief: make midna token-efficient at the root, in this codebase, without side scripts. Items 1–3 are built straight away. Items 4–5 wait for midna's review.

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

### 2. Events instead of polling: a ruri bridge (built now)

- **A bridge,** run like Telegram's: a supervised process, an ordinary API client. It subscribes to ruri's WebSocket and posts `midna event`s (`POST /v1/inbound`) for:
  - a project gone idle, with its finished sessions' last replies, trimmed;
  - a permission request waiting;
  - weekly usage crossing 70%, 78% or 80%.

  ruri's address, auth and event shapes come from ruri's own team, not guesses. They are asked, and recorded here once answered.
- **Where it runs:** on the Jetson beside the daemon, reaching ruri on the Mac over makima.
- **The system prompt** tells midna that these events arrive on their own, so it doesn't schedule "is it done yet" checks.
- **Then midna retires its stopgap** (`ruri-watch.py` and its timer). That is midna's job.
- **Saves:** most of the 117 progress checks ($39/day). Expected −$20 to −$30/day. Not all of them are polls: the 8:30 digest and the night-shift rounds remain.

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

### 5. Context (after midna's review)

- **Measure:** each turn's input size and its cache hit rate, from item 1's columns.
- **Keep the prefix cache-stable:** the fixed instructions first, the working context next, the volatile parts ("Now") last.
  - Today, the working context sits inside the system prompt, so every fresh wakeup session writes it all again.
  - With a stable prefix, wakeup sessions within the hour read the shared part from the cache instead.
- **Trim tool output** that's returned whole today.
- **Roll the chat session over** with a short summary once its context is large. Today it rolls at 40 turns or after 4 idle hours.
- **Saves:** likely the largest single cut for wakeups, perhaps 30–50% of what remains, but to be measured before it's promised. Chat: −20–40%.

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
