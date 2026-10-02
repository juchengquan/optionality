.PHONY: lint format test test-ui test-ui-fast test-ui-layout test-api typecheck check-api diff-api diff-api-live diff-opend diff-services copy-db \
	serve build-ui check-ui deploy \
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
	npm install --silent && npm test --workspace frontend

# NOTE: the first run downloads a headless Chromium (~95MB) into ~/Library/Caches.
# Nothing here touches the deploy path — ADR 0006 keeps node off that entirely.
test-ui-layout:
	npm install --silent && npx playwright install --with-deps chromium >/dev/null 2>&1 || true
	npm run test:browser --workspace frontend

# the bundle is COMMITTED, so node is needed only to change the frontend, never to run
# the service — a failed build must not become a failed deploy, and now that Caddy serves
# the files directly it would leave nothing to serve at all
build-ui:
	npm install --silent && cd frontend && VITE_BASE=$(UI_BASE) npm run build

# A committed bundle can drift from its source; this is what catches it.
#
# The rm is not tidiness. Building over an existing dist hid a real bug for weeks: Tailwind
# skips .gitignore'd paths, frontend/dist is deliberately not ignored, so it was scanning its
# own previous output and emitting 3KB of utilities that existed only because a former build
# mentioned them. This check never saw it, because it too built with a dist in place and so
# compared a self-consistent result against itself. Building from nothing is what makes this
# a reproducibility check rather than a self-agreement check.
check-ui:
	rm -rf frontend/dist
	npm install --silent && cd frontend && VITE_BASE=$(UI_BASE) npm run build >/dev/null
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

# the TypeScript backend (ADR 0009). No build target: Node runs the source directly, so there
# is nothing to compile and nothing to commit — the frontend's dist has no backend equivalent.
test-api:
	npm install --silent && npm test --workspace backend

typecheck:
	npm install --silent && npm run typecheck

# tsc is not enough. Node runs the backend by ERASING types, so syntax that would have to EMIT code
# is rejected at load time — and tsc accepts it while vitest transforms it, so neither notices. Two
# classes reached main unable to load at all. See backend/tools/check-loads.mjs.
check-api:
	node backend/tools/check-loads.mjs

# the port is faithful or it is nothing (ADR 0009), and there is no recorded history to replay —
# so these put the same inputs through both implementations and compare exactly. A porting tool,
# not a suite: what it finds belongs in backend/src/**/*.test.ts. See backend/tools/differential.
DIFF_OUT = $(CURDIR)/backend/tools/differential/.out
diff-api:
	mkdir -p $(DIFF_OUT)
	python3 backend/tools/differential/gen_cases.py $(DIFF_OUT)/cases.json
	uv run python backend/tools/differential/run_py.py $(DIFF_OUT)/cases.json $(DIFF_OUT)/py.json
	node backend/tools/differential/run_ts.mjs $(DIFF_OUT)/cases.json $(DIFF_OUT)/ts.json
	python3 backend/tools/differential/compare.py $(DIFF_OUT)/py.json $(DIFF_OUT)/ts.json 18000

# reads the live DB and makes ONE bounded OpenD call, in a single process so both sides see the
# same instant. Read-only.
diff-api-live:
	mkdir -p $(DIFF_OUT)
	uv run --env-file .env python backend/tools/differential/live_py.py \
		$(DIFF_OUT)/live_in.json $(DIFF_OUT)/live_py.json
	node backend/tools/differential/live_ts.mjs $(DIFF_OUT)/live_in.json $(DIFF_OUT)/live_ts.json
	python3 backend/tools/differential/compare.py $(DIFF_OUT)/live_py.json $(DIFF_OUT)/live_ts.json 40

# the fresh TypeScript database, copied from the Python's and verified field by field (ADR 0009
# phase 4). Snapshots the live file first, so a sweep landing mid-copy cannot read as corruption.
# Never writes to data/optionality.db. Refuses to overwrite an existing target.
NEXT_DB ?= data/optionality-next.db
copy-db:
	node backend/tools/copy-db/copy.ts data/optionality.db $(NEXT_DB)
	uv run python backend/tools/copy-db/python_can_read.py $(NEXT_DB).snapshot $(NEXT_DB)

# the TypeScript OpenD client against the Python SDK, field by field (ADR 0009 phase 6). Reads the
# live watchlist's own contracts and brackets the TypeScript read between two Python reads, because
# the market moves while we look at it. Needs OpenD up and its websocket enabled.
OPEND_OUT = $(CURDIR)/backend/tools/opend/.out
diff-opend:
	mkdir -p $(OPEND_OUT)
	uv run --env-file .env python backend/tools/opend/codes.py $(OPEND_OUT)/codes.json
	uv run --env-file .env python backend/tools/opend/read_py.py $(OPEND_OUT)/codes.json $(OPEND_OUT)/before.json
	node --env-file=.env backend/tools/opend/read_ts.mjs $(OPEND_OUT)/codes.json $(OPEND_OUT)/ts.json
	uv run --env-file .env python backend/tools/opend/read_py.py $(OPEND_OUT)/codes.json $(OPEND_OUT)/after.json
	python3 backend/tools/opend/compare.py $(OPEND_OUT)/before.json $(OPEND_OUT)/ts.json $(OPEND_OUT)/after.json

# both services asked the same question within the same second (ADR 0009 phase 6). Starts the
# TypeScript service against a FRESH copy of the live database, on a port of its own; never writes to
# data/optionality.db. Needs the Python service running on 31415 and OpenD up.
diff-services:
	backend/tools/opend/both_services.sh

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
