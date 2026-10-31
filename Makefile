.PHONY: check lint check-boundaries check-make-targets cases check-cases format test test-ui test-ui-fast test-ui-layout test-api typecheck check-api \
	launchd-api-install launchd-api-restart launchd-api-uninstall api-logs \
	serve build-ui check-ui check-served-root resolve-ui deploy \
	launchd-ui-install launchd-ui-restart launchd-ui-uninstall ui-logs \
	backup restore launchd-backup-install launchd-backup-uninstall backup-logs

API_LABEL = com.optionality.api
API_PLIST = $(HOME)/Library/LaunchAgents/$(API_LABEL).plist
UI_LABEL = com.optionality.ui
UI_PLIST = $(HOME)/Library/LaunchAgents/$(UI_LABEL).plist
BACKUP_LABEL = com.optionality.backup
BACKUP_PLIST = $(HOME)/Library/LaunchAgents/$(BACKUP_LABEL).plist
NODE_BIN = $(shell command -v node)
CADDY_BIN = $(shell command -v caddy)
# the service's database. The retired Python's, data/optionality.db, does not sit beside it any
# more: it went into the backups' archive/ on 2026-10-17 (see CLAUDE.md).
TS_DB = data/optionality-ts.db
# where the nightly backups go: iCloud Drive, so they leave this machine (chosen 2026-10-17). The
# default is the destination ON PURPOSE — a reinstall that forgot the argument must not quietly move
# them back onto the disk they protect. Override with BACKUP_DIR=<path>.
BACKUP_DIR ?= $(HOME)/Library/Mobile Documents/com~apple~CloudDocs/optionality-backups

# where the dashboard is mounted on the tailnet. Baked into the bundle at build time,
# because `tailscale serve` strips the prefix and the page cannot discover it (ADR 0006).
UI_BASE ?= /opt/

# ruff for the Python, and the package boundaries for everything (ADR 0014): no package may reach
# into another's source tree, only into what it publishes. See tools/check-boundaries.mjs.
lint: check-boundaries check-make-targets check-served-root
	uv run --directory python ruff check .

check-boundaries:
	node tools/check-boundaries.mjs

# frontend/dist is the live document root, not just a committed artefact: a target that deletes it
# takes the dashboard down. See tools/check-served-root.mjs.
check-served-root:
	node tools/check-served-root.mjs

# Every `make <target>` named in the code or in CLAUDE.md is one this file has. Two differentials
# were deleted with the Python they compared against and nine comments went on naming them as the
# live check. See tools/check-make-targets.mjs.
check-make-targets:
	node tools/check-make-targets.mjs

# the Python only: the TypeScript has no formatter, by decision (CLAUDE.md says why)
format:
	uv run --directory python ruff format .

# the Python package's suite (ADR 0014): every golden case in testdata/golden/, and the OpenD client with fakes
test:
	uv run --directory python pytest

# EVERYTHING a commit must pass, fastest first. Each target below guards one thing, and running a
# subset is how a commit could pass while the canonical TypeScript broke — `make test` alone is only
# the Python. check-ui comes last because it rebuilds the bundle.
check: lint typecheck check-api check-cases test test-api test-ui check-ui
	@echo "all checks passed"

