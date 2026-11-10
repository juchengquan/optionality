"""The process, booted. Port of backend/src/main.test.ts, test for test; what only the Python can get
wrong is after it.

Booting it is the only honest check of the one module that IS the service, so that is what this does:
spawn `python -m optionality_backend` with a setting it must refuse, and read what it says. That proves
three things at once — the module and everything it imports load, a fatal misconfiguration is fatal
rather than a service running on a default, and the message names what to fix. CLAUDE.md calls a boot
failure "fatal on purpose": launchd keeps trying, so the log is the only thing that tells the owner why.

Each refusal must die BEFORE anything is served. The order in `__main__` is the port (it is the lock
between two backends, ADR 0021), then settings, then the database, then the vendors, and only then is
the app attached — so a taken port touches nothing, a refused setting never opens a file, and a refused
Provider opens only the throwaway database named here. The environment is built from nothing rather
than inherited: no bot flag and no Telegram token, so a boot cannot become a second `getUpdates`
consumer or send the owner a message (CLAUDE.md), and `PORT=0` by default, so the port each case takes
first is never the live one.

**The bot is not ported** (`__main__.py` says so, as a partial port must): `TestTheBotIsNotPortedYet`
holds what the process does meanwhile, and goes when the bot lands. No test of the TypeScript's waits
for it — `main.test.ts` never starts the bot.

**What only the Python can get wrong** is a process that will not stop. Node's `process.exit` ends the
process whatever is still running; Python's exit joins every thread that is not a daemon, and a vendor
that blocks — the moomoo SDK, whose connect retries a dead OpenD for ever inside its constructor —
runs on one (`vendors.Worker`). `TestStopping` boots the service against an OpenD that is not there and
stops it mid-retry. That case is the one in this suite that runs the real SDK: against TEST-NET-1 (RFC
5737), which nothing answers, so nothing is reached, with a HOME of its own for the SDK's log files.
"""

import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest
from sweep import insert_monitor

from optionality_backend.db.open import create_database

#: what the service says once it is up, as `main.ts` says it
STARTED = re.compile(
    r"^optionality backend on 127\.0\.0\.1:(?P<port>\d+) — reading (?P<provider>\S+), sweeping every (?P<every>\d+)s, "
    r"references from (?P<sources>[^,]+(?:, [^,]+)*), bot (?P<bot>.+)$"
)
#: the last thing it says, on every way out
EXITING = re.compile(r"^process exiting with code (?P<code>-?\d+) \(pid (?P<pid>\d+)\)$")


@pytest.fixture
def occupy() -> Iterator:
    """A port some other process already holds, as a second backend would find it."""
    held: list[socket.socket] = []

    def take() -> int:
        other = socket.socket()
        other.bind(("127.0.0.1", 0))
        other.listen()
        held.append(other)
        return other.getsockname()[1]

    yield take
    for s in held:
        s.close()


def environment(env: dict[str, str | None]) -> dict[str, str]:
    """Built from nothing, as the TypeScript's is: no bot flag, no Telegram token, port 0. A variable
    given as None is left out altogether."""
    return {k: v for k, v in {"PATH": os.environ.get("PATH", ""), "PORT": "0", **env}.items() if v is not None}


