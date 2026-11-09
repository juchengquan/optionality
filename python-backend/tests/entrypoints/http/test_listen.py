"""The port is the lock between two backends (ADR 0021, Decision 3).

Port of backend/src/entrypoints/http/listen.test.ts, test for test. Every port is ephemeral, so
nothing the owner runs — the live service on 31415, `make serve` on 31417 — can be in the way or be
disturbed. "Another process" is one: a real process holding the port, in the TypeScript backend's
language and in this one's, because the other backend is exactly who will be holding it.

What only the Python can get wrong is at the end: uvicorn, asked to serve, takes the process's signals
and its logging and binds its own socket unless told otherwise, and Python's socket, unlike Node's,
refuses the port to a restart while the previous process's connections are in TIME_WAIT.
"""

import asyncio
import errno
import logging
import signal
import socket
import subprocess
import sys

import httpx2
import pytest
from fastapi import FastAPI

from optionality_backend.entrypoints.http.listen import HeldPort, take_port

#: a listener another process holds, in each backend's language: it prints its port, then waits for
#: its stdin to close
HOLDERS = {
    "python": [
        sys.executable,
        "-c",
        (
            "import socket, sys\n"
            "s = socket.socket()\n"
            "s.bind(('127.0.0.1', 0))\n"
            "s.listen()\n"
            "print(s.getsockname()[1], flush=True)\n"
            "sys.stdin.read()\n"
        ),
    ],
    "node": [
        "node",
        "-e",
        (
            "const s = require('node:net').createServer();"
            "s.listen(0, '127.0.0.1', () => console.log(s.address().port));"
            "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"
        ),
    ],
}


@pytest.fixture
async def held():
    """`takePort`, with every port it took closed after the test."""
    taken: list[HeldPort] = []

    async def held(port: int = 0) -> HeldPort:
        taken.append(await take_port(port))
        return taken[-1]

    yield held
    for h in taken:
        await h.close()


@pytest.fixture
def occupy():
    """Another process's listener: a port some other process already holds, as a second backend
    would find it."""
    running: list[subprocess.Popen[str]] = []

    def occupy(language: str = "python") -> int:
        proc = subprocess.Popen(HOLDERS[language], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        running.append(proc)
        assert proc.stdout is not None
        return int(proc.stdout.readline())

    yield occupy
    for proc in running:
        assert proc.stdin is not None
        proc.stdin.close()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


async def get(port: int, path: str = "/health") -> httpx2.Response:
    async with httpx2.AsyncClient(trust_env=False) as client:
        return await client.get(f"http://127.0.0.1:{port}{path}")


def health_app() -> FastAPI:
    app = FastAPI()

    @app.get("/health")
    async def health():
        return {"ok": True}

    return app


class TestTakePort:
    async def test_answers_503_in_the_dashboard_s_error_shape_until_the_app_is_attached(self, held):
        h = await held()
        resp = await get(h.port)
        assert resp.status_code == 503
        assert resp.json() == {"detail": "the service is starting"}

    async def test_serves_the_app_once_it_is_attached_on_the_same_port(self, held):
        h = await held()
        h.serve(health_app())
        resp = await get(h.port)
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}

    @pytest.mark.parametrize("language", HOLDERS)
    async def test_refuses_a_port_another_process_holds_and_names_it(self, occupy, language):
        port = occupy(language)
        with pytest.raises(
            RuntimeError, match=rf"^port {port} on 127\.0\.0\.1 is taken: another backend is running$"
        ) as e:
            await take_port(port)
        assert isinstance(e.value.__cause__, OSError)
        assert e.value.__cause__.errno == errno.EADDRINUSE

    async def test_is_the_lock_between_two_backends_the_second_taker_is_refused(self, held):
        h = await held()
        with pytest.raises(RuntimeError, match="is taken"):
            await take_port(h.port)


