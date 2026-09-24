.PHONY: lint format test test-ui test-ui-fast test-ui-layout serve build-ui check-ui deploy \
	launchd-install launchd-restart launchd-uninstall \
	launchd-ui-install launchd-ui-restart launchd-ui-uninstall logs ui-logs

LAUNCHD_LABEL = com.optionality.service
LAUNCHD_PLIST = $(HOME)/Library/LaunchAgents/$(LAUNCHD_LABEL).plist
UI_LABEL = com.optionality.ui
UI_PLIST = $(HOME)/Library/LaunchAgents/$(UI_LABEL).plist
UV_BIN = $(shell command -v uv)
CADDY_BIN = $(shell command -v caddy)

# where the dashboard is mounted on the tailnet. Baked into the bundle at build time,
# because `tailscale serve` strips the prefix and the page cannot discover it (ADR 0006).
UI_BASE ?= /opt/

lint:
	uv run ruff check .

format:
	uv run ruff format .

test:
	uv run pytest

# 127.0.0.1: reachable only via the tailscale serve proxy (and localhost); never the LAN
serve:
	uv run --env-file .env uvicorn --factory optionality.service.app:create_app --host 127.0.0.1 --port 31415

# two suites, split by what they can prove. jsdom has no layout engine at all, so the
# fitting mechanism is invisible to it — see ADR 0008. Both run here: the reason for
# measuring rather than guessing was to catch what nobody thinks to check by hand, and a
# check you have to remember to run does not do that.
test-ui: test-ui-fast test-ui-layout

test-ui-fast:
	cd frontend && npm install --silent && npm test

# NOTE: the first run downloads a headless Chromium (~95MB) into ~/Library/Caches.
# Nothing here touches the deploy path — ADR 0006 keeps node off that entirely.
test-ui-layout:
	cd frontend && npm install --silent && npx playwright install --with-deps chromium >/dev/null 2>&1 || true
	cd frontend && npm run test:browser

# the bundle is COMMITTED, so node is needed only to change the frontend, never to run
# the service — a failed build must not become a failed deploy, and now that Caddy serves
# the files directly it would leave nothing to serve at all
build-ui:
	cd frontend && npm install --silent && VITE_BASE=$(UI_BASE) npm run build

# a committed bundle can drift from its source; this is what catches it
check-ui:
	cd frontend && npm install --silent && VITE_BASE=$(UI_BASE) npm run build >/dev/null
	@git diff --quiet -- frontend/dist \
		|| { echo "frontend bundle is stale — run 'make build-ui' and commit the result"; exit 1; }
	@echo "frontend bundle matches its source"

# The one path that keeps both services in step. Skew is the price of running them
# separately (ADR 0006); this is what stops it happening by simple forgetfulness.
deploy:
	git pull --ff-only
	uv sync --quiet
	cp data/optionality.db data/optionality.db.bak-$$(date +%Y%m%d-%H%M%S)
	OPTIONALITY_DB_PATH=data/optionality.db uv run alembic upgrade head
	$(MAKE) launchd-restart
	$(MAKE) launchd-ui-restart
	@echo "both services restarted"

# install the service as a macOS launchd agent: starts at login, restarts on crash
launchd-install:
	mkdir -p $(HOME)/Library/LaunchAgents $(HOME)/Library/Logs
	sed -e 's|__UV__|$(UV_BIN)|g' -e 's|__REPO__|$(CURDIR)|g' -e 's|__HOME__|$(HOME)|g' \
		deploy/optionality.launchd.plist.template > $(LAUNCHD_PLIST)
	plutil -lint $(LAUNCHD_PLIST)
	launchctl bootstrap gui/$$(id -u) $(LAUNCHD_PLIST)

launchd-restart:
	launchctl kickstart -k gui/$$(id -u)/$(LAUNCHD_LABEL)

launchd-uninstall:
	-launchctl bootout gui/$$(id -u)/$(LAUNCHD_LABEL)
	rm -f $(LAUNCHD_PLIST)

# the dashboard's own agent: Caddy, serving frontend/dist and nothing else
launchd-ui-install:
	@test -n "$(CADDY_BIN)" || { echo "caddy not found — brew install caddy"; exit 1; }
	mkdir -p $(HOME)/Library/LaunchAgents $(HOME)/Library/Logs
	sed -e 's|__CADDY__|$(CADDY_BIN)|g' -e 's|__REPO__|$(CURDIR)|g' -e 's|__HOME__|$(HOME)|g' \
		deploy/optionality-ui.launchd.plist.template > $(UI_PLIST)
	plutil -lint $(UI_PLIST)
	OPTIONALITY_UI_ROOT=$(CURDIR)/frontend/dist $(CADDY_BIN) validate --config deploy/Caddyfile
	launchctl bootstrap gui/$$(id -u) $(UI_PLIST)

launchd-ui-restart:
	launchctl kickstart -k gui/$$(id -u)/$(UI_LABEL)

launchd-ui-uninstall:
	-launchctl bootout gui/$$(id -u)/$(UI_LABEL)
	rm -f $(UI_PLIST)

logs:
	tail -f $(HOME)/Library/Logs/optionality.log

ui-logs:
	tail -f $(HOME)/Library/Logs/optionality-ui.log
