.PHONY: check lint check-boundaries check-test-support check-seams check-module-map check-make-targets cases check-cases scenarios check-scenarios format test test-ui test-ui-fast test-ui-layout test-lib test-api typecheck check-api \
	launchd-api-install launchd-api-restart launchd-api-uninstall api-logs \
	serve build-ui check-ui check-served-root resolve-ui deploy deploy-backup use \
	launchd-ui-install launchd-ui-restart launchd-ui-uninstall ui-logs \
	backup restore launchd-backup-install launchd-backup-uninstall backup-logs \
	launchd-opend-install launchd-opend-uninstall opend-logs check-opend opend-sync \
	test-tools py-cut py-tag ibkr-fake-gateway check-py-backend

API_LABEL = com.optionality.api
API_PLIST = $(HOME)/Library/LaunchAgents/$(API_LABEL).plist
UI_LABEL = com.optionality.ui
UI_PLIST = $(HOME)/Library/LaunchAgents/$(UI_LABEL).plist
OPEND_LABEL = com.optionality.opend
OPEND_PLIST = $(HOME)/Library/LaunchAgents/$(OPEND_LABEL).plist

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
#
# Both Python packages are members of ONE uv workspace (the root pyproject.toml, ADR 0021), so each
# `uv run --directory` below shares the root's .venv and uv.lock and reads its own [tool.ruff].
# `format --check` because nothing ran it: the library drifted eleven files from `make format`
# while every gate stayed green. `make format` fixes what it reports.
lint: check-boundaries check-test-support check-seams check-module-map check-make-targets check-served-root check-py-backend
	uv run --directory python ruff check .
	uv run --directory python ruff format --check .
	uv run --directory python-backend ruff check .
	uv run --directory python-backend ruff format --check .

check-boundaries:
	node tools/check-boundaries.mjs

# The Python backend's three lines (ADR 0021): it reaches the library only through its public
# modules, it places, modifies, cancels and exercises no order outside a `trading/` that does not
# exist, and nothing outside the engine reaches past the engine's door (check-seams' rule, which reads
# no Python). pytest rather than a node script because all three read the Python AST; each file says
# why it refuses what it refuses. `make test` runs them again with the rest of the backend's suite.
check-py-backend:
	uv run --directory python-backend pytest -q tests/test_library_boundary.py tests/test_no_trading.py tests/test_seams.py

# `src/` is the service and `testing/` is the harness that fakes it. Nothing the service runs may
# import the harness — it prices every code it is asked for. See tools/check-test-support.mjs.
check-test-support:
	node tools/check-test-support.mjs

# and the same rule INSIDE a package, for the directories whose whole point is one door:
# `backend/src/vendors/` exists so every market-data vendor is reached through `openVendors` (ADR
# 0015, 0019), and the clients it opens live in the library, `typescript/src/vendors/`, where only
# that door may reach them (ADR 0021). IB Gateway allows one connection per client id and the
# second displaces the first in silence. See tools/check-seams.mjs.
check-seams:
	node tools/check-seams.mjs

# Module for module (ADR 0021): every TypeScript backend module has a Python counterpart, or the
# table in tools/check-module-map.mjs says why not, or it is on a backlog that may only shrink.
check-module-map:
	node tools/check-module-map.mjs

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
	uv run --directory python-backend ruff format .

# the Python package's suite (ADR 0014): every golden case in testdata/golden/, and the OpenD client with fakes
# TZ=UTC, as `cases` is: the corpus is generated under it, so it must be read under it
# and then the Python backend's (ADR 0021), pinned the same way before it has a clock to read
test:
	TZ=UTC uv run --directory python pytest
	TZ=UTC uv run --directory python-backend pytest

# EVERYTHING a commit must pass, fastest first. Each target below guards one thing, and running a
# subset is how a commit could pass while the canonical TypeScript broke — `make test` alone is only
# the Python. check-ui comes last because it rebuilds the bundle.
check: lint typecheck check-api check-cases check-scenarios test test-tools test-lib test-api test-ui check-ui check-opend
	@echo "all checks passed"

