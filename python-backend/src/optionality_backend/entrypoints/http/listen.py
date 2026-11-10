"""The port is the lock between two backends (ADR 0021, Decision 3). Port of
backend/src/entrypoints/http/listen.ts.

Either the TypeScript or the Python backend may be the live one, and they share one database file, one
Telegram bot token and one IB Gateway client id. Two running at once would write the same alarm rows,
split the owner's commands between two `getUpdates` consumers, and quietly take each other's gateway
connection. Nothing stopped that before: `main.ts` migrated the database, opened the vendors and armed
the sweep, and only then bound the port — whose failure arrived asynchronously, after all of it had
started.

So the port is taken FIRST, and taking it is the lock. The operating system enforces it, it is released
when the process dies however it dies, and it needs no lock file to go stale and no lock row inside the
very database it protects. A backend that cannot take it stops having touched nothing.

Holding the port before the app exists means requests can arrive while the service is still starting.
They get a 503 in the dashboard's error shape (`errors.py`) rather than a refused connection, and the
app is attached once it is ready.

**The order `__main__` follows**, as `main.ts` does, and what it owes the lock:

1. **`.env`**, named by `--env-file=.env` on its command line as Node's is, and read with
   `env.load_env_file` before anything, as Node reads its own before `main.ts` runs. Reading a file
   touches nothing the other backend shares, and a variable the environment already has wins over the
   file, as it does for Node — so the plist's `PORT` is the one taken.
2. **The port**: `PORT` read straight from `os.environ`, not through Settings, so that not even a
   settings error can come first; 31417 when unset, as `main.ts` defaults, so a run by hand can never
   take the live 31415. `held = await take_port(port)`, and on its `RuntimeError` log
   `f"{err}: stopping before the database, the vendors or Telegram are touched"` and exit 1.
3. **Settings**: `env.settings_from_env()`, whose refusal of a knob is fatal.
4. **The database**: `db.open.open_database`, then `db.migrate.migrate`, before anything serves, a
   failure fatal on purpose; then the Telegram sender.
5. **The vendors**: `vendors.open_vendors(settings)`, once, the Provider among them.
6. **The sweep** built — the scheduler and the sweeper — then `held.serve(create_app(deps))`, from
   which point requests stop being answered 503.
7. **The bot** built, the sweep started (at once and on the interval, with its stall watchdog), and
   the bot started ONLY when `OPTIONALITY_BOT=1` and Telegram is configured: one `getUpdates` consumer
   per token, and only the plist sets the flag.
8. **Signals and logging**, which `take_port` leaves alone: `__main__` configures where logs go, and on
   SIGTERM — how launchd stops it — stops the bot, the scheduler, `await held.close()`, the vendors and
   the database, in that order, and exits 0.

**Where the Python differs, and why.**

- **uvicorn serves, on a socket this module binds.** Node's `createServer().listen()` is the bind and the
  server in one; here the socket is bound and listening before uvicorn exists, and handed to it whole
  (`Server.serve(sockets=[sock])`). The bind is the lock, so it must fail HERE, as a raise naming the
  port: uvicorn binding for itself logs the error and calls `sys.exit(1)` instead. A request arriving
  before uvicorn has started waits in the listen queue, as it waits in Node's while `main.ts` migrates.
- **`SO_REUSEADDR`, as libuv sets it on every Node listener.** Without it a restart is refused for about
  30 seconds by the previous process's connections in TIME_WAIT (measured), and the refusal reads
  "another backend is running" while launchd restarts it into the same refusal. It does not weaken the
  lock: a second listener on the same address and port is refused with it or without it (measured, and
  held by the suite against a Python and a Node holder).
- **uvicorn's own habits are off** where Node's server has none: it would take SIGTERM and SIGINT for
  itself (see 8 above), configure the process's logging (only `__main__` does), log every request (the
  dashboard polls every 15 seconds per tab; the app logs refusals and writes, `app.py`), send the
  lifespan protocol (Hono has no lifespan, and before the app is attached it would go to the 503),
  rewrite the client address from a forwarded header, and name itself in a `server` header.
- **`await held.close()`** is the TypeScript's `held.server.close()`: stopping uvicorn is a flag and the
  task that serves, and it closes the socket, which lets the port go.
- **`serve(app)` takes an ASGI app** — `create_app(deps)` — where the TypeScript takes Hono's `fetch`.
"""

import asyncio
import contextlib
import errno
import socket
from collections.abc import Iterator

import uvicorn
from starlette.types import ASGIApp, Receive, Scope, Send

#: what a request gets while the service is starting, as `JSON.stringify` writes it
STARTING = b'{"detail":"the service is starting"}'


async def _starting(scope: Scope, receive: Receive, send: Send) -> None:
    if scope["type"] != "http":
        return
    headers = [
        (b"content-type", b"application/json"),
        (b"retry-after", b"1"),
        (b"content-length", str(len(STARTING)).encode()),
    ]
    await send({"type": "http.response.start", "status": 503, "headers": headers})
    await send({"type": "http.response.body", "body": STARTING})


class _Attachable:
    """The one app uvicorn is given: the 503 until `serve` attaches the real one."""

    def __init__(self) -> None:
        self.app: ASGIApp = _starting

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        await self.app(scope, receive, send)


class _Server(uvicorn.Server):
    """uvicorn's server, with the process's signals left to `__main__`."""

    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:
        yield


class HeldPort:
    """The port, held: answering 503 until `serve` attaches the app."""

    def __init__(self, server: uvicorn.Server, port: int, attachable: _Attachable, serving: asyncio.Task[None]):
        self.server = server
        #: the port actually bound, which differs from the one asked for only when that was 0
        self.port = port
        self._attachable = attachable
        self._serving = serving

    def serve(self, app: ASGIApp) -> None:
        """Start serving the app. Until this is called every request is answered 503."""
        self._attachable.app = app

    async def close(self) -> None:
        """Stop serving and let the port go."""
        self.server.should_exit = True
        await self._serving


def _bind(port: int, hostname: str) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((hostname, port))
        sock.listen()
    except OSError as err:
        sock.close()
        why = (
            f"port {port} on {hostname} is taken: another backend is running"
            if err.errno == errno.EADDRINUSE
            else f"could not take port {port} on {hostname}: {err}"
        )
        raise RuntimeError(why) from err
    return sock


async def take_port(port: int, hostname: str = "127.0.0.1") -> HeldPort:
    """Bind `hostname:port`, or raise naming the port when something else already holds it."""
    sock = _bind(port, hostname)
    attachable = _Attachable()
    config = uvicorn.Config(
        attachable,
        lifespan="off",
        log_config=None,
        access_log=False,
        proxy_headers=False,
        server_header=False,
    )
    server = _Server(config)
    serving = asyncio.create_task(server.serve(sockets=[sock]))
    # serving from here: the bind cannot fail any more, but uvicorn's start could, and it must say so
    # to the caller rather than to a task nobody awaits
    while not server.started:
        if serving.done():
            sock.close()
            serving.result()
            raise RuntimeError(f"could not serve on port {port} on {hostname}: uvicorn stopped before it started")
        await asyncio.sleep(0.005)
    return HeldPort(server, sock.getsockname()[1], attachable, serving)
