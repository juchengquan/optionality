.PHONY: lint format test test-ui test-ui-fast test-ui-layout test-api typecheck check-api \
	diff-api diff-api-live diff-opend diff-services copy-db cutover cutover-preflight rollback restore-python \
	launchd-api-install launchd-api-restart launchd-api-uninstall api-logs \
	serve build-ui check-ui deploy \
	launchd-install launchd-restart launchd-uninstall \
	launchd-ui-install launchd-ui-restart launchd-ui-uninstall logs ui-logs

LAUNCHD_LABEL = com.optionality.service
LAUNCHD_PLIST = $(HOME)/Library/LaunchAgents/$(LAUNCHD_LABEL).plist
API_LABEL = com.optionality.api
API_PLIST = $(HOME)/Library/LaunchAgents/$(API_LABEL).plist
UI_LABEL = com.optionality.ui
UI_PLIST = $(HOME)/Library/LaunchAgents/$(UI_LABEL).plist
UV_BIN = $(shell command -v uv)
NODE_BIN = $(shell command -v node)
CADDY_BIN = $(shell command -v caddy)
# the TypeScript service's own database, a copy taken at cutover. The Python's is never opened again.
TS_DB = data/optionality-ts.db

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

# Resolve a frontend/dist conflict, which is the only kind this repo produces regularly.
#
# Two branches that both touch the frontend commit different bundles, so dist collides as a
# rename/rename on the hashed asset plus index.html. Neither side is right and no blend of them
# is either: a build has exactly one correct answer for the merged source. So this throws both
# away and rebuilds. Source conflicts must be settled first — the bundle is built FROM them —
# and it refuses to run while any remain rather than baking a conflict marker into the output.
resolve-ui:
	@unresolved=$$(git diff --name-only --diff-filter=U | grep -v '^frontend/dist/' || true); \
	if [ -n "$$unresolved" ]; then \
		echo "source conflicts remain; the bundle is built from these, so settle them first:"; \
		echo "$$unresolved" | sed 's/^/  /'; \
		exit 1; \
	fi
	rm -rf frontend/dist
	$(MAKE) build-ui
	git add -A frontend/dist
	@echo "frontend/dist rebuilt from the merged source and staged; continue the merge or rebase."

# The one path that keeps both services in step. Skew is the price of running them
# separately (ADR 0006); this is what stops it happening by simple forgetfulness.
#
# Which API it restarts depends on which one is loaded, so this one target is correct before the
# cutover and after it, and after a rollback. There is no alembic step for the TypeScript service:
# its schema is declared, not migrated (ADR 0009 phase 4).
deploy:
	git pull --ff-only
	@if launchctl print gui/$$(id -u)/$(API_LABEL) >/dev/null 2>&1; then \
		echo "the TypeScript API is loaded"; \
		npm install --silent; \
		cp $(TS_DB) $(TS_DB).bak-$$(date +%Y%m%d-%H%M%S); \
		$(MAKE) launchd-api-restart; \
	else \
		echo "the Python service is loaded"; \
		uv sync --quiet; \
		cp data/optionality.db data/optionality.db.bak-$$(date +%Y%m%d-%H%M%S); \
		OPTIONALITY_DB_PATH=data/optionality.db uv run alembic upgrade head; \
		$(MAKE) launchd-restart; \
	fi
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