# The TypeScript API, which is what "the API" has meant since phase 9 (ADR 0009) — this ran uvicorn,
# so the documented way to "run the API locally" started the retired implementation instead.
#
# Four things are forced, because the live service is always running on this box:
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
#   its own IB client id IB Gateway allows ONE connection per client id and the second displaces
#                        the first in silence (ADR 0019), so a local run on the live service's id
#                        (31415, the default) knocked the live service's References off the gateway
#                        with nothing logged on either side. 31417, like the port. An id rather than
#                        a blank IBKR_HOST, so a local run still reaches the gateway it is testing.
# PORT is left alone: main.ts defaults to 31417, so it cannot collide with the live 31415.
SERVE_DB = data/optionality-ts.db.serve
serve:
	node backend/tools/backup/backup.ts $(TS_DB) $(SERVE_DB)
	OPTIONALITY_DB_PATH=$(SERVE_DB) TELEGRAM_BOT_TOKEN= TELEGRAM_CHAT_ID= IBKR_CLIENT_ID=31417 \
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
# shared/app.css pins `@import "tailwindcss" source("..")`, which scopes the scan to frontend/src — and the
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
# BOTH backends are installed, whichever is live (ADR 0021): npm for the TypeScript, uv for the
# Python, so a switch never waits on an install and a merge that changes either lands in both.
# `--locked` because this is the live checkout: a lock that would have to be rewritten here means
# the merge carried a stale one, and a deploy that dirties the tree breaks the next `git pull`.
# Which backend the API agent runs is READ from its installed plist, never assumed — and a Python
# this tree cannot back (the guard in tools/use-backend.mjs) stops the deploy before the restart.
#
# The schema step is the backend's own: whichever runs applies what is pending in
# schema/migrations/ at boot and fails fatally if one does not (ADR 0011).
deploy:
	git pull --ff-only
	npm install --silent
	uv sync --all-packages --locked
	@backend=$$(node tools/use-backend.mjs installed) && echo "restarting $(API_LABEL), which runs the $$backend backend"
	$(MAKE) deploy-backup
	$(MAKE) launchd-api-restart
	$(MAKE) launchd-ui-restart
	@echo "both services restarted"

# The backup every restart takes first, so it predates whatever migration the restarted backend
# applies at boot: `make deploy`'s and `make use`'s, which are the same backup on purpose.
#
# It is taken with SQLite's online backup, NOT `cp`. In WAL mode `cp` copies the main file
# and leaves the write-ahead log beside it, so the copy is current only as far as the last
# checkpoint — measured at 1 row of 500 on a scratch database, and still valid SQLite, which is
# what makes it dangerous.
deploy-backup:
	node backend/tools/backup/backup.ts $(TS_DB) $(TS_DB).bak-$$(date +%Y%m%d-%H%M%S)
	node backend/tools/backup/prune-deploy.ts data

# Switch the live service between the two backends (ADR 0021, Decision 3): ONE agent label, so
# exactly one is ever loaded. Checked first — the guard and a rendering that lints — so a refused
# switch touches nothing and takes no backup (which would prune an older one); then the backup
# `make deploy` takes; then tools/use-backend.mjs boots the running backend out, waits for it and
# its port to be gone, installs the plist for BACKEND, boots it in and waits for /health to
# answer 200, saying so if it does not.
#
# BACKEND=python is REFUSED while the port is unfinished: the door-scenario backlog not empty,
# no `__main__.py`, or no uv environment for launchd to run. There is no override. A drill —
# the Python live by hand, on the owner's request, never on a schedule — waits for the port.
use:
	@case "$(BACKEND)" in ts|python) ;; *) echo "usage: make use BACKEND=ts|python"; exit 2;; esac
	node tools/use-backend.mjs check $(BACKEND)
	$(MAKE) deploy-backup
	node tools/use-backend.mjs switch $(BACKEND)

# A stub IB Gateway speaking the SOCKET protocol, for driving the TWS client by hand. It replays a
# conversation from testdata/vendors/ibkr-gateway/ (ARGS="--conversation <name>"), each recorded
# from the real gateway or constructed and labelled so, never invented in the stub — a stub
# written from the same reading as the decoder agrees with it, and agrees wrongly if the reading
# was wrong. Proves the client, never the provider.
ibkr-fake-gateway:
	node backend/tools/ibkr-fake-gateway.ts $(ARGS)

# The golden cases (ADR 0014): what the TypeScript domain computes, which the Python package must
# reproduce exactly. Generated, never edited; `test-lib` fails too when they are stale. The same
# pass writes the vendor corpus and what the IB Gateway client makes of each recorded conversation
# (testdata/vendors/ibkr-gateway/expected/, ADR 0021), replayed over loopback in about a second.
#
# TZ=UTC, for the same reason typescript/vitest.config.ts pins it: a function with a default zone
# reads the RUNNING machine's, so `displayTime(when)` wrote +08:00 here and would write +01:00 in
# Berlin. The corpus is shared ground that a third implementation has to agree with (ADR 0017), so
# it cannot depend on where it was generated. The verifier already ran under UTC and the generator
# did not, which is how a case written by `make cases` could fail `make test-api` on the same
# machine — found by adding the first case that omitted a zone.
cases:
	TZ=UTC node tools/cases.ts
	$(MAKE) scenarios

