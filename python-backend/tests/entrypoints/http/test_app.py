"""The app itself: what is open, what needs a token, and what a refusal leaves in the log.

Port of backend/src/entrypoints/http/app.test.ts — PARTLY, as `app.py` is: the tests that need a
route the Python does not serve yet wait for it. Not ported yet: the whole `/health` group (its
route), "names the method, the path and the status of a refusal it threw" and "the error shape" (a
422 from POST /positions), "names one a route THREW" (GET /positions/:id/vol — its path through the
app is held meanwhile by `test_errors.py`), "says nothing at all about a request that succeeded"
(/health) and "names a write that SUCCEEDED" (POST /positions). Two ported tests ask for /positions
where the TypeScript asks for /monitors, which is not ported: they are about the token, not the
route, and each says so.

What only the Python can get wrong is at the end: FastAPI and Starlette answer differently from Hono
wherever nobody told them otherwise, and those differences are invisible to a scenario that only ever
asks for a route that exists.
"""

import asyncio
import logging
import socket

import httpx2
import pytest
import uvicorn
from fastapi.openapi.utils import get_openapi
from harness import TOKEN

from optionality_backend.db.queries import insert_position

LOG = "optionality_backend.entrypoints.http.app"

#: the API's whole surface, as the TypeScript's test states it
SURFACE = {
    "DELETE /monitors/:id",
    "DELETE /positions/:id",
    "DELETE /references/:id",
    "GET /docs",
    "GET /health",
    "GET /monitors",
    "GET /openapi.json",
    "GET /positions",
    "GET /positions/:id/vol",
    "GET /positions/values",
    "GET /quotes",
    "GET /references",
    "PATCH /monitors/:id",
    "PATCH /positions/:id",
    "POST /monitors",
    "POST /monitors/:id/total-entry",
    "POST /positions",
    "POST /references",
}

#: What the Python does not serve yet (ADR 0021, the first port). Written out, never derived, and it
#: may only shrink: a route leaves it in the change that ports it, and the HTTP door is done when it is
#: empty. Holding the Python to the WHOLE surface less this is what keeps an unported route ABSENT — a
#: half-built one would answer, and a scenario could pass by accident.
NOT_YET = {
    "DELETE /monitors/:id",
    "DELETE /positions/:id",
    "DELETE /references/:id",
    "GET /docs",
    "GET /health",
    "GET /monitors",
    "GET /openapi.json",
    "GET /positions/:id/vol",
    "GET /positions/values",
    "GET /quotes",
    "GET /references",
    "PATCH /monitors/:id",
    "PATCH /positions/:id",
    "POST /monitors",
    "POST /monitors/:id/total-entry",
    "POST /positions",
    "POST /references",
}

OPEN = ("/health", "/openapi.json", "/docs")


def served(app) -> set[str]:
    """Every method and path the app routes, in Hono's spelling (`:id` for `{id}`).

    Read through the spec FastAPI would generate, which is the public way to ask: an included router
    is ONE private `_IncludedRouter` entry in `app.routes`, not its routes. Every route here is in
    the schema; one marked `include_in_schema=False` would be invisible to this."""
    paths = get_openapi(title="served", version="0", routes=app.routes)["paths"]
    return {
        f"{method.upper()} {path.replace('{', ':').replace('}', '')}"
        for path, methods in paths.items()
        for method in methods
    }


def holding(id_, name, strike_date="2026-12-18"):
    return {
        "id": id_,
        "name": name,
        "strategy": None,
        "strike_date": strike_date,
        "contracts": 1,
        "entry": None,
        "legs": '[{"side":"short","option_type":"CALL","strike":8050}]',
        "created_at": "2026-10-01 00:00:00.000000",
        "opened_at": None,
        "manage_notified_at": None,
    }


class TestTheBearerToken:
    async def test_rejects_a_request_without_one(self, start):
        resp = await start().call("/monitors", anonymous=True)
        assert resp.status_code == 401
        assert resp.json() == {"detail": "unauthorized"}

    async def test_rejects_a_wrong_one(self, start):
        resp = await start().call("/monitors", anonymous=True, headers={"Authorization": "Bearer nope"})
        assert resp.status_code == 401

    async def test_accepts_the_right_one(self, start):
        # /positions where the TypeScript asks /monitors, which is not ported yet
        assert (await start().call("/positions")).status_code == 200

    async def test_asks_for_nothing_when_no_token_is_configured(self, start):
        # the owner's deployment sets API_TOKEN; a local run without one must still work. /positions
        # where the TypeScript asks /monitors, which is not ported yet
        h = start(settings={"api_token": ""})
        assert (await h.call("/positions", anonymous=True)).status_code == 200

    def test_serves_exactly_these_doors_and_no_others(self, start):
        # The API's whole surface, stated, less what is not ported yet. A route nothing calls is a
        # route nothing exercises; this is what makes adding or removing one a decision rather than a
        # diff nobody reads — and, while the port runs, what keeps a route half-ported from answering.
        assert NOT_YET <= SURFACE, "NOT_YET names a door the API does not have"
        assert served(start().app) == SURFACE - NOT_YET

    async def test_guards_every_route_except_health_and_the_docs(self, start):
        # Derived from the router rather than remembered. The auth middleware runs BEFORE routing, so
        # an anonymous call to a path the app no longer serves still answers 401 — a list of paths is
        # the one shape of this test that cannot tell "guarded" from "gone". Every METHOD, not only
        # GET, each with no body: auth runs before validation too.
        h = start()
        doors = {d for d in served(h.app) if d.split(" ")[1] not in OPEN}
        # the real number of doors, 15, less those not ported yet
        assert len({d for d in SURFACE if d.split(" ")[1] not in OPEN}) == 15
        assert len(doors) == 15 - len({d for d in NOT_YET if d.split(" ")[1] not in OPEN})
        for door in sorted(doors):
            method, path = door.split(" ")
            resp = await h.call(path.replace(":id", "x"), method=method, anonymous=True)
            assert resp.status_code == 401, door
        for path in OPEN:
            if f"GET {path}" not in NOT_YET:
                assert (await h.call(path, anonymous=True)).status_code == 200, path