# The TypeScript API, which is what "the API" has meant since phase 9 (ADR 0009) — this ran uvicorn,
# so the documented way to "run the API locally" started the retired implementation instead.
#
# Three things are forced, because the live service is always running on this box:
#   a SNAPSHOT database  taken with the online backup, never cp (CLAUDE.md). A second sweeper
#                        writing live rows can stamp last_alarm_at and suppress a real alarm's
#                        cooldown, so a local instance gets its own copy of the real data.
#   TELEGRAM_* blank     belt and braces, NOT the thing that keeps the bot off: the bot is gated on
#                        OPTIONALITY_BOT=1 (main.ts), which only the plist sets, so a local run
#                        never polls getUpdates in the first place. Blanking the pair stops a local
#                        instance SENDING anything — a sweep here must not message the owner.
#                        Shell variables beat --env-file, which is what makes the blanking bite.
#   a long sweep         one sweep at startup is unavoidable (the loop fires immediately, on
#                        purpose), and 3600 stops it becoming a second sweeper after that.
# PORT is left alone: main.ts defaults to 31417, so it cannot collide with the live 31415.
SERVE_DB = data/optionality-ts.db.serve
serve:
	node backend/tools/backup/backup.ts $(TS_DB) $(SERVE_DB)
	OPTIONALITY_DB_PATH=$(SERVE_DB) TELEGRAM_BOT_TOKEN= TELEGRAM_CHAT_ID= \
	  MONITOR_INTERVAL_SECONDS=3600 node --env-file=.env backend/src/main.ts

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
# It builds somewhere else and compares. frontend/dist is the directory CADDY SERVES — the UI
# agent's OPTIONALITY_UI_ROOT points straight at it and file_server reads from disk per request —
# so this used to begin `rm -rf frontend/dist` and took the live dashboard down for the length of
# every check, and left it down if the build failed. CLAUDE.md says to run `make check` before
# every commit, so that was several times a day.
#
# The rm was there for a real bug: Tailwind skips .gitignore'd paths, frontend/dist is deliberately
# not ignored, so a build with a dist in place was scanning its own previous output and emitting
# 3KB of utilities that existed only because a former build mentioned them. That cause is gone —
# app.css pins `@import "tailwindcss" source(".")`, which scopes the scan to frontend/src — and the
# rm with it: measured 2026-10-31, a build with a dist present and one without are byte-identical,
# same content hashes in both filenames.
#
# Comparing the fresh build against the tree ON DISK, not `git diff`, which is a different claim.
# A rebuild renames the hashed assets, so the new files are untracked and the old ones deleted;
# git diff reported that as "stale" until they were staged, which made `make build-ui && make
# check` fail for a reason that had nothing to do with the bundle being right.
check-ui:
	@npm install --silent
	@out=$$(mktemp -d); \
	if ! (cd frontend && VITE_BASE=$(UI_BASE) npx vite build --outDir $$out --emptyOutDir >/dev/null 2>&1); then \
		rm -rf $$out; echo "the frontend build failed"; exit 1; \
	fi; \
	if diff -r $$out frontend/dist >/dev/null; then \
		rm -rf $$out; echo "frontend bundle matches its source"; \
	else \
		rm -rf $$out; \
		echo "frontend bundle is stale — run 'make build-ui' and commit the result"; exit 1; \
	fi

# Resolve a frontend/dist conflict, which is the only kind this repo produces regularly.
#
# Two branches that both touch the frontend commit different bundles, so dist collides as a
# rename/rename on the hashed asset plus index.html. Neither side is right and no blend of them
# is either: a build has exactly one correct answer for the merged source. So this rebuilds from
# the merged source and stages whatever comes out. (It used to `rm -rf frontend/dist` first; that
# is both unnecessary — vite empties its own outDir — and the live document root, see check-ui.) Source conflicts must be settled first — the bundle is built FROM them —
# and it refuses to run while any remain rather than baking a conflict marker into the output.
resolve-ui:
	@unresolved=$$(git diff --name-only --diff-filter=U | grep -v '^frontend/dist/' || true); \
	if [ -n "$$unresolved" ]; then \
		echo "source conflicts remain; the bundle is built from these, so settle them first:"; \
		echo "$$unresolved" | sed 's/^/  /'; \
		exit 1; \
	fi
	$(MAKE) build-ui
	git add -A frontend/dist
	@echo "frontend/dist rebuilt from the merged source and staged; continue the merge or rebase."

# The one path that keeps both services in step. Skew is the price of running them
# separately (ADR 0006); this is what stops it happening by simple forgetfulness.
#
# The backup is taken with SQLite's online backup, NOT `cp`. In WAL mode `cp` copies the main file
# and leaves the write-ahead log beside it, so the copy is current only as far as the last
# checkpoint — measured at 1 row of 500 on a scratch database, and still valid SQLite, which is
# what makes it dangerous. This backup is the one taken immediately before a migration runs.
#
# The schema step is the service's own: `main.ts` applies what is pending in
# backend/src/db/migrations at boot and fails fatally if one does not (ADR 0011).
deploy:
	git pull --ff-only
	npm install --silent
	node backend/tools/backup/backup.ts $(TS_DB) $(TS_DB).bak-$$(date +%Y%m%d-%H%M%S)
	node backend/tools/backup/prune-deploy.ts data
	$(MAKE) launchd-api-restart
	$(MAKE) launchd-ui-restart
	@echo "both services restarted"

