PID_FILE := .dev.pid
LOG_FILE := .dev.log
GUIDE := packages/web-extension/docs/build-report.html

# Open a file/URL with whatever the OS provides. WSL has no desktop of its
# own - xdg-open is a no-op there - so hand off to Windows explorer.exe
# with the path translated via wslpath, which is what actually opens it in
# the Windows-side browser.
ifeq ($(shell uname -s),Darwin)
OPEN := open
else ifneq ($(wildcard /mnt/c/Windows/explorer.exe),)
OPEN := /mnt/c/Windows/explorer.exe
else
OPEN := xdg-open
endif

.PHONY: run stop restart guide doctor build

# `yarn ext:dev` (vite dev, for HMR) and `yarn ext:build` (plain vite
# build) write to separate directories - dist/chrome-dev vs dist/chrome -
# specifically so this target can never leave a stale/mixed popup or
# options page behind for whichever one you load unpacked. Load
# dist/chrome-dev only while this is running; load dist/chrome (from
# `make build` / `yarn ext:build`) otherwise.
run: stop
	@echo "Starting extension dev server (yarn ext:dev)..."
	@nohup yarn ext:dev > $(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE)
	@sleep 1
	@echo "Started with PID $$(cat $(PID_FILE)), logs at $(LOG_FILE)"
	@echo "Load packages/web-extension/dist/chrome-dev as an unpacked extension in chrome://extensions"

stop:
	@if [ -f $(PID_FILE) ]; then \
		PID=$$(cat $(PID_FILE)); \
		if kill -0 $$PID 2>/dev/null; then \
			echo "Stopping dev server (PID $$PID)..."; \
			pkill -P $$PID 2>/dev/null || true; \
			kill $$PID 2>/dev/null || true; \
		fi; \
		rm -f $(PID_FILE); \
	fi

restart: stop run

build:
	@yarn ext:build
	@echo "Load packages/web-extension/dist/chrome as an unpacked extension in chrome://extensions"

guide:
	@echo "Opening $(GUIDE)..."
ifeq ($(OPEN),/mnt/c/Windows/explorer.exe)
	@$(OPEN) "$$(wslpath -w '$(GUIDE)')" || true
else
	@$(OPEN) "$(GUIDE)"
endif

doctor:
	@yarn doctor