class TestARefusalInTheLog:
    """A rejected write left no trace on the service at all (2026-10-19): there was no way to tell
    from this side whether the request had even arrived."""

    async def test_names_one_it_merely_returned_which_never_passes_through_on_error(self, start, caplog):
        # the auth middleware answers 401 rather than raising
        with caplog.at_level(logging.INFO, logger=LOG):
            await start().call("/positions", anonymous=True)
        lines = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR and "401" in r.getMessage()]
        assert lines, f"nothing logged a 401; saw {caplog.messages}"
        assert "GET" in lines[0]

    async def test_still_says_nothing_about_a_get_that_succeeded_which_is_the_flood(self, start, caplog):
        # the log is read by eye during an incident; a line per poll would bury the one that matters.
        # /positions where the TypeScript asks /monitors and /health, which are not ported yet
        with caplog.at_level(logging.DEBUG, logger=LOG):
            assert (await start().call("/positions")).status_code == 200
        assert caplog.messages == []


class TestWhatOnlyThePythonCanGetWrong:
    async def test_a_path_nobody_serves_answers_as_hono_does(self, start, caplog):
        # Starlette answers {"detail": "Not Found"} as JSON, 405 for a known path with another method,
        # and a 307 redirect for a trailing slash. Hono answers all three with its plain-text 404,
        # measured against the TypeScript app
        h = start()
        with caplog.at_level(logging.ERROR, logger=LOG):
            for method, path in (("GET", "/nope"), ("PUT", "/positions"), ("GET", "/positions/")):
                resp = await h.call(path, method=method)
                assert (resp.status_code, resp.text) == (404, "404 Not Found"), (method, path)
                assert resp.headers["content-type"].startswith("text/plain"), (method, path)
        # and it is a refusal, logged as one
        assert any("GET /nope → 404" in m for m in caplog.messages), caplog.messages

    async def test_a_path_nobody_serves_still_wants_the_token(self, start):
        assert (await start().call("/nope", anonymous=True)).status_code == 401

    async def test_an_unhandled_error_answers_500_in_the_shape_the_dashboard_reads_and_is_not_raised_again(
        self, start, caplog
    ):
        # A handler for `Exception` is not enough in Starlette: its ServerErrorMiddleware sends that
        # handler's answer and then RAISES the error again, which uvicorn logs as a crash and a test
        # client raises in the caller. Hono's onError answers and is done.
        h = start()

        async def boom():
            raise RuntimeError("a bug")

        h.app.add_api_route("/boom", boom)
        with caplog.at_level(logging.ERROR, logger=LOG):
            resp = await h.call("/boom")
        assert resp.status_code == 500
        assert resp.json() == {"detail": "internal error"}
        unhandled = [r for r in caplog.records if r.getMessage() == "unhandled error:"]
        assert unhandled and unhandled[0].exc_info is not None, "the stack, which a bug needs"
        assert any("GET /boom → 500" in m for m in caplog.messages)

    async def test_serves_under_uvicorn_on_the_loop_that_opened_the_database(self, start):
        # The stack, end to end: a real socket, uvicorn's server, the app, and a query on a database
        # connection opened in THIS thread, which sqlite3 refuses to any other. It answers only because
        # uvicorn runs the app on the one loop it was handed (ADR 0021, Decision 6). An ephemeral port,
        # so nothing the owner runs can be in the way.
        h = start()
        insert_position(h.db, holding("p1", "dec-condor"))
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(h.app, lifespan="off", log_level="warning"))
        serving = asyncio.create_task(server.serve(sockets=[sock]))
        try:
            async with asyncio.timeout(5):
                while not server.started:
                    await asyncio.sleep(0.01)
            async with httpx2.AsyncClient(trust_env=False) as client:
                resp = await client.get(
                    f"http://127.0.0.1:{port}/positions", headers={"Authorization": f"Bearer {TOKEN}"}
                )
        finally:
            server.should_exit = True
            await serving
            sock.close()
        assert resp.status_code == 200
        assert [p["name"] for p in resp.json()] == ["dec-condor"]

    @pytest.mark.parametrize("path", ["/openapi.json", "/docs", "/redoc"])
    async def test_does_not_serve_fastapi_s_own_docs_until_openapi_py_is_ported(self, start, path):
        # FastAPI mounts a spec and two pages of its own unless told not to. The TypeScript's are
        # generated by openapi.ts, which is not ported; FastAPI's would describe a different API
        assert (await start().call(path)).status_code == 404
