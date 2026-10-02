# The cutover

Replacing the Python service with the TypeScript one (ADR 0009, phase 9). **Read this before running
anything.** One agent runs at a time; the Python keeps its own database and never opens the new one.

## What moves, and what does not

| | before | after |
|---|---|---|
| API | `com.optionality.service` (uvicorn, Python) | `com.optionality.api` (node, TypeScript) |
| port | 127.0.0.1:31415 | **the same** |
| tailscale | `/opt/api` → 31415 | **unchanged** |
| dashboard | `com.optionality.ui` (Caddy) | **unchanged** |
| database | `data/optionality.db` | `data/optionality-ts.db`, a verified copy |
| Telegram bot | the Python's thread | the Node agent, `OPTIONALITY_BOT=1` |

The tailscale serve table does not move, so nothing outside this machine notices. The dashboard is the
same bundle; it was already typed against this API (phase 8) and its shapes were compared against the
Python's, endpoint by endpoint, before that landed.

## Before you start

```sh
make cutover-preflight
```

It checks the things that make the cutover safe and refuses to pretend about any of them: node is
installed, `data/optionality-ts.db` does not already exist, OpenD is reachable on its websocket port,
every module loads under Node, the whole suite passes, and `~/recovery.sh` has been updated.

### `~/recovery.sh` has to change first

It lives outside the repo and it is the source of truth for the tailscale table and both agents. As
written it boots `com.optionality.service`, so running it after the cutover would start the Python on a
port Node already holds — a bind failure, respawned for ever by `KeepAlive` — or, if Node happened to be
down, quietly bring the Python back with a database that has stopped being current.

Make it boot whichever agent is installed, preferring the new one:

```sh
# --- optionality API (127.0.0.1:31415, exposed as /opt/api) -----------------
# Since ADR 0009 phase 9 this is the TypeScript service, com.optionality.api.
# com.optionality.service is the Python one, kept installed as the rollback.
# Exactly one is loaded; this boots whichever plist exists, preferring the new.
if [ -f "$HOME/Library/LaunchAgents/com.optionality.api.plist" ]; then
  OPTIONALITY_AGENT=com.optionality.api
else
  OPTIONALITY_AGENT=com.optionality.service
fi
OPTIONALITY_PLIST=$HOME/Library/LaunchAgents/$OPTIONALITY_AGENT.plist
```

The rest of the block — the `kickstart -k` / `bootstrap` choice, and the comment about `bootout` being
asynchronous — is unchanged and still right.

## The cutover

```sh
make cutover
```

In order: it runs the gates, stops the Python agent, copies the database and verifies it **field by
field** (211 values) and then again through SQLAlchemy (194 values, with their Python types, plus
`alembic current` at head), installs the Node agent on 31415, and reads `/health` back.

It refuses to overwrite an existing `data/optionality-ts.db`, so a second run after a rollback needs
that file moved aside deliberately.

## Then the one test that cannot be automated

Everything else in this rewrite is provable from tests. This is not: it crosses into a phone, through a
token the agent should not be exercising on the owner's behalf.

1. Pick a monitor whose current value is close to its threshold — `/monitors` in the bot, or the
   dashboard's fill bar, shows which.
2. Move the threshold so it will fire on the next sweep. From the phone:
   `/threshold 261030 C8100 <a value just inside the current one>`
3. Wait one sweep interval (`MONITOR_INTERVAL_SECONDS`, 60 by default).
4. **Confirm the Telegram message arrives**, and that it reads the way it always did:
   `⚠️ <name>: option_delta 0.058 crossed ≥ 0.05`
5. Put the threshold back. Confirm the recovery message arrives: `✅ … back below …`

While you are there, the bot is the other thing only a person can check: `/monitors`, `/quotes`,
`/greeks`, `/vol`, `/health` should all come back as tables that fit the screen.

## If anything is wrong

```sh
make rollback
```

Stops Node, removes its plist, and boots the Python agent again. Its database was never opened by the
new service, so everything that existed before the window is intact. Anything entered **during** the
window lives only in `data/optionality-ts.db` and has to be retyped — which is why the window should be
short, and why the first thing to do after a successful cutover is to use it for a day before deleting
anything.

`data/optionality-ts.db` is left in place by the rollback, so nothing is lost by rolling back and
trying again.

## The window

The Python stays installed, and its database stays current as of the cutover minute. Phase 10 — a month
later — deletes the ported Python and the rollback with it. A month is about how long it takes to meet a
weekly edge case: a Friday expiry, a quarantined contract, a gap open.

Two things to watch during it:

- **`/health`** should show `db: true`, `opend: true`, and a `last_sweep_at` that keeps moving.
- **the sweep's own account of itself**: `alarms: active`. `STALLED (n failed sweeps)` means the
  OpenD websocket is not answering, and the Python used the TCP port — so this is the one failure mode
  the cutover newly exposes.
