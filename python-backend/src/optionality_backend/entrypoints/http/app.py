"""The service, as a value rather than a process (ADR 0009, phase 5). Port of
backend/src/entrypoints/http/app.ts.

Separate from `__main__` so that tests can mount it without binding a port, and so that the scenario
runner can drive it on a world's database (ADR 0021).

**Where the Python differs, and why.** Hono's app is a chain of `use`, `onError` and routes. Here:

- **The order of the middleware.** Starlette wraps the LAST middleware added outermost, so they are
  added inside out: the token check, then the catch-all, then the log. A request meets them in the
  TypeScript's order — log, errors, token, route.
- **The catch-all is a middleware, not an exception handler.** A Starlette handler for `Exception`
  runs inside its `ServerErrorMiddleware`, which sends the handler's answer and then RAISES the error
  again — uvicorn logs a crash for a request that was answered, and an ASGI test client raises in
  the caller. Hono's `onError` answers and is done, so a middleware catches it here instead.
  A refusal a route RAISES (`errors.py`) never gets that far: Starlette's own exception middleware,
  innermost, turns it into the `{"detail"}` body, which then comes back out through the log as in
  the TypeScript.
- **The log watches what is sent** rather than cloning a response, as an ASGI middleware of its own:
  Starlette's `BaseHTTPMiddleware` hands back a stream that can be read only once.
- **What nobody routes answers as Hono does**: a plain-text `404 Not Found`, also for a known path
  with another method and for a trailing slash. Starlette would answer `{"detail": "Not Found"}`, a
  405, and a 307 redirect (measured against the TypeScript app). A HEAD is the one left alone: Hono
  answers one for every GET route and Starlette's FastAPI routes do not, and nothing sends one.
- **Hono's own refusals are plain text.** Starlette's `HTTPException`, as distinct from FastAPI's that
  `errors.py` raises, stands for the one Hono throws with a bare message — `validate.py`'s 400 for a
  body that is not JSON — and answers with that message as text, not as a `{"detail"}`.
- **FastAPI's own docs are off**: it would mount `/openapi.json`, `/docs` and `/redoc` describing
  itself in its own words. The TypeScript's description is served instead (`openapi.py`).
"""

import logging
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .deps import Deps
from .openapi import mount_docs
from .routes.health import health_routes
from .routes.monitors import monitor_routes, quote_routes
from .routes.positions import position_routes
from .routes.references import reference_routes

log = logging.getLogger(__name__)

#: Paths reachable without a token. `/health` is open because whatever is checking on the service may
#: be the thing that has lost its credentials, and because the dashboard reads it to find out whether
#: it is talking to the API it was built against (ADR 0006). The docs are open because the page cannot
#: hand a token to the fetch of its own spec, and the spec holds no data.
OPEN_PATHS = frozenset({"/health", "/openapi.json", "/docs"})

type Next = Callable[[Request], Awaitable[Response]]


def _say_request(method: str, path: str, status: int, detail: str) -> None:
    """A refusal says so, once, with enough to find it.

    2026-10-19: a holding would not record, and nothing on the service's side could tell whether the
    request had arrived at all — the {detail} body went back to the browser and the service said
    nothing. Every refusal, and every WRITE whatever its status: a press to record a spread still left
    no line and no row, and "the service refused nothing" read exactly like "the service was never
    asked". Only a line for the write itself splits those two.

    Reads that succeed stay silent, and they are the flood: the dashboard polls every 15 seconds per
    open tab. Writes are owner-initiated and rare. This log is read by eye during an incident.
    """
    line = f"{method} {path} → {status}{f' {detail}' if detail else ''}"
    # a refused request is the one being hunted; a write that worked is context around it
    if status >= 400:
        log.error(line)
    else:
        log.info(line)


class _SayRequests:
    """The log, as the outermost layer: it sees every answer, the token's 401 and a raised refusal's
    body included, which is ONE place for both kinds — logging in two places logged the raised ones
    twice in the TypeScript, which a test caught after a mutation sweep."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        status = 0
        body = bytearray()

        async def watch(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            elif message["type"] == "http.response.body" and status >= 400:
                body.extend(message.get("body", b""))
            await send(message)

        await self.app(scope, receive, watch)
        method = scope["method"]
        refused = status >= 400
        if not refused and method == "GET":
            return
        # only when something went wrong: a created Position's body is its whole shape, and the
        # reason to log a write at all is that it happened, not what it returned
        detail = body.decode("utf-8", errors="replace")[:200] if refused else ""
        _say_request(method, scope["path"], status, detail)


def create_app(deps: Deps) -> FastAPI:
    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None, redirect_slashes=False)

    async def guard(request: Request, call_next: Next) -> Response:
        token = deps.settings.api_token
        if token and request.url.path not in OPEN_PATHS and request.headers.get("authorization") != f"Bearer {token}":
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return await call_next(request)

    async def on_error(request: Request, call_next: Next) -> Response:
        try:
            return await call_next(request)
        except Exception:
            # an HTTPException never reaches here (see the module's doc); anything else is a bug, and
            # must still answer in the shape the dashboard can show — with the stack, which the
            # one-line refusal cannot carry and a bug needs
            log.exception("unhandled error:")
            return JSONResponse({"detail": "internal error"}, status_code=500)

    async def http_exception(request: Request, exc: Exception) -> Response:
        assert isinstance(exc, StarletteHTTPException)
        # the router's own, which is Starlette's class and not FastAPI's: nothing serves this method
        # on this path. A route's refusal is FastAPI's (errors.py) and keeps its status and detail.
        if not isinstance(exc, HTTPException):
            if exc.status_code in (404, 405):
                return PlainTextResponse("404 Not Found", status_code=404)
            # Hono's own HTTPException, thrown with a message and no response, which Hono renders as
            # that message in plain text: validate.py's 400 for a body that is not JSON
            return PlainTextResponse(exc.detail, status_code=exc.status_code, headers=exc.headers)
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers)

    app.add_exception_handler(StarletteHTTPException, http_exception)
    # inside out: Starlette wraps the last one added outermost
    app.add_middleware(BaseHTTPMiddleware, dispatch=guard)
    app.add_middleware(BaseHTTPMiddleware, dispatch=on_error)
    app.add_middleware(_SayRequests)

    # The run pipeline's routes — /runs, /configs, /schedules, fifteen endpoints — were mounted in the
    # TypeScript until #118, and its machinery until phase 10 (ADR 0014). Do not put any of it back
    # without asking.
    app.include_router(health_routes(deps))
    app.include_router(quote_routes(deps))
    app.include_router(monitor_routes(deps), prefix="/monitors")
    app.include_router(position_routes(deps), prefix="/positions")
    app.include_router(reference_routes(deps), prefix="/references")
    mount_docs(app, deps.settings.root_path)
    return app
