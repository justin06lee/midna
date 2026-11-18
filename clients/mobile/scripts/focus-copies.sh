#!/bin/sh
# Focus.swift is the app's and each Screen Time extension's: an extension is its own program and compiles its own
# copy. Real copies, not links, so Xcode's synchronized folders need no cleverness. After editing
# modules/midna-focus/ios/Focus.swift, run this; test/focusCopies.test.ts fails while a copy differs.
set -eu
cd "$(dirname "$0")/.."
for t in focus-monitor focus-shield focus-shield-action; do
  cp modules/midna-focus/ios/Focus.swift "targets/$t/Focus.swift"
done
echo "Focus.swift copied to the three extension targets"