def boot(env: dict[str, str | None], *args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    """Boot it, and give back what it said and how it died. It must exit on its own: killing it would
    make a hung boot look like a refusal, so a boot that does not end fails here instead."""
    try:
        return subprocess.run(
            [sys.executable, "-m", "optionality_backend", *args],
            check=False,
            env=environment(env),
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except subprocess.TimeoutExpired as e:
        pytest.fail(f"it did not exit on its own; it said:\n{e.stdout}\n{e.stderr}")


class TestBootingTheService:
    def test_refuses_a_knob_it_cannot_read_and_says_which_one(self, tmp_path):
        # the failure this is really for: a renamed or mistyped variable silently reverting a setting
        # the owner has made (env.py). It dies before the database is opened.
        died = boot({"MONITOR_INTERVAL_SECONDS": "every minute"}, cwd=tmp_path)
        assert died.returncode != 0, "a service that cannot read its settings must not start"
        assert "MONITOR_INTERVAL_SECONDS" in died.stderr

    def test_takes_the_port_before_it_touches_anything_and_stops_if_another_backend_holds_it(self, occupy, tmp_path):
        # the port is the lock between the two backends (ADR 0021): a second process must die having
        # opened nothing. The database is the witness, because `open_database` creates a missing file:
        # if this boot got as far as the database, the file below would exist afterwards.
        port = occupy()
        db = tmp_path / "never-opened.db"
        died = boot({"PORT": str(port), "OPTIONALITY_DB_PATH": str(db), "MOOMOO_WS_PORT": "1"}, cwd=tmp_path)
        assert died.returncode != 0
        assert re.search(rf"port {port} on 127\.0\.0\.1 is taken", died.stderr), died.stderr
        assert not db.exists(), "a refused boot must not have opened the database"

    def test_refuses_a_provider_no_vendor_carries_naming_the_ones_that_exist(self, tmp_path):
        # past the settings and the migrations, into `open_vendors` — so this also proves the database
        # and vendor layers load. The file is STAMPED rather than left empty, because that is what a
        # real one is: `open_database` opens an existing database and `__main__` migrates it, so an
        # empty file fails on migration 0001 with `no such table: positions` instead of reaching the
        # Provider. (Loud and fatal, as CLAUDE.md intends — but it is not what this case is about.)
        db = tmp_path / "optionality-ts.db"
        create_database(db).close()
        died = boot({"OPTIONALITY_PROVIDER": "nope", "OPTIONALITY_DB_PATH": str(db)}, cwd=tmp_path)
        assert died.returncode != 0
        assert "unknown provider 'nope'" in died.stderr
        assert "moomoo" in died.stderr, "the message must offer the names that do exist"


class TestTheBotIsNotPortedYet:
    """The bot is the part of `main.ts` the Python does not have yet (a partial port: ABSENT, never
    stubbed). Running without it while the plist asks for it would be the quietest failure there is —
    every command the owner sends unanswered, and nothing saying why — so the flag is refused, and
    refused before anything is touched. Goes when the bot is ported."""

    def test_refuses_the_bot_flag_before_it_touches_anything_and_says_the_bot_is_not_ported(self, tmp_path):
        db = tmp_path / "never-opened.db"
        died = boot({"OPTIONALITY_BOT": "1", "OPTIONALITY_DB_PATH": str(db)}, cwd=tmp_path)
        assert died.returncode != 0
        assert re.search(r"OPTIONALITY_BOT=1: the bot is not ported to the Python yet", died.stderr), died.stderr
        assert not db.exists(), "a refused boot must not have opened the database"


class TestTheEnvFile:
    """`--env-file=.env`, which Node reads for `main.ts` before it runs and `__main__` must read before
    anything else (`entrypoints/http/listen.py`). How the file is PARSED is `tests/test_env.py`'s."""

    def test_reads_the_file_before_it_takes_the_port(self, occupy, tmp_path):
        # the plist names the port in the environment, but a `.env` may too, and either way it is the
        # port that is taken — so the file must be read before the lock, not after it. With no PORT in
        # the environment, which would win over the file.
        port = occupy()
        (tmp_path / ".env").write_text(f"PORT={port}\n")
        died = boot({"PORT": None}, "--env-file=.env", cwd=tmp_path)
        assert died.returncode != 0
        assert f"port {port} on 127.0.0.1 is taken" in died.stderr

    def test_lets_the_environment_win_over_the_file(self, tmp_path):
        # as Node does: the plist's variables beat the file's, and `make serve`'s blanks beat its token
        (tmp_path / ".env").write_text("MONITOR_INTERVAL_SECONDS=every minute\nOPTIONALITY_PROVIDER=nope\n")
        db = tmp_path / "optionality-ts.db"
        create_database(db).close()
        died = boot({"MONITOR_INTERVAL_SECONDS": "60", "OPTIONALITY_DB_PATH": str(db)}, "--env-file=.env", cwd=tmp_path)
        assert died.returncode != 0
        assert "MONITOR_INTERVAL_SECONDS" not in died.stderr
        assert "unknown provider 'nope'" in died.stderr, "the rest of the file was read"

    def test_refuses_to_start_without_the_file_as_node_does(self, tmp_path):
        # `node --env-file=.env` says `node: .env: not found` and exits 9 without running a line: a
        # service started on the defaults would sweep and alarm with Telegram blank
        db = tmp_path / "never-opened.db"
        died = boot({"OPTIONALITY_DB_PATH": str(db)}, "--env-file=.env", cwd=tmp_path)
        assert died.returncode == 9
        assert ".env: not found" in died.stderr
        assert not db.exists()


class TestDatabase:
    def test_refuses_a_database_its_migrations_cannot_be_applied_to_and_says_which(self, tmp_path):
        # "fatal on purpose" (CLAUDE.md): a service that starts on a schema it does not match is worse
        # than one that does not start, and the log is what says which migration. An EMPTY file is the
        # case `main.test.ts` steps around above; here it is the point.
        db = tmp_path / "optionality-ts.db"
        db.touch()
        died = boot({"OPTIONALITY_DB_PATH": str(db)}, cwd=tmp_path)
        assert died.returncode != 0
        assert re.search(r"migration 0001\S* failed", died.stderr), died.stderr


class Running:
    """The service, booted and left running: what it has said so far on each stream, as it says it."""

    def __init__(self, env: dict[str, str], cwd: Path) -> None:
        self.process = subprocess.Popen(
            [sys.executable, "-m", "optionality_backend"],
            env=environment(env),
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.said: dict[str, list[str]] = {"stdout": [], "stderr": []}
        self._readers = [
            threading.Thread(target=self._read, args=(name, getattr(self.process, name)), daemon=True)
            for name in self.said
        ]
        for reader in self._readers:
            reader.start()

    def _read(self, name: str, stream) -> None:
        for line in stream:
            self.said[name].append(line.rstrip("\n"))

    def wait_for(self, name: str, pattern: re.Pattern[str] | str, timeout: float = 20) -> re.Match[str]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for line in list(self.said[name]):
                if found := re.search(pattern, line):
                    return found
            if self.process.poll() is not None:
                break
            time.sleep(0.05)
        self.kill()
        pytest.fail(f"never said {pattern!r} on {name}; it said:\n{self.transcript()}")

    def stop(self, sig: signal.Signals, timeout: float = 10) -> int:
        """Signal it, and give back its exit code. It must stop on its own, within `timeout`."""
        self.process.send_signal(sig)
        try:
            code = self.process.wait(timeout)
        except subprocess.TimeoutExpired:
            self.kill()
            pytest.fail(f"still running {timeout}s after {sig.name}; it said:\n{self.transcript()}")
        for reader in self._readers:
            reader.join(5)
        return code

    def kill(self) -> None:
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait()

    def transcript(self) -> str:
        return "\n".join(f"{name}: {line}" for name, lines in self.said.items() for line in lines)


@pytest.fixture
def running(tmp_path) -> Iterator:
    started: list[Running] = []

    def start(env: dict[str, str]) -> Running:
        service = Running(env, tmp_path)
        started.append(service)
        return service

    yield start
    for service in started:
        service.kill()


class TestStopping:
    """Up, and down again: the startup line, the app attached, and every way out saying so. The
    TypeScript has no boot test that gets this far — one needs a database and a vendor that answers
    nothing — and the Python needs one more than it does (see the module docstring)."""

    @pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT])
    def test_says_it_is_up_serves_and_stops_on_a_signal_exiting_0_and_saying_so(self, sig, running, tmp_path):
        # an empty watchlist, so the sweep at once has no codes to ask anybody for
        db = tmp_path / "optionality-ts.db"
        create_database(db).close()
        service = running({"OPTIONALITY_DB_PATH": str(db)})
        started = service.wait_for("stdout", STARTED)
        assert started["provider"] == "moomoo"
        assert started["every"] == "60"
        assert started["sources"] == "moomoo, yahoo", "IBKR_HOST is blank, so ibkr is absent"
        assert started["bot"] == "not started (not ported to the Python yet)"
        port = int(started["port"])
        assert port != 0, "the port actually bound, not the one asked for"
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as answer:
            assert answer.status == 200, "the app is attached by the time it says it is up"

        assert service.stop(sig) == 0
        assert f"{sig.name}: stopping" in service.said["stdout"]
        assert EXITING.match(service.said["stderr"][-1]), service.transcript()
        assert EXITING.match(service.said["stderr"][-1])["code"] == "0"

    def test_a_vendor_thread_that_never_returns_cannot_keep_a_stopping_process_alive(self, running, tmp_path):
        # The moomoo SDK's connect retries a dead OpenD for ever, inside its constructor, on the vendor's
        # worker thread — which the interpreter's own exit would wait for, for ever, and launchd would
        # have to kill. The fetch gives up at its login deadline and the thread does not, so once the
        # sweep has said so, the thread is certainly still in there.
        db = tmp_path / "optionality-ts.db"
        conn = create_database(db)
        insert_monitor(conn, strike_date="2099-12-18")
        conn.close()
        home = tmp_path / "home"
        home.mkdir()
        service = running({"OPTIONALITY_DB_PATH": str(db), "OPEND_HOST": "192.0.2.1", "HOME": str(home)})
        service.wait_for("stdout", STARTED)
        service.wait_for("stderr", r"OpenD login timed out after 8000ms")

        assert service.stop(signal.SIGTERM, timeout=5) == 0
        assert EXITING.match(service.said["stderr"][-1])["code"] == "0"


#: a script that installs `__main__`'s loop error handler and lets something go uncaught
UNCAUGHT = """
import asyncio, sys
from optionality_backend.__main__ import configure_logging, on_loop_error, unawaited

async def fails():
    await asyncio.sleep(0)
    raise RuntimeError("nobody caught this")

async def go():
    asyncio.get_running_loop().set_exception_handler(on_loop_error)
    if sys.argv[1] == "callback":
        asyncio.get_running_loop().call_soon(lambda: 1 / 0)
    else:
        unawaited(fails())
    await asyncio.sleep(10)
    print("still running")

configure_logging()
asyncio.run(go())
"""


class TestUncaughtErrors:
    """Node's `uncaughtException` and `unhandledRejection` handlers, which exit 1: a server that keeps
    serving after an error nobody caught is in a state nobody has reasoned about. asyncio's equivalent
    of both is the loop's exception handler, which by default only logs."""

    @pytest.mark.parametrize(
        ("kind", "event", "error"),
        [("callback", "uncaughtException", "ZeroDivisionError"), ("task", "unhandledRejection", "nobody caught this")],
    )
    def test_an_error_nobody_catches_is_fatal_and_says_so(self, kind, event, error, tmp_path):
        died = subprocess.run(
            [sys.executable, "-c", UNCAUGHT, kind],
            check=False,
            env=environment({}),
            cwd=tmp_path,
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert died.returncode == 1
        assert "still running" not in died.stdout
        assert f"FATAL {event} — exiting:" in died.stderr
        assert error in died.stderr
        assert EXITING.match(died.stderr.splitlines()[-1]), died.stderr


#: a script that configures logging as `__main__` does and logs through each kind of logger
LOGS = """
import logging
from optionality_backend.__main__ import configure_logging

configure_logging()
logging.getLogger("optionality_backend.engine.sweeper").info("an info line")
logging.getLogger("optionality_backend.engine.sweeper").error("an error line")
logging.getLogger("httpx2").info('HTTP Request: POST https://api.telegram.org/botSECRET/sendMessage "HTTP/1.1 200 OK"')
logging.getLogger("uvicorn.error").info("Started server process [1]")
logging.getLogger("uvicorn.error").error("Exception in ASGI application")
"""


class TestLogging:
    def test_says_what_the_typescript_says_where_node_says_it_and_keeps_a_library_s_chatter_out(self, tmp_path):
        # `console.log`/`info` go to stdout and `warn`/`error` to stderr, bare, as Node prints them. A
        # library logs at INFO only what Node's libraries never print — and httpx2's request line
        # carries the Telegram URL, which carries the bot token, into a log file.
        said = subprocess.run(
            [sys.executable, "-c", LOGS],
            check=False,
            env=environment({}),
            cwd=tmp_path,
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert said.returncode == 0, said.stderr
        assert said.stdout == "an info line\n"
        assert said.stderr == "an error line\nException in ASGI application\n"
        assert "SECRET" not in said.stdout + said.stderr
