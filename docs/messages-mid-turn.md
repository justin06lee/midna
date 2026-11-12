# The user's messages while midna is working

A message the user sends while midna is mid-turn doesn't kill the work in progress. What happens depends on the message and on the brain.

| The user sends | Chat turn on Claude | Chat turn on Codex, Gemini, OpenCode, Hermes | Wakeups running |
| --- | --- | --- | --- |
| An ordinary message | Goes into the running turn (below). Nothing stops. | The turn is interrupted, as before: the next one answers everything and hears what it was in the middle of. | Carry on. The answer runs beside them, unless every slot is taken: then the newest is set aside and carries on a minute later. |
| One that says to stop: `stop`, `cancel that`, `hold on`, `wait, …`, `never mind`, or anything starting `/stop` | Interrupted, as before. | Interrupted, as before. | Set aside, as before. |
| One starting `/queue` | Waits for the turn to finish, then gets its own. | The same. | Carry on. |

`saysStop` in `packages/agent/src/assistant.ts` decides what counts as stop. Only the opening counts, and only as a phrase of its own: "cancel my 3pm" and "stop by the store" are requests and go into the turn.

## Into the running turn

Claude Code's stream-json input takes more user messages while a turn runs. midna writes the message to the live session with a uuid, framed as real user input with what to do about it (`midTurnNote` in `prompt.ts`): answer now with `message_user` if it's quick or urgent and carry on; otherwise acknowledge it in one line, finish the work, then handle it. Claude Code folds it into the turn at the next tool boundary. If it comes too late to fold in, after the last tool call, it runs as a turn of its own right after.

Every result lists the uuids its turn read (`user_message_uuids`), so midna knows which messages the model actually saw (`Steering` in `brain.ts`). When the turn ends:

- A message the model read counts as answered, along with the ones that started the turn. The reply is every result's text.
- A message it never read (the turn for it never started, failed, or this Claude Code can't say what it read) stays unanswered, and the next chat turn answers it. A message is never marked handled without the model having seen it.
- If a stop interrupts the turn later, nothing it read counts as answered: the next turn gets every message again, with the usual "you were interrupted" note.

The system prompt says which behavior the brain has: `midTurn` in `systemPrompt`, set from the episode's model.

yagami's `AgentSession.send()` takes no uuid, so `sendTagged` writes to the session's input queue itself. If that ever stops working, the inbox never opens and Claude falls back to interrupting.