# --- the cutover (ADR 0009 phase 9) --------------------------------------------------------------
#
# One agent at a time. The Python keeps its database and never opens the new one, so a rollback loses
# nothing that existed before the window — only what was entered during it, which is retypable.
#
# Read docs/cutover.md first. The Telegram test at the end is the owner's, not the agent's.
# Every step after the Python stops restores it on failure. The window where nothing is running should
# be as short as possible, and it must not be left open by a step that did not work.
cutover: cutover-preflight
	@echo "--- stopping the Python service"
	-launchctl bootout gui/$$(id -u)/$(LAUNCHD_LABEL)
	@echo "--- copying the database, verified field by field"
	@node backend/tools/copy-db/copy.ts data/optionality.db $(TS_DB) \
		|| { $(MAKE) --no-print-directory restore-python; echo "the copy failed; the Python service is back"; exit 1; }
	@uv run --env-file .env python backend/tools/copy-db/python_can_read.py $(TS_DB).snapshot $(TS_DB) \
		|| { rm -f $(TS_DB)*; $(MAKE) --no-print-directory restore-python; \
			 echo "the Python could not read the copy; it is back, and the copy is removed"; exit 1; }
	@echo "--- starting the TypeScript API on 31415"
	@$(MAKE) --no-print-directory launchd-api-install \
		|| { $(MAKE) --no-print-directory restore-python; echo "the API would not install; the Python service is back"; exit 1; }
	@sleep 4
	@curl -fsS http://127.0.0.1:31415/health > /tmp/optionality-cutover-health.json \
		|| { $(MAKE) --no-print-directory rollback; echo "the new API did not answer; rolled back"; exit 1; }
	@python3 -c "import json;h=json.load(open('/tmp/optionality-cutover-health.json'));\
print('  db      ', h['db']);print('  opend   ', h['opend']);print('  alarms  ', h['monitor']['alarms']['label']);\
print('  sweep at', h['monitor']['last_sweep_at'])"
	@echo
	@echo "cutover done. Now the one test that cannot be automated — see docs/cutover.md."

# used by cutover's failure paths; not a step to run on its own
restore-python:
	-launchctl bootstrap gui/$$(id -u) $(LAUNCHD_PLIST)

# Everything that has to be true before the switch, each checked rather than assumed. recovery.sh is
# the one that bites silently: it lives outside the repo, rebuilds the whole tailscale table, and as
# written would start the Python on a port Node holds.
cutover-preflight:
	@test -n "$(NODE_BIN)" || { echo "node not found"; exit 1; }
	@test ! -f $(TS_DB) || { echo "$(TS_DB) exists — move it aside deliberately"; exit 1; }
	@grep -q 'com.optionality.api' $(HOME)/recovery.sh \
		|| { echo "~/recovery.sh still boots only the Python agent — see docs/cutover.md"; exit 1; }
	@node -e 'import("./backend/src/opend.ts").then(async m => { \
		const port = Number(process.env.MOOMOO_WS_PORT || 33333); \
		if (!await m.probeOpend("127.0.0.1", port)) { console.error("OpenD is not listening on " + port); process.exit(1); } \
		console.log("OpenD answers on " + port); })' 
	$(MAKE) check-api
	npm test --workspace backend
	@echo "preflight passed"

# Stop Node, start Python. Its database was never opened by the new service.
rollback:
	-launchctl bootout gui/$$(id -u)/$(API_LABEL)
	rm -f $(API_PLIST)
	launchctl bootstrap gui/$$(id -u) $(LAUNCHD_PLIST)
	@sleep 3
	@curl -fsS http://127.0.0.1:31415/health | head -c 200; echo
	@echo "rolled back to the Python service"

launchd-api-install:
	@test -n "$(NODE_BIN)" || { echo "node not found"; exit 1; }
	mkdir -p $(HOME)/Library/LaunchAgents $(HOME)/Library/Logs
	sed -e 's|__NODE__|$(NODE_BIN)|g' -e 's|__REPO__|$(CURDIR)|g' -e 's|__HOME__|$(HOME)|g' \
		deploy/optionality-api.launchd.plist.template > $(API_PLIST)
	plutil -lint $(API_PLIST)
	launchctl bootstrap gui/$$(id -u) $(API_PLIST)

launchd-api-restart:
	launchctl kickstart -k gui/$$(id -u)/$(API_LABEL)

launchd-api-uninstall:
	-launchctl bootout gui/$$(id -u)/$(API_LABEL)
	rm -f $(API_PLIST)

api-logs:
	tail -f $(HOME)/Library/Logs/optionality-api.log

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
