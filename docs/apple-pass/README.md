# The model switcher and the Apple pass (branch `apple-pass`)

A rough pass, for review before it goes further. Not pushed, no app built, nothing on the host.

## What to look at

| Picture | What it shows |
| --- | --- |
| `mac-chat.png`, `mac-chat-dark.png` | The Mac's chat. `mac-chat-before.png` is how it was. |
| `mac-model-menu.png` | The model menu, opened from the composer. |
| `mac-thinking-dark.png` | midna thinking: the dots, and Stop where Send was. |
| `mac-settings.png` | Settings, with the same menu and the Claude account. |
| `mac-today.png`, `mac-objectives.png`, `mac-welcome.png` | The other screens. |
| `phone-chat-model-settings.png` | The phone: chat, the model sheet, Settings. |
| `phone-dark-approvals-vault.png` | The phone in dark: chat, Approvals, Vault. |

The Mac pictures are the app's page in a browser against a throwaway midna (`bun run preview`, then `bun run --cwd clients/desktop dev`). The phone pictures are a **web render** of the phone's own source (`bun run preview:phone`), not an iPhone: layout, colours and type are the app's; the sheet, the keyboard, native controls and safe areas are approximations.

## The model switcher

- **Mac:** a pop-up button in the composer names what is thinking (model and Claude account) and opens a menu of every installed brain's models and the two accounts. Settings has the same menu, the account, the fallback list and a field for a model the menu doesn't list.
- **Phone:** the chat's header names the model; tapping it opens a sheet of the same choices. Settings has a Model row that opens it too.
- A choice is `PATCH /v1/settings` (`model`, `account`), so it is the host's setting and every device shows it. It holds from midna's next turn.
- The list comes from `GET /v1/brains` and Status, which today's host (0.13.6) has. The one addition is `GET /v1/brains/:id/models`, which asks each brain for its own models; until the host is updated the apps show a short list they work out themselves (Claude's opus, fable, sonnet and haiku, each other brain's default, and whatever is set or a fallback, such as DeepSeek through OpenCode Zen).

## The look

The system's typeface and greys, one accent colour (the system blue) for the thing to press and for what you said, a toned sidebar, groups told apart by tone instead of outlines, forms laid out as System Settings and iOS Settings lay theirs out, and the time said only after a silence, as Messages does. The colour values are in `clients/desktop/src/style.css` and `clients/mobile/src/theme.ts`.

## Not seen yet

- The phone on a phone. This Mac has no Xcode or simulator; the first TestFlight build from this branch is the first real look.
- The Mac app built and running: the This Computer screen, the approval panel, the pill over the screen and Mac notifications only exist in the built app, and were restyled without being seen.
