PREFIX ?= $(HOME)/.local
BIN    := $(PREFIX)/bin/midna

.PHONY: all build install app app-universal app-dev signing check tenet-check tenet-cargo-test update testflight

# The golden path: the CLI on your PATH, and the desktop app built for this machine.
all: build install app

build:
	bun install
	bun run build

# `midna` on your PATH — the CLI, and (on a host) the daemon itself.
install:
	@mkdir -p $(PREFIX)/bin
	@cp -f dist/midna $(BIN).part && mv -f $(BIN).part $(BIN)
	@echo "installed $(BIN)"

# The desktop app, built for this machine and installed: the .app into ~/Applications on macOS;
# on Linux a .deb where there is dpkg, an .rpm where there is rpm, an AppImage anywhere else.
# On macOS it's signed with the login keychain's Developer ID Application identity when there is a valid
# one, then notarized with the "midna-notary" notarytool profile and stapled: Gatekeeper accepts it, and its
# designated requirement (Apple's anchor, team 65UN46K6FA) is the same on every Mac, so grants survive updates.
# Otherwise it's signed with "midna dev" (grants survive, this Mac only), otherwise ad hoc.
# The first Developer ID build over a "midna dev" midna.app resets its permissions once (the requirement
# changes), so it isn't installed until asked for: MIDNA_SWITCH_SIGNER=1 make app, at the Mac, then grant them again.
# On a Mac with the "midna dev" identity (or a signed midna.app) an unsigned build isn't installed:
# `make signing` first, or MIDNA_ALLOW_ADHOC=1 make app to mean it. MIDNA_NOTARIZE=0 skips notarizing.
app:
	bun install
	cd clients/desktop && bun run app

# The "midna dev" signing identity, once per Mac, so midna.app keeps its permissions across updates
# on a Mac without a Developer ID identity (with one, app builds use that and this isn't needed).
signing:
	cd clients/desktop && bun run signing

# One midna.app for Apple silicon and Intel Macs (arm64 + x86_64), signed and notarized like `make app`,
# left in clients/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos, not installed.
# Needs: rustup target add aarch64-apple-darwin x86_64-apple-darwin
app-universal:
	bun install
	cd clients/desktop && bun run app:universal

app-dev:
	cd clients/desktop && bun run app:dev

check:
	bun run check

# The iPhone app to TestFlight (internal testing). Needs ASC_KEY_ID and ASC_ISSUER_ID, with the key's
# .p8 in ~/.appstoreconnect/private_keys; raise expo.ios.buildNumber in clients/mobile/app.json first.
testflight:
	clients/mobile/scripts/testflight.sh

# The same on tenet, so this 8 GB Mac stays free: any other heavy step is scripts/tenet.sh <command>.
tenet-check:
	scripts/tenet.sh bun run check

# The desktop app's Rust tests on tenet. generate_context! wants the built frontend and
# tauri-build this platform's sidecar, so both come first.
tenet-cargo-test:
	scripts/tenet.sh 'cd clients/desktop && bun run build >/dev/null && bun scripts/sidecar.ts && cd src-tauri && cargo test'

# Pick up changes: rebuild, reinstall, and restart the service if this machine is a host.
update: build install
	@if $(BIN) service status 2>/dev/null | grep -q installed; then $(BIN) service restart; fi