# First contact with an IBKR gateway (ADR 0015, PR 6). NOT part of `make check`: it reaches a real
# gateway, which no test may do. Safe while the live service runs — it opens the database read-only,
# writes nothing and sends nothing — but it does spend market-data calls on both providers. The
# readings it reports are pure functions, tested in backend/src/ibkr/first-contact.test.ts.
ibkr-first-contact:
	node --env-file=.env backend/tools/ibkr-first-contact.ts $(ARGS)

# A stub gateway for the harness above, so its wiring can be exercised before an account exists.
# It answers NO real market data; a report from a run against it proves the harness, nothing else.
ibkr-fake-gateway:
	node backend/tools/ibkr-fake-gateway.ts

# The golden cases (ADR 0014): what the TypeScript domain computes, which the Python package must
# reproduce exactly. Generated, never edited; `test-api` fails too when they are stale.
cases:
	node backend/tools/cases.ts

check-cases:
	node backend/tools/cases.ts --check

# the TypeScript backend (ADR 0009). No build target: Node runs the source directly, so there
# is nothing to compile and nothing to commit — the frontend's dist has no backend equivalent.
test-api:
	npm install --silent && npm test --workspace backend

typecheck:
	npm install --silent && npm run typecheck

# tsc is not enough. Node runs the backend by ERASING types, so syntax that would have to EMIT code
# is rejected at load time — and tsc accepts it while vitest transforms it, so neither notices. Two
# classes reached main unable to load at all. See backend/tools/check-loads.ts.
check-api:
	node backend/tools/check-loads.ts

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

# The nightly backup: a checked, gzipped online copy of the live database, kept 14 nights and 12
# monthly (backend/tools/backup/nightly.ts). `make backup` runs it now; the agent runs it at 06:00.
# Restore with `make restore FROM=...`, never by copying a file over $(TS_DB) (see restore.ts).
backup:
	node backend/tools/backup/nightly.ts $(TS_DB) "$(BACKUP_DIR)"

# Put a nightly backup back: stops the API, restores (keeping what it replaces), starts the API, whose
# boot migrates an older file forward. FROM is a file from $(BACKUP_DIR).
restore:
	@test -n "$(FROM)" || { echo "usage: make restore FROM=$(BACKUP_DIR)/optionality-ts-YYYYMMDD.db.gz"; exit 1; }
	-launchctl bootout gui/$$(id -u)/$(API_LABEL)
	@while launchctl print gui/$$(id -u)/$(API_LABEL) >/dev/null 2>&1; do sleep 1; done
	node backend/tools/backup/restore.ts "$(FROM)" $(TS_DB)
	launchctl bootstrap gui/$$(id -u) $(API_PLIST)
	@sleep 3; curl -fsS http://127.0.0.1:31415/health | head -c 200; echo

launchd-backup-install:
	@test -n "$(NODE_BIN)" || { echo "node not found"; exit 1; }
	mkdir -p $(HOME)/Library/LaunchAgents $(HOME)/Library/Logs "$(BACKUP_DIR)"
	-launchctl bootout gui/$$(id -u)/$(BACKUP_LABEL) 2>/dev/null
	sed -e 's|__NODE__|$(NODE_BIN)|g' -e 's|__REPO__|$(CURDIR)|g' -e 's|__HOME__|$(HOME)|g' \
		-e "s|__BACKUP_DIR__|$$(cd "$(BACKUP_DIR)" && pwd)|g" \
		deploy/optionality-backup.launchd.plist.template > $(BACKUP_PLIST)
	plutil -lint $(BACKUP_PLIST)
	launchctl bootstrap gui/$$(id -u) $(BACKUP_PLIST)

launchd-backup-uninstall:
	-launchctl bootout gui/$$(id -u)/$(BACKUP_LABEL)
	rm -f $(BACKUP_PLIST)

backup-logs:
	tail -f $(HOME)/Library/Logs/optionality-backup.log

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

ui-logs:
	tail -f $(HOME)/Library/Logs/optionality-ui.log
