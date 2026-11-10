"""The process: `python -m optionality_backend --env-file=.env`, which is what launchd runs when the
Python is the live backend (`tools/use-backend.mjs`). Port of backend/src/main.ts.

The whole service: the routes, the alarm engine and its sweep loop, and the bot. It runs from the
working tree, as the TypeScript does: uv installs the workspace editable, so what is checked out is
what runs (ADR 0021).

**The bot is NOT started unless OPTIONALITY_BOT=1** — and Telegram has both a token and a chat. The
token allows one getUpdates consumer (CLAUDE.md), and only the launchd plist sets the flag, so `make
serve` and every other local run cannot become a second consumer and take a random half of the owner's
commands. It is BUILT either way, as `main.ts` builds it, and stopped first on the way out.

**The order is the lock's** (`entrypoints/http/listen.py` says why each step is where it is): `.env`,
the port, settings, the database and its migrations, the vendors, the sweep built, the app attached,
the bot built, the sweep started, the bot started, the startup line.

**Every way out of this process says so on the way.**

On 2026-10-16 the service restarted at 15:55:45 and nothing in its own log said why: no
`SIGTERM: stopping`, no crash report for it, no launchd record.

Explained on 2026-10-17, and it was not this service: the MACHINE panicked. The report is
/Library/Logs/DiagnosticReports/panic-full-2026-10-16-155443.0002.panic — "userspace watchdog timeout:
no successful checkins from WindowServer in 120 seconds" — after half an hour of memory pressure. A
panic signals nothing, so no handler here could have logged it. It did not heal itself either:
LaunchAgents load at GUI login, not at boot, and FileVault is on, which disables automatic login, so
nothing ran until the console login 22 minutes later. For the next unexplained restart, look first at
`last` (a reboot with no shutdown) and at DiagnosticReports for a `.panic`.

What IS this process's is readable: `exit_now` writes `process exiting with code N (pid P)` on every
path out — a clean stop, a refusal at boot, an error nobody caught — so the log always ends with a line
saying which. An error nobody caught still exits non-zero: a server that keeps serving after one is in
a state nobody has reasoned about, which is worse than a restart launchd will perform anyway.

**Where the Python differs, and why.**

- **`.env` is read here**, from `--env-file=<path>`, with `env.load_env_file`: Node reads it for
  `main.ts` before `main.ts` runs, and Python has no such flag. Read first, the environment winning
  over the file and a later file over an earlier one, as Node's; a missing file is refused as Node
  refuses it — `<path>: not found`, exit 9 — before the port is taken.
- **Leaving is `os._exit`, never the interpreter's own exit.** `process.exit` ends a Node process
  whatever is still running. Python's exit first JOINS every thread that is not a daemon, and a vendor
  that blocks runs on one (`vendors.Worker`): the moomoo SDK's connect retries a dead OpenD for ever,
  inside its constructor, so a process stopped during an OpenD outage would wait for OpenD, or for
  launchd's SIGKILL — with no exit line, which is the one thing this module promises. So every way out
  goes through `exit_now`, which says so, flushes, and leaves as `process.exit` does. Nothing is lost
  that Node keeps: the stop below closes what it opened first, and the database is SQLite in WAL mode,
  as safe under an abrupt exit as under Node's. Held by `tests/test_main.py`, against a dead OpenD.
- **The stop waits for the server, at most `CLOSE_SECONDS`.** `held.server.close()` is not awaited in
  the TypeScript, and `process.exit` cuts whatever request is in flight. Stopping uvicorn is a flag and
  the task that serves (`listen.py`), so it is awaited, which lets a request answered from the database
  finish; one still waiting on a vendor after that is cut, as Node cuts every one.
- **The signal handlers are installed first**, where `main.ts` installs them last. Until they are, a
  SIGTERM ends a Node process without a word and an asyncio one by cancelling it from inside: here it
  is noted, and the stop runs once the service is up. **An error nobody caught** is Node's
  `uncaughtException` and `unhandledRejection`; asyncio's one place for both is the loop's exception
  handler, which by default only logs and carries on, so `on_loop_error` makes it fatal. A task started
  and never awaited — `void sweeper.health.recordStall(age)`, `void bot.run()` — is `unawaited`, which
  routes its failure there rather than leaving it to the garbage collector to notice, and begins it at
  once, as JavaScript begins it: the long poll has asked for its first updates by the startup line.
- **The flag is read from the environment, the rest through Settings**, as `main.ts` reads them: `"1"`
  exactly, and a token and a chat that are not blank.
- **Logging is configured here and nowhere else** (README, "Porting a module"): bare lines, as
  `console` prints them, INFO and below to stdout and WARNING and above to stderr, as `console.log` and
  `console.error` split them. The service's own loggers speak at INFO; a library's only at WARNING,
  because what Node's libraries never print, Python's do — httpx2 logs every request at INFO, and
  Telegram's URL carries the bot token. This module's logger is named, not `__name__`, which is
  `__main__` when run with `-m` and would sit outside `optionality_backend`'s level.
"""

