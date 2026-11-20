# The model switcher and the Apple pass (branch `apple-pass`)

A rough pass, for review before it goes further. Not pushed, no app built, nothing on the host.

## The real window (charizard unlocked)

`built-chat.png` is the built Mac app's own window: the preview build (release, this branch, its own bundle id so the installed midna.app is untouched) against a throwaway midna, in the system's dark appearance, taken by `bun scripts/built-shot.ts`.

It found what no preview had: **in dark mode the app drew light text on a pale window.** One edit in round 1 had put the body's rules (background, ink, 13 px type, no text selection) on the selector meant for the windows over the screen, so the page had no background of its own and showed the window's pale first-paint colour, and the pill's and the approval panel's windows had lost their see-through background. The browser and the off-screen WebKit pictures both hid it, because an empty background there happens to be dark in dark mode. Fixed, with a test that pins those rules; the picture is from after the fix.

To be visible to WebKit the window has to be in front, so the command brings the app forward for the two or three seconds the photograph takes (once the Mac has been idle a few seconds) and gives the screen back to what was in front. Only the chat is photographed: clicking in a real window needs Accessibility, which this session's shell doesn't have. The menu and Settings are in the WebKit pictures above.

**The pill and the approval panel can't be photographed, by design:** both windows are kept out of screen captures (`exclude_from_capture`), so midna never sees them in its own screenshots, and neither does `screencapture`. What was checked instead, in WebKit: each of their pages (`#pill`, `#approval`) has a see-through `html` and `body` again (computed background `rgba(0, 0, 0, 0)`), with the body's type back at 13 px, and the test pins the rule.

## Round 4 (after the third review)

| What was wrong | Before | After |
| --- | --- | --- |
| "Default (Grok 4.7)" sat right above "Grok 4.7"; Grok showed five rows where the others showed four | `mac-menu-rows-before.png`, `phone-sheet-rows-before.png` | `mac-menu-rows-after.png`, `phone-sheet-rows-after.png` |

- **Default.** When the model a brain runs by default is already one of the rows showing, there is no Default row: that row carries a quiet grey "Default" tag, where "Zen" sits, and it is the row ticked when the brain is set with no model named. When the default isn't one of the rows (OpenCode's Tidepool), it keeps its own row, "Default (Tidepool Alpha Free)", and isn't said again behind "more".
- **One rule for every brain.** Each shows four rows, then "N more": the start of the brain's own list where it leads with its current models (Claude), what is set and the fallbacks, the default's row when it needs one, then the list in its own order. What is set always shows, and "more" never stands for a single model. So OpenCode now fills its four rows from its list, and Grok's four models are its four rows.
- **The real window.** The preview build is back in `clients/desktop/src-tauri/target/release/bundle/macos/midna-preview.app`, built from this round. One command photographs it once charizard is unlocked (it says so and stops while the screen is locked):

  ```sh
  cd clients/desktop && bun scripts/built-shot.ts      # saves docs/apple-pass/built-chat.png; --keep leaves it open, --build rebuilds first
  ```

  It starts its own throwaway midna and hands the app that connection each time, since a throwaway midna's address and token only last as long as it runs. (Done since: see The real window, above.)

## Round 3 (after the second review)

| What was wrong | Before | After |
| --- | --- | --- |
| The Mac showed `*Justice*` with its asterisks | `mac-table-before.png` (the line above the table) | `mac-italic-after.png` |
| The phone's table lost its right edge | `phone-table-before.png` | `phone-table-after.png` |
| "Default" under a brain said nothing | round 2's menu | `mac-model-menu.png`, `phone-chat-model-settings.png` |
| The Mac's code block had no Copy | | `mac-code-copy.png` (pointer over the block) |

- **Italics.** The Mac's grammar had no `*italic*` at all (only `_italic_`), so the asterisks showed anywhere, not only in lists. It now reads what the phone reads: bold, italic both ways, struck, code and links, one inside another, in a line, a list item or a table's cell. Tested for each.
- **The phone's table** is drawn to fit when it only just overflows the message (its column widths are a generous guess), so its right edge is there; a much wider table still scrolls inside itself.
- **Default** names the model the brain runs when none is named, when its list marks one: "Default (Tidepool Alpha Free)", "Default (Grok 4.7)". The list request gives up after 20 seconds, so "Asking for its models…" always ends in a list or in "Couldn't list …'s models."
- **Copy** sits in the corner of a code block on the Mac while the pointer is over it, and says "Copied" for a moment.
- Found on the way, in WebKit: the menu's translucent surface let the chat read through its words, because the blur it leaned on isn't always drawn. Menus and notices are solid now. The model's name is also remembered between launches, so the button doesn't show a raw id for a moment while the brain is asked.