check-cases:
	TZ=UTC node tools/cases.ts --check

# The door scenarios (ADR 0021): a world, one request, Telegram message or sweep tick, and exactly
# what the service did — the shared ground a second backend is held to at the service's three
# doors. Generated from backend/testing/scenarios/inputs/, never edited; `test-api` replays every
# file and fails when a door can do something no scenario shows.
#
# Regenerated by `make cases` as well, and not merely beside it: `/health` reports the golden
# fingerprint, so a domain change that rewrites the cases rewrites a scenario too. TZ=UTC for the
# cases' reason. The generator lives under backend/testing/ because it runs the service on fake
# vendors, and only test support may import those (check-test-support).
scenarios:
	TZ=UTC node backend/testing/scenarios/generate.ts

check-scenarios:
	TZ=UTC node backend/testing/scenarios/generate.ts --check

# The repo-wide tools' own arithmetic (ADR 0016) — the release version in particular, which is
# where a version scheme goes wrong silently. Its own invocation because tools/ is not a package:
# it is what reads and writes ACROSS the packages, so neither workspace's suite covers it.
test-tools:
	npx vitest run --root tools

# Cutting a release of the Python package (ADR 0016). Two steps, because CLAUDE.md forbids pushing
# to main: the version bump is a commit and goes through a PR like anything else, so only the tag
# can be applied afterwards. The refusals live in the script, which is tested.
#
# TZ=UTC because the version IS a date and a notebook pins it: `calver()` reads the machine's zone,
# so a cut near midnight names a different day in Singapore than in Berlin. Its own suite passes
# explicit dates, so it can never notice — the only place the zone can be fixed is here.
py-cut:
	TZ=UTC node tools/py-release.mjs --cut

py-tag:
	node tools/py-release.mjs --tag

# the TypeScript library (ADR 0021): the domain, the vendor clients, and the golden cases' own
# guards — `cases.test.ts` is what fails when the corpus is stale or a domain export has no case.
# Named by its npm name, `optionality`; its directory is `typescript/` (the compiler owns that name).
test-lib:
	npm install --silent && npm test --workspace optionality

# the TypeScript backend (ADR 0009). No build target: Node runs the source directly, so there
# is nothing to compile and nothing to commit — the frontend's dist has no backend equivalent.
test-api:
	npm install --silent && npm test --workspace backend

typecheck:
	npm install --silent && npm run typecheck

# tsc is not enough. Node runs the TypeScript by ERASING types, so syntax that would have to EMIT
# code is rejected at load time — and tsc accepts it while vitest transforms it, so neither
# notices. Two classes reached main unable to load at all. Both packages Node runs, the library
# and the backend. See tools/check-loads.ts.
check-api:
	node tools/check-loads.ts

# A first install, for a machine with no agent loaded: the TypeScript unless BACKEND says otherwise,
# rendered by the same script `make use` uses, so the Python's guard stands here too. Switching an
# agent that is already loaded is `make use`'s.
launchd-api-install:
	mkdir -p $(HOME)/Library/LaunchAgents $(HOME)/Library/Logs
	node tools/use-backend.mjs render $(or $(BACKEND),ts) $(API_PLIST)
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
		deploy/macos/optionality-backup.launchd.plist.template > $(BACKUP_PLIST)
	plutil -lint $(BACKUP_PLIST)
	launchctl bootstrap gui/$$(id -u) $(BACKUP_PLIST)

launchd-backup-uninstall:
	-launchctl bootout gui/$$(id -u)/$(BACKUP_LABEL)
	rm -f $(BACKUP_PLIST)

# Watches OpenD, the one process everything else depends on and the only one nothing was watching
# — it exited unattended on 2026-11-08 and the sweep failed 646 times over 2h42m. A TIMER rather
# than KeepAlive: `~/openD.sh` backgrounds OpenD and returns, so KeepAlive would see the script
# finish and restart it for ever; and KeepAlive can only see whether a process exists, where the
# failure that matters is an OpenD that is up with its websocket port shut. The script's `ensure`
# tells those apart. It calls ~/openD.sh, which is NOT in this repository: it is the owner's and
# predates this agent, and pointing at it beats moving it.
# The account comes from .env and is stamped into the GENERATED plist, which lives outside this
# repository — so it is on disk only where git does not look. `-f2-` keeps everything after the
# first `=`: `-f2` truncates at a second one, which is the careless extraction that wrote the
# literal string `$$ {OPEND_LOGIN_ACCOUNT:-...}` into a config file and sent OpenD into a
# restart loop on 2026-11-08.
OPEND_ACCOUNT = $(shell grep -E '^OPEND_LOGIN_ACCOUNT=' .env 2>/dev/null | head -1 | cut -d= -f2-)

