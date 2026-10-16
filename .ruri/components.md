# Component library

Every piece of this project's interface ruri has on file: the user's own
name for it, its handle, its files, and a picture. When the user names
something here, this is what they mean — go straight to its files rather
than searching for their words. Before building interface, look here
first and reuse what exists: `ruri show <slug>` reads one with its code,
`ruri add <slug>` copies it into place, `ruri help` says the rest.

ruri maintains this file. Don't edit it by hand; it is rewritten whenever
the library changes.

## helmet-mark — the helmet mark
midna's logo: Midna's Twilight Princess helmet as a flat black silhouette on a flat white card. One outline (helmet.ts) feeds the app icon, the macOS 26 Icon Composer icon (icons/midna.icon → Assets.car; white helmet in the dark, clear and tinted styles, shown left to right), tray icon, in-app <Mark> and the README banner; rerun `bun run icons` after changing it.
Its files: clients/desktop/src/helmet.ts, clients/desktop/src/ui.tsx, clients/desktop/scripts/icons.ts, clients/desktop/src-tauri/icons/midna.icon
Reaches into: assets/midna.svg
Tags: logo, icon, brand
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/68ff780c-a51a-4df5-a8eb-855b8b99c4b7-sheet.png, /Users/huiyunlee/.config/ruri/uploads/3c2ba7a5-69be-410c-a014-bc4bc1a90ee7-midna-helmet-sheet.png

## title-bar — the title bar
"midna on <host>" beside the macOS traffic lights, in a 44px drag strip. Its 92px left padding is tied to trafficLightPosition in tauri.conf.json; change one, re-measure the other.
Its files: clients/desktop/src/screens/Main.tsx
Reaches into: clients/desktop/src-tauri/tauri.conf.json, clients/desktop/src/host.ts
Tags: window, nav, header
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/e032f092-4953-4611-b1b8-f3a7a38fc4c5-midna-titlebar.png

## chat-images — the chat images
Images and files in the chat: attachments fetched with the device token and drawn at their own size (one up to 440×320, several in a 150px row), file chips, Markdown web images, and the full-size viewer they open in.
Its files: clients/desktop/src/media.tsx
Reaches into: clients/desktop/src/screens/Chat.tsx, clients/desktop/src/markdown.tsx, clients/desktop/src/ui.tsx, clients/desktop/src-tauri/tauri.conf.json
Tags: chat, image, attachment, viewer, lightbox
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/20e7aa34-95bb-44e7-bb07-2eb939f31894-shot-10.png