class TestWhatOnlyThePythonCanGetWrong:
    async def test_takes_back_a_port_whose_last_connection_is_still_in_time_wait(self, held):
        # A restart is how every deploy lands (`kickstart -k`), and the backend that stopped closed its
        # connections FIRST, which leaves each one in TIME_WAIT on the port for about 30 seconds. A
        # plain bind is refused for all of that time — measured on this machine — and the refusal
        # would read "another backend is running" while launchd restarted it into the same refusal.
        # Node sets SO_REUSEADDR on every listener, so the TypeScript never met this; nor may the
        # Python. The lock still holds against a LISTENER, which the tests above prove with it on.
        first = await held()
        port = first.port
        first.serve(health_app())
        async with httpx2.AsyncClient(trust_env=False) as client:
            assert (await client.get(f"http://127.0.0.1:{port}/health")).status_code == 200
            await first.close()  # the server closes the kept-alive connection: its side is TIME_WAIT
        await asyncio.sleep(0.1)

        # the control: without the option this port is refused, so the TIME_WAIT is really there
        plain = socket.socket()
        with pytest.raises(OSError) as refused:
            plain.bind(("127.0.0.1", port))
        plain.close()
        assert refused.value.errno == errno.EADDRINUSE

        again = await held(port)
        assert again.port == port

    async def test_closing_it_lets_the_port_go(self, held):
        # `held.server.close()` in the TypeScript, which `main.ts` calls on SIGTERM: here it is
        # awaited, because stopping uvicorn is a flag and the task that serves
        h = await held()
        port = h.port
        await h.close()
        assert (await held(port)).port == port

    async def test_serves_the_app_on_the_loop_that_took_the_port(self, held):
        # One loop (ADR 0021, Decision 6): the database connection is opened on it and refuses every
        # other thread, so the app must answer on the loop `__main__` runs, not on one of uvicorn's.
        seen = []
        app = FastAPI()

        @app.get("/loop")
        async def loop():
            seen.append(asyncio.get_running_loop())
            return {}

        h = await held()
        h.serve(app)
        assert (await get(h.port, "/loop")).status_code == 200
        assert seen == [asyncio.get_running_loop()]

    async def test_leaves_the_signals_to_main(self, held):
        # uvicorn's `serve` takes SIGTERM and SIGINT for itself, stops only the HTTP server on them and
        # raises the signal again once it has. `main.ts` stops the bot, the sweep, the server, the
        # vendors and the database IN ORDER on SIGTERM, which is how launchd stops it — so the handlers
        # must stay `__main__`'s.
        before = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
        h = await held()
        h.serve(health_app())
        assert (await get(h.port)).status_code == 200
        assert {sig: signal.getsignal(sig) for sig in before} == before

    async def test_configures_no_logging_and_logs_no_request(self, held, caplog):
        # Only `__main__` says where logs go (README, "Porting a module"), and uvicorn's default
        # configures the process's. Nor does it log every request: the dashboard polls every 15 seconds
        # per open tab, and the app already says what is worth saying — refusals and writes (`app.py`).
        # The witnesses are the root and `uvicorn`, where uvicorn's default puts its handlers; not
        # `uvicorn.access`, which turning the access log off empties by itself, and to which pytest
        # adds its own capture once it stops propagating.
        handlers = {name: list(logging.getLogger(name).handlers) for name in ("", "uvicorn", "uvicorn.error")}
        h = await held()
        h.serve(health_app())
        with caplog.at_level(logging.DEBUG):
            assert (await get(h.port)).status_code == 200
        assert {name: list(logging.getLogger(name).handlers) for name in handlers} == handlers
        assert not [r for r in caplog.records if r.name.startswith("uvicorn.access")]

    async def test_says_why_when_the_port_cannot_be_taken_for_another_reason(self):
        # an address this machine does not have (TEST-NET-1, RFC 5737): not "another backend"
        with pytest.raises(RuntimeError, match=r"^could not take port 0 on 192\.0\.2\.1: ") as e:
            await take_port(0, "192.0.2.1")
        assert isinstance(e.value.__cause__, OSError)
        assert e.value.__cause__.errno == errno.EADDRNOTAVAIL
