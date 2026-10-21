PREFIX ?= $(HOME)/.local
BIN    := $(PREFIX)/bin/midna

.PHONY: all build install app app-dev signing check update

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
# On a Mac with the "midna dev" identity (or a signed midna.app) an unsigned build isn't installed:
# `make signing` first, or MIDNA_ALLOW_ADHOC=1 make app to mean it.
app:
	bun install
	cd clients/desktop && bun run app

# The "midna dev" signing identity, once per Mac, so midna.app keeps its permissions across updates.
signing:
	cd clients/desktop && bun run signing

app-dev:
	cd clients/desktop && bun run app:dev

check:
	bun run check

# Pick up changes: rebuild, reinstall, and restart the service if this machine is a host.
update: build install
	@if $(BIN) service status 2>/dev/null | grep -q installed; then $(BIN) service restart; fi