### The built app

The Mac app was built on charizard from this branch (release, under a bundle id and name of its own, `sh.midna.desktop.preview` / `midna-preview`, so the installed midna.app and its permissions were not touched; not installed, not notarized). Opened against the throwaway midna it starts, loads its page and connects: its WebKit process held the event stream, and the daemon logged its hands saying hello as app 0.13.6.

It could not be photographed. charizard's screen is locked (nobody has touched it for nine hours), and behind a lock screen WebKit paints nothing: the window is there, empty. So the Mac pictures in this round are the next closest thing: **the production page the app carries, drawn by WebKit itself off screen** (`clients/desktop/scripts/websnap.swift`), at the app's window size. They show the real engine, type and colours. They do not show the title bar and traffic lights, or the screens that only exist in the app (This Computer, the panel, the pill). To photograph the real window once the Mac is unlocked: `bun scripts/built-shot.ts`, as round 4 has it.

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
| `mac-chat.png`, `mac-chat-dark.png` | The Mac's chat, drawn by WebKit. `mac-chat-before.png` is how it was before any of this. |
| `mac-model-menu.png`, `mac-model-menu-dark.png`, `mac-model-menu-accounts.png` | The model menu, opened from the composer; the last is scrolled to the accounts. |
| `mac-settings.png` | Settings, with the same menu, the Claude account and the fallbacks by name. |
| `mac-thinking-dark.png`, `mac-today.png`, `mac-objectives.png`, `mac-welcome.png` | Round 1's pictures of the other screens (a browser, not WebKit). |
| `mac-approval-panel-and-pill.png` | The panel that asks for a yes and the pill over the screen, at their windows' sizes, light and dark (in a browser, with a made-up ask). |
| `phone-chat-model-settings.png` | The phone: chat, the model sheet, Settings. |
| `phone-dark-approvals-vault.png` | The phone in dark: chat, Approvals, Vault. |

The Mac pictures marked WebKit are the production page drawn off screen by the engine the app uses, against a throwaway midna (`bun run preview`). The phone pictures are a **web render** of the phone's own source (`bun run preview:phone`), also drawn by WebKit here, not an iPhone: layout, colours and type are the app's; the sheet, the keyboard, native controls and safe areas are approximations.

## The model switcher

- **Mac:** a pop-up button in the composer names what is thinking (model and Claude account) and opens a menu of every installed brain's models and the two accounts. Settings has the same menu, the account, the fallback list and a field for a model the menu doesn't list.
- **Phone:** the chat's header names the model; tapping it opens a sheet of the same choices. Settings has a Model row that opens it too.
- A choice is `PATCH /v1/settings` (`model`, `account`), so it is the host's setting and every device shows it. It holds from midna's next turn.
- The one addition to the host is `GET /v1/brains/:id/models`, which asks each brain for its own models, with their names and what each alias stands for. Today's host (0.13.6) doesn't have it. Until it is updated the picker offers only what the host itself names (the model that is set, the fallbacks, each other brain's default), each by its id as written, and says the host can't list the rest; the Mac's Settings can still name any model by hand. So the switcher is only really useful once the host has this branch's daemon.

## The look

The system's typeface and greys, one accent colour (the system blue) for the thing to press and for what you said, a toned sidebar, groups told apart by tone instead of outlines, forms laid out as System Settings and iOS Settings lay theirs out, and the time said only after a silence, as Messages does. The colour values are in `clients/desktop/src/style.css` and `clients/mobile/src/theme.ts`.

## Not seen yet

- The phone on a phone. This Mac has no Xcode or simulator; the first TestFlight build from this branch is the first real look.
- Most of the Mac app's own window. Its chat has been seen (`built-chat.png`); the This Computer screen has never been seen at all, and the panel and the pill only in a browser.
