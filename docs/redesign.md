# The look

midna's two apps (iPhone, Mac) are drawn after two references Justin named:
ruri's iPhone app (`ruri/ios/Ruri`, with its Mac stylesheet `ruri/web/src/styles.css`)
and monet's iPhone app (`monet/ios/Monet`; pictures in `monet-ios-ship/shots`).
Both were read, never changed. This page says what was taken from them, so a
new screen can be drawn the same way without opening either.

The look before this one (the "Apple pass", pictures in `docs/apple-pass/`)
copied iOS Settings: system greys, the system blue on the user's bubble, the
tabs and every button, hairlines under the header and over the tab bar. It
read as a stock form. This replaces it.

## What both references share

- **Paper and ink.** A page, and ink on it. A surface is told from the next
  by the shade it is printed in: the ground a shade off the page, a card a
  shade off the ground. No line is drawn round anything and nothing casts a
  shadow to say it is a card.
- **Ink leads; the accent is rare.** The one control that leads a screen
  (send, the primary button) is solid ink. The accent marks the single thing
  that is on or needs you: the tab you are on, the block on now, a switch,
  a dot beside what waits for you.
- **Your own words are grey.** The user's bubble is a quiet grey (ruri:
  "Messages' grey, not the blue"). midna's replies have no bubble: they are
  the page.
- **Soft, large shapes.** Cards at 18, fields at 24, bubbles at 20, all
  continuous corners; buttons and chips are capsules; controls in a bar are
  circles 44 across.
- **Things float.** The tab bar is a capsule standing off the bottom edge
  (monet); the composer is one rounded field with its buttons inside it
  (ruri); on iOS 26 both are Liquid Glass, before it a raised shade.
- **Room.** 16 at the page's edge, 20 to 28 between groups, rows 50 tall.
- **Motion only for a change of state**, about 0.2 s, easing out.

## midna's tokens

One set of names in both apps (`clients/mobile/src/theme.ts`,
`clients/desktop/src/style.css`), ruri's names:

| token | what it is | light | dark |
|---|---|---|---|
| `paper` | the page a conversation is read on | `#ffffff` | `#141312` |
| `paperDim` | a shade off the page: a chip, a code block | `#f4f3f1` | `#1d1c1a` |
| `ground` | a screen of rows; the Mac's sidebar | `#f1f0ee` | `#141312` |
| `raised` | a card on the ground, a field | `#ffffff` | `#1d1c1a` |
| `raisedHigh` | what floats: the tab bar, a menu | `#ffffff` | `#262421` |
| `ink` | text, and the control that leads | `#1d1c1a` | `#ece8e1` |
| `inkSoft` | what is said second | `#66625c` | `#b0a99e` |
| `inkFaint` | times, placeholders | `#8d877e` | `#8d877e` |
| `bubble` | the user's bubble | `#ecebe8` | `#2c2a27` |
| `fill` | a wash of ink: a pressed row, a quiet button | ink at 8% | ink at 10% |
| `hairline` | the one rule allowed: between rows of a group | ink at 8% | ink at 8% |
| `accent` | the thing that is on | `#a8731d` | `#e2b26c` |
| `destructive` | unpair, deny, a failure | `#c8321f` | `#e0806b` |

Dark is monet's warm near-black with its parchment ink and paint-ochre
accent; light is ruri's white page warmed to sit with it. The app follows
the device.

**Type.** Space Grotesk (ruri's face; OFL, bundled) in regular, medium and
bold; SF Mono for code. Sizes are ruri's: 32 large title, 21 title, 16 body,
14 second line, 13 footnote, 12 caption.

## The iPhone

- **Bar:** `midna` in bold at the centre (monet's wordmark place). Left, a
  circle that opens Approvals, with an accent dot when something waits.
  Right, a circle that opens Settings. Both open as sheets with a **Done**.
- **Tabs:** Chat, Today and Vault in a floating capsule (monet's). Approvals
  and Settings left the tab bar: one is a thing that happens now and then,
  the other is visited rarely.
- **Chat:** ruri's. Grey bubble right, replies as the page, 8 between lines
  of one speaker and 18 when the speaker changes. The composer is one field:
  the words, and under them **+**, the model's name (it opens the model
  sheet, as ruri's does) and the ink send circle.
- **Rows:** `Group` is ruri's `RowGroup` (raised, 18, hairlines inset);
  the label over it is a small medium-weight line in `inkSoft`, never
  capitals.

## The Mac

- Sidebar a shade off the page, no rule between them; the selected item is a
  wash of ink, never the accent.
- The conversation is a column 720 wide on the page; grey bubble, replies as
  the page; the composer is the same field as the phone's, raised off the
  page by a soft shadow.
- Settings and the other screens are groups of rows on the ground, as on the
  phone.

## Which copy of monet

There is no `monet` beside this repo on the mini. The copy read was
`~/midna-replica/data/workspace/monet` (with `monet-ios-ship/shots` for its
pictures).
