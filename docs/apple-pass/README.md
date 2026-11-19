# The model switcher and the Apple pass (branch `apple-pass`)

A rough pass, for review before it goes further. Not pushed, no app built, nothing on the host.

## Round 2 (after the first review)

| What was wrong | Before | After |
| --- | --- | --- |
| The phone's code block was in a serif face, and "Sent from desktop" sat under every bubble | `phone-chat-before.png` | `phone-chat-after.png` |
| The Mac's table sat in a grey box wider than itself | `mac-table-before.png` | `mac-table-after.png` |
| The menu offered "Fable 5.1" and hid 5.2; the account rows led with the addresses | round 1's menu | `mac-model-menu.png` |

- **Model names.** Round 1 offered Claude's aliases from a list written in the app, and "fable" stands for Fable 5.1 in Claude Code today, so 5.2 was hidden behind "9 more". Now nothing in the apps knows a model: a name, and the model an alias stands for, come from the brain's own list (the route carries each entry's real id). Claude's group leads with the start of that list, which today is Opus 5.5, Fable 5.2, Sonnet 5.5, Haiku 5.5; Fable 5.1 is under "more". Hover a model on the Mac to see what it resolves to ("opus is claude-opus-5-5"). The stand-in line and the fallbacks are named the same way. In the pictures the model is set to Fable 5.2 with DeepSeek as the fallback.
- **The serif** was the web render, not the phone: the app asks iOS for its monospaced system face (SF Mono), which React Native on iOS provides, and the browser the pictures are taken in doesn't know that name. The preview is now told the faces by name, so the picture matches what the phone draws.
- **"Sent from …"** is gone from the phone. On the Mac it was the same noise the other way round, so it is only in the bubble's tooltip now, with the time.
- **Account rows** on the Mac put the name first, with the address (or when its usage is back) under it, smaller and grey.

## What to look at

| Picture | What it shows |
| --- | --- |
| `mac-chat.png`, `mac-chat-dark.png` | The Mac's chat. `mac-chat-before.png` is how it was. |
| `mac-model-menu.png` | The model menu, opened from the composer. |
| `mac-thinking-dark.png` | midna thinking: the dots, and Stop where Send was. |
| `mac-settings.png` | Settings, with the same menu and the Claude account. |
| `mac-today.png`, `mac-objectives.png`, `mac-welcome.png` | The other screens. |
| `mac-approval-panel-and-pill.png` | The panel that asks for a yes and the pill over the screen, at their windows' sizes, light and dark (in a browser, with a made-up ask). |
| `phone-chat-model-settings.png` | The phone: chat, the model sheet, Settings. |
| `phone-dark-approvals-vault.png` | The phone in dark: chat, Approvals, Vault. |

The Mac pictures are the app's page in a browser against a throwaway midna (`bun run preview`, then `bun run --cwd clients/desktop dev`). The phone pictures are a **web render** of the phone's own source (`bun run preview:phone`), not an iPhone: layout, colours and type are the app's; the sheet, the keyboard, native controls and safe areas are approximations.

## The model switcher

- **Mac:** a pop-up button in the composer names what is thinking (model and Claude account) and opens a menu of every installed brain's models and the two accounts. Settings has the same menu, the account, the fallback list and a field for a model the menu doesn't list.
- **Phone:** the chat's header names the model; tapping it opens a sheet of the same choices. Settings has a Model row that opens it too.
- A choice is `PATCH /v1/settings` (`model`, `account`), so it is the host's setting and every device shows it. It holds from midna's next turn.
- The one addition to the host is `GET /v1/brains/:id/models`, which asks each brain for its own models, with their names and what each alias stands for. Today's host (0.13.6) doesn't have it. Until it is updated the picker offers only what the host itself names (the model that is set, the fallbacks, each other brain's default), each by its id as written, and says the host can't list the rest; the Mac's Settings can still name any model by hand. So the switcher is only really useful once the host has this branch's daemon.

## The look

The system's typeface and greys, one accent colour (the system blue) for the thing to press and for what you said, a toned sidebar, groups told apart by tone instead of outlines, forms laid out as System Settings and iOS Settings lay theirs out, and the time said only after a silence, as Messages does. The colour values are in `clients/desktop/src/style.css` and `clients/mobile/src/theme.ts`.

## Not seen yet

- The phone on a phone. This Mac has no Xcode or simulator; the first TestFlight build from this branch is the first real look.
- The Mac app built and running. Everything above was seen as the app's page in a browser; the This Computer screen only exists in the built app and was restyled without being seen, and the panel and the pill were seen in a browser, not as windows over the desktop.
