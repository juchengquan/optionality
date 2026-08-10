.PHONY: lint format test serve launchd-install launchd-restart launchd-uninstall logs

LAUNCHD_LABEL = com.optionality.service
LAUNCHD_PLIST = $(HOME)/Library/LaunchAgents/$(LAUNCHD_LABEL).plist
UV_BIN = $(shell command -v uv)

lint:
	uv run ruff check .

format:
	uv run ruff format .

test:
	uv run pytest

serve:
	uv run --env-file .env uvicorn --factory optionality.service.app:create_app --host 0.0.0.0 --port 8000

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

logs:
	tail -f $(HOME)/Library/Logs/optionality.log