import argparse
import asyncio
import contextlib
import logging
import os
import signal
import sys
from collections.abc import Coroutine, Sequence
from datetime import UTC, datetime
from typing import Any, NoReturn, TextIO

from optionality.js import number

from .db.migrate import migrate
from .db.open import open_database
from .engine import STALE_AFTER_SWEEPS, MonitorSweeper, Scheduler, SweeperDeps, SweepWatchdog
from .entrypoints.bot.bot import BotDeps, TelegramBot
from .entrypoints.http import Deps, create_app, take_port
from .env import load_env_file, settings_from_env
from .telegram import telegram_api, telegram_sender
from .vendors import open_vendors

log = logging.getLogger("optionality_backend.__main__")

#: How long a stop waits for requests already in flight (see "Where the Python differs").
CLOSE_SECONDS = 5
#: `node --env-file` exits with this when the file is not there
ENV_FILE_MISSING = 9


def configure_logging(stdout: TextIO | None = None, stderr: TextIO | None = None) -> None:
    """Where the logs go, as `console` sends them: bare lines, `log`/`info` to stdout and `warn`/`error`
    to stderr. The service's loggers at INFO, everyone else's at WARNING."""
    out = logging.StreamHandler(stdout or sys.stdout)
    out.addFilter(lambda record: record.levelno < logging.WARNING)
    err = logging.StreamHandler(stderr or sys.stderr)
    err.setLevel(logging.WARNING)
    for handler in (out, err):
        handler.setFormatter(logging.Formatter("%(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [out, err]
    root.setLevel(logging.WARNING)
    logging.getLogger("optionality_backend").setLevel(logging.INFO)


def exit_now(code: int) -> NoReturn:
    """`process.exit(code)`, saying so as `main.ts`'s `exit` handler does. Leaves at once, threads and
    all: the module docstring says why it must."""
    log.error("process exiting with code %d (pid %d)", code, os.getpid())
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(Exception):
            stream.flush()
    os._exit(code)


def _fatal(event: str, message: object, err: BaseException | None) -> NoReturn:
    log.error("FATAL %s — exiting: %s", event, message, exc_info=err)
    exit_now(1)


def on_loop_error(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
    """The loop's exception handler: whatever reaches it is an error nobody caught, and fatal. A task's
    is Node's `unhandledRejection`; a callback's, a timer's included, is its `uncaughtException`."""
    event = "unhandledRejection" if "task" in context or "future" in context else "uncaughtException"
    err = context.get("exception")
    _fatal(event, err if err is not None else context.get("message"), err)


#: every `unawaited` task not yet settled: the loop holds a task only weakly
_unawaited: set[asyncio.Task[Any]] = set()


def unawaited(work: Coroutine[Any, Any, Any]) -> None:
    """`void promise`: begun at once, as JavaScript begins it, held until it settles, and a failure it
    ends with handed to the loop's exception handler — Node's `unhandledRejection`, which is fatal."""
    loop = asyncio.get_running_loop()

    def settled(task: asyncio.Task[Any]) -> None:
        _unawaited.discard(task)
        if not task.cancelled() and (err := task.exception()) is not None:
            loop.call_exception_handler({"message": "an unawaited task failed", "exception": err, "task": task})

    task = asyncio.Task(work, loop=loop, eager_start=True)
    if task.done():
        settled(task)
    else:
        _unawaited.add(task)
        task.add_done_callback(settled)


def _port(raw: str) -> int:
    """`Number(process.env.PORT ?? 31417)`, refused here where Node's `listen` refuses it."""
    n = number(raw)
    if not (n.is_integer() and 0 <= n < 65536):
        raise RuntimeError(f"PORT is not a port: {raw}")
    return int(n)


async def _run() -> NoReturn:
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(on_loop_error)

    # launchd sends SIGTERM on `kickstart -k`, which is how every deploy restarts this. Stopping in
    # order matters: the scheduler must not arm another sweep while the database is closing.
    stopping = asyncio.Event()

    def on_signal(sig: signal.Signals) -> None:
        if stopping.is_set():
            return
        stopping.set()
        log.info("%s: stopping", sig.name)

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, on_signal, sig)

    # The port, before anything else: it is the lock between the two backends (ADR 0021). Either may
    # be the live one and they share the database, the bot token and the gateway client id, so a second
    # process must stop having touched none of them. Until the app is attached below, requests are
    # answered 503 rather than refused (`listen.py`). `PORT` is read here rather than through Settings
    # so that not even a settings error can come first.
    raw_port = os.environ.get("PORT", "31417")
    try:
        held = await take_port(_port(raw_port))
    except RuntimeError as err:
        log.error("%s: stopping before the database, the vendors or Telegram are touched", err)
        exit_now(1)

    settings = settings_from_env()
    db = open_database(settings.db_path)

    # Before anything serves. The schema and the code that reads it travel together in the working tree
    # (ADR 0009), so they must not be able to get out of step — and a failure here is fatal on purpose:
    # a service that starts on a schema it does not match is worse than one that does not start.
    # launchd's KeepAlive will keep trying, and the log will say which migration.
    applied = migrate(db)
    if applied:
        log.info("applied %d migration(s): %s", len(applied), ", ".join(applied))
    send = telegram_sender(settings.telegram_bot_token, settings.telegram_chat_id)

    # Every vendor this build can reach, opened once (ADR 0019): the Provider the alarms read from, and
    # every vendor a Reference may name — the Provider among them, under its own name, so its Reference
    # rows come from the same client. An unknown or unconfigured Provider is fatal here; a Reference
    # vendor that is simply not configured is absent, and a row naming it says so.
    #
    # Everything below takes the port rather than this: only `/health` and the shutdown need the
    # Provider itself.
    vendors = open_vendors(settings)
    provider = vendors.provider

    scheduler = Scheduler()
    sweeper = MonitorSweeper(SweeperDeps(db=db, settings=settings, fetch_quotes=provider.fetch_quotes, send=send))

    deps = Deps(
        settings=settings,
        db=db,
        now=lambda: datetime.now(UTC),
        # the engine's health account, which is exactly what `SweeperPort` asks for (health.py): the
        # routes get the account and not the engine, so no route can start a sweep
        sweeper=sweeper.health,
        provider=provider,
        sources=vendors.sources,
    )

    # 127.0.0.1 (take_port's default): reachable only via the tailscale serve proxy and localhost,
    # never the LAN. Requests stop being answered 503 from here.
    held.serve(create_app(deps))

    bot = TelegramBot(
        BotDeps(
            db=db,
            settings=settings,
            api=telegram_api(settings.telegram_bot_token),
            fetch_quotes=provider.fetch_quotes,
            sweeper=sweeper.health,
        )
    )

    # Sweep at once as well as on the interval. Without that every restart left the alarm engine quiet
    # for a whole MONITOR_INTERVAL_SECONDS — and restarts happen after every merge.
    scheduler.start_sweep(
        settings.monitor_interval_seconds,
        sweeper.sweep,
        SweepWatchdog(
            # the same age at which the engine calls itself stalled, so the two agree: /health says it,
            # and the next tick does something about it rather than coalescing behind a sweep that is
            # not coming back. The vendor's request deadline should mean this never fires; it fired on
            # 2026-10-16 because nothing bounded the ask.
            stall_after_seconds=settings.monitor_interval_seconds * STALE_AFTER_SWEEPS,
            on_stall=lambda age: unawaited(sweeper.health.record_stall(age)),
        ),
    )

    # one getUpdates consumer per token: only the plist sets the flag
    bot_wanted = os.environ.get("OPTIONALITY_BOT") == "1" and bool(
        settings.telegram_bot_token and settings.telegram_chat_id
    )
    if bot_wanted:
        await bot.start()
        unawaited(bot.run())

    log.info(
        "optionality backend on 127.0.0.1:%d — reading %s, sweeping every %ss, references from %s, bot %s",
        held.port,
        provider.name,
        settings.monitor_interval_seconds,
        # every vendor that opened, so the log says which Reference sources this build actually has
        ", ".join(sorted(vendors.sources)),
        "polling" if bot_wanted else "not started (set OPTIONALITY_BOT=1)",
    )

    await stopping.wait()
    # in `main.ts`'s order: the bot, the scheduler, the server, the vendors, the database
    bot.stop()
    scheduler.stop_sweep()
    try:
        async with asyncio.timeout(CLOSE_SECONDS):
            await held.close()
    except TimeoutError:
        log.warning("the server had requests in flight after %ds: they are cut", CLOSE_SECONDS)
    # one loop over everything that opened, the Provider included: a vendor cannot be forgotten here by
    # growing a connection later
    vendors.close()
    db.close()
    exit_now(0)


async def _serve() -> NoReturn:
    try:
        await _run()
    except BaseException as err:  # noqa: BLE001 — every way out says so; this is an error nobody caught
        _fatal("uncaughtException", err, err)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m optionality_backend", description="The optionality service.")
    parser.add_argument(
        "--env-file",
        action="append",
        default=[],
        metavar="PATH",
        help="read variables from this file, as node --env-file does; the environment wins over it",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> NoReturn:
    configure_logging()
    try:
        args = _parser().parse_args(argv)
    except SystemExit as refused:  # argparse has said why
        exit_now(refused.code if isinstance(refused.code, int) else 2)
    try:
        # `.env` before anything, as Node reads it before `main.ts` runs: the last file wins over the
        # ones before it, and the environment over every file
        for path in reversed(args.env_file):
            try:
                load_env_file(path)
            except FileNotFoundError:
                log.error("%s: not found", path)
                exit_now(ENV_FILE_MISSING)
        asyncio.run(_serve())
    except BaseException as err:  # noqa: BLE001 — every way out says so; this is an error nobody caught
        _fatal("uncaughtException", err, err)
    exit_now(1)  # not reached: `_serve` always leaves through `exit_now`


if __name__ == "__main__":
    main()