launchd-opend-install:
	@test -x deploy/macos/opend.sh || { echo "deploy/macos/opend.sh missing or not executable"; exit 1; }
	@test -n "$(OPEND_ACCOUNT)" || { echo "OPEND_LOGIN_ACCOUNT is not set in .env — refusing to install an agent that would restart a failing login every 60s"; exit 1; }
	mkdir -p $(HOME)/Library/LaunchAgents $(HOME)/Library/Logs
	-launchctl bootout gui/$$(id -u)/$(OPEND_LABEL) 2>/dev/null
	sed -e 's|__HOME__|$(HOME)|g' -e 's|__REPO__|$(CURDIR)|g' \
		-e 's|__OPEND_ACCOUNT__|$(OPEND_ACCOUNT)|g' \
		deploy/macos/optionality-opend.launchd.plist.template > $(OPEND_PLIST)
	chmod 600 $(OPEND_PLIST)
	plutil -lint $(OPEND_PLIST)
	launchctl bootstrap gui/$$(id -u) $(OPEND_PLIST)
	@echo "watching OpenD every 60s; logs: $(HOME)/Library/Logs/optionality-opend.log"

# Two copies of the control script exist on purpose: this one is committed, and ~/openD.sh must
# keep working with no repository cloned. Two copies of anything drift, and the only question is
# whether you find out — so this is the same arrangement `check-ui` uses for the committed bundle.
# The account line is normalised away because it is the one difference BY DESIGN.
check-opend:
	@a=$$(mktemp); b=$$(mktemp); \
	if [ ! -f $(HOME)/openD.sh ]; then \
		rm -f "$$a" "$$b"; \
		echo "~/openD.sh absent — nothing to compare (this check is for the owner's machine)"; \
	else \
		sed -E 's|^LOGIN_ACCOUNT=.*|LOGIN_ACCOUNT=X|' $(HOME)/openD.sh > "$$a"; \
		sed -E 's|^LOGIN_ACCOUNT=.*|LOGIN_ACCOUNT=X|' deploy/macos/opend.sh > "$$b"; \
		if diff -u "$$a" "$$b" > /dev/null; then \
			rm -f "$$a" "$$b"; echo "~/openD.sh matches deploy/macos/opend.sh"; \
		else \
			echo "~/openD.sh and deploy/macos/opend.sh have DRIFTED — 'make opend-sync', or reconcile by hand:"; \
			diff -u "$$a" "$$b" || true; rm -f "$$a" "$$b"; exit 1; \
		fi; \
	fi

opend-sync:
	@test -f $(HOME)/openD.sh || { echo "~/openD.sh absent; copy deploy/macos/opend.sh there and set its account"; exit 1; }
	@acct=$$(grep -E '^LOGIN_ACCOUNT=' $(HOME)/openD.sh); \
		awk -v a="$$acct" '/^LOGIN_ACCOUNT=/ { print a; next } { print }' deploy/macos/opend.sh > $(HOME)/openD.sh.new && \
		chmod 755 $(HOME)/openD.sh.new && zsh -n $(HOME)/openD.sh.new && \
		mv $(HOME)/openD.sh.new $(HOME)/openD.sh && \
		echo "~/openD.sh synced from deploy/macos/opend.sh, account kept"

launchd-opend-uninstall:
	-launchctl bootout gui/$$(id -u)/$(OPEND_LABEL)
	rm -f $(OPEND_PLIST)

opend-logs:
	tail -f $(HOME)/Library/Logs/optionality-opend.log

backup-logs:
	tail -f $(HOME)/Library/Logs/optionality-backup.log

# the dashboard's own agent: Caddy, serving frontend/dist and nothing else
launchd-ui-install:
	@test -n "$(CADDY_BIN)" || { echo "caddy not found — brew install caddy"; exit 1; }
	mkdir -p $(HOME)/Library/LaunchAgents $(HOME)/Library/Logs
	sed -e 's|__CADDY__|$(CADDY_BIN)|g' -e 's|__REPO__|$(CURDIR)|g' -e 's|__HOME__|$(HOME)|g' \
		deploy/macos/optionality-ui.launchd.plist.template > $(UI_PLIST)
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
