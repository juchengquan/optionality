"""The app itself: what is open, what needs a token, and what a refusal leaves in the log.

Port of backend/src/entrypoints/http/app.test.ts. Every test comes across; the TypeScript's spy on
`console.error` and `console.log` is pytest's `caplog` on the app's logger, at ERROR and INFO.

What only the Python can get wrong is at the end: FastAPI and Starlette answer differently from Hono
wherever nobody told them otherwise, and those differences are invisible to a scenario that only ever
asks for a route that exists.
"""

import asyncio
import logging
import re
import socket

import httpx2
import optionality
import pytest
import uvicorn
from fastapi.openapi.utils import get_openapi
from harness import TOKEN, json_body

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
    "POST /positions/:id/close",
    "POST /references",
}

#: What the Python does not serve yet (ADR 0021, the first port). Written out, never derived, and it
#: may only shrink: a route leaves it in the change that ports it, and the HTTP door is done when it is
#: empty. Holding the Python to the WHOLE surface less this is what keeps an unported route ABSENT — a
#: half-built one would answer, and a scenario could pass by accident.
NOT_YET = {
    "GET /docs",
    "GET /openapi.json",
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
        "closed_on": None,
        "exit": None,
    }


class TestHealth:
    async def test_is_open_and_reports_status_rather_than_raising(self, start):
        resp = await start().call("/health", anonymous=True)
        assert resp.status_code == 200
        data = resp.json()
        assert data["db"] is True
        # the Provider names itself: the dashboard said "OpenD" whatever was actually behind the port,
        # and a second Provider would have made that a lie on screen (#169)
        assert data["provider"] == {"name": "moomoo", "ok": False}  # nothing listens on the test port

    async def test_reports_the_name_of_whichever_provider_answered_not_the_one_it_was_written_against(self, start):
        # the route must read the Provider's own name: hard-coding "moomoo" here would pass every other
        # test in this file and put the wrong vendor on the dashboard the day a second one lands
        data = (await start(provider_name="ibkr").call("/health", anonymous=True)).json()
        assert data["provider"]["name"] == "ibkr"

    async def test_carries_the_fingerprint_of_the_golden_cases_for_a_port_to_compare_itself_against(self, start):
        """The one field a notebook reads rather than the dashboard (ADR 0016).

        `python/`'s port is held to the TypeScript by the golden cases, but only at the moment it is
        written. A notebook pins a tag and keeps it for months, so the staleness it cannot otherwise see
        is "the engine has moved since my port was cut". This is how it finds out: the running service
        states which cases it IS, and `optionality.api.agrees` compares. The Python backend's maths is
        the library, so the cases it IS are the ones the library was cut against.
        """
        data = (await start().call("/health", anonymous=True)).json()
        # the published constant, not a literal: a copy here would agree with a stale port forever
        assert data["golden_cases"] == optionality.GOLDEN_CASES
        assert re.fullmatch(r"[0-9a-f]{12}", data["golden_cases"], re.ASCII)

    async def test_reports_the_last_fetch_for_the_provider_not_a_port_that_merely_accepts(self, start):
        # 2026-10-16: OpenD held the socket open and would not log in. The probe said true, every
        # OpenD-backed route returned 502, and the dashboard showed a green light for a gateway the
        # service could not speak to. What the last batch actually did is the only honest answer, and it
        # costs no extra call.
        h = start(opend=True)
        h.sweeper.fetch_ok = False
        data = (await h.call("/health", anonymous=True)).json()
        assert data["provider"]["ok"] is False

    async def test_falls_back_to_the_port_probe_only_while_nothing_has_been_fetched_yet(self, start):
        # a service that has not asked yet cannot report what asking would do, and "unknown" is not one
        # of the two values this field has
        h = start(opend=True)
        assert h.sweeper.fetch_ok is None
        data = (await h.call("/health", anonymous=True)).json()
        assert data["provider"]["ok"] is True

    async def test_reports_the_knobs_a_client_cannot_guess(self, start):
        h = start(
            settings={"monitor_interval_seconds": 45, "expired_retention_days": 3, "display_tz": "Asia/Singapore"}
        )
        data = (await h.call("/health", anonymous=True)).json()
        assert data["settings"] == {
            # the manage-by DTE is a knob too, and the dashboard needs it: it is the horizon the
            # watchlist's pressure reading weighs fill against, and a second copy of 21 in the frontend
            # would drift from EXIT_MANAGE_BY_DTE the first time it moved
            "manage_by_dte": 21,
            "sweep_seconds": 45,
            "expired_retention_days": 3,
            "display_tz": "Asia/Singapore",
        }

    async def test_says_the_alarm_engine_has_not_swept_yet_rather_than_inventing_a_time(self, start):
        data = (await start().call("/health", anonymous=True)).json()
        assert data["monitor"] == {
            "last_sweep_at": None,
            "last_sweep_ok": True,
            "consecutive_failures": 0,
            "alarms": {"label": "watching", "bad": False},
            "fetched_at": None,
        }

    async def test_says_so_when_the_database_has_gone_instead_of_failing_the_request(self, start):
        h = start()
        h.db.close()  # every query from here on raises
        resp = await h.call("/health", anonymous=True)
        assert resp.status_code == 200
        assert resp.json()["db"] is False


class TestTheBearerToken:
    async def test_rejects_a_request_without_one(self, start):
        resp = await start().call("/monitors", anonymous=True)
        assert resp.status_code == 401
        assert resp.json() == {"detail": "unauthorized"}

    async def test_rejects_a_wrong_one(self, start):
        resp = await start().call("/monitors", anonymous=True, headers={"Authorization": "Bearer nope"})
        assert resp.status_code == 401

    async def test_accepts_the_right_one(self, start):
        assert (await start().call("/monitors")).status_code == 200

    async def test_asks_for_nothing_when_no_token_is_configured(self, start):
        # the owner's deployment sets API_TOKEN; a local run without one must still work
        h = start(settings={"api_token": ""})
        assert (await h.call("/monitors", anonymous=True)).status_code == 200

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
        # the real number of doors, 16, less those not ported yet
        assert len({d for d in SURFACE if d.split(" ")[1] not in OPEN}) == 16
        assert len(doors) == 16 - len({d for d in NOT_YET if d.split(" ")[1] not in OPEN})
        for door in sorted(doors):
            method, path = door.split(" ")
            resp = await h.call(path.replace(":id", "x"), method=method, anonymous=True)
            assert resp.status_code == 401, door
        for path in OPEN:
            if f"GET {path}" not in NOT_YET:
                assert (await h.call(path, anonymous=True)).status_code == 200, path


class TestARefusalInTheLog:
    """A rejected write left no trace on the service at all.

    2026-10-19: a holding would not record, and there was no way to tell from this side whether the
    request had even arrived — `onError` formatted the {detail} body and returned it without a word,
    and a 401 from the auth middleware never reached `onError` in the first place. The only way to
    split "the browser never sent it" from "the service refused it" was to probe the API by hand."""

    async def test_names_the_method_the_path_and_the_status_of_a_refusal_it_threw(self, start, caplog):
        with caplog.at_level(logging.ERROR, logger=LOG):
            await start().call("/positions", **json_body({"name": 1}))
        lines = [m for m in caplog.messages if "422" in m]
        assert len(lines) == 1, f"expected exactly one 422 line; saw {caplog.messages}"
        assert "POST" in lines[0]
        assert "/positions" in lines[0]
        assert "detail" in lines[0], "and what was wrong with it"

    async def test_names_one_a_route_threw_which_is_a_different_path_through_the_app(self, start, caplog):
        # http_error/not_found raise an HTTPException that the app turns into the {detail} body. A
        # mutation sweep showed the other two cases here are both RETURNED — `valid()` answers 422
        # itself — so without this the raised path was logged by nothing and nothing noticed.
        with caplog.at_level(logging.ERROR, logger=LOG):
            await start().call("/positions/ghost/vol")
        lines = [m for m in caplog.messages if "404" in m]
        assert len(lines) == 1, f"expected exactly one 404 line; saw {caplog.messages}"
        assert "/positions/ghost/vol" in lines[0]
        assert "position not found" in lines[0], "and why"

    async def test_names_one_it_merely_returned_which_never_passes_through_on_error(self, start, caplog):
        # the auth middleware answers 401 rather than raising
        with caplog.at_level(logging.INFO, logger=LOG):
            await start().call("/positions", anonymous=True)
        lines = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR and "401" in r.getMessage()]
        assert lines, f"nothing logged a 401; saw {caplog.messages}"
        assert "GET" in lines[0]

    async def test_says_nothing_at_all_about_a_request_that_succeeded(self, start, caplog):
        # the log is read by eye during an incident; a line per poll would bury the one that matters
        with caplog.at_level(logging.ERROR, logger=LOG):
            await start().call("/health", anonymous=True)
        assert [m for m in caplog.messages if "/health" in m] == []

    async def test_names_a_write_that_succeeded_because_a_refusal_is_not_the_only_thing_worth_seeing(
        self, start, caplog
    ):
        # 2026-10-19, the second half of the same incident: with refusals logged, a press to record the
        # 11-30 spread still produced no line and no row. "The service refused nothing" and "the service
        # was never asked" then read identically, so the log still could not say whether the browser
        # had sent anything. A write is rare and owner-initiated — the flood the test above guards
        # against is GETs — so every write says so, whatever its status.
        with caplog.at_level(logging.INFO, logger=LOG):
            resp = await start().call(
                "/positions",
                **json_body(
                    {
                        "name": "1130_BS_6950",
                        "strike_date": "2026-11-30",
                        "contracts": 1,
                        "entry": 2.35,
                        "legs": [
                            {"side": "short", "option_type": "PUT", "strike": 6950},
                            {"side": "long", "option_type": "PUT", "strike": 6900},
                        ],
                    }
                ),
            )
            assert resp.status_code == 201, resp.text
        line = next((r for r in caplog.records if "/positions" in r.getMessage()), None)
        assert line is not None, f"nothing logged the write; saw {caplog.messages}"
        assert "POST" in line.getMessage()
        assert "201" in line.getMessage()
        assert line.levelno == logging.INFO, "a write that worked is context, not a refusal"

    async def test_still_says_nothing_about_a_get_that_succeeded_which_is_the_flood(self, start, caplog):
        # the log is read by eye during an incident; a line per poll would bury the one that matters
        h = start()
        with caplog.at_level(logging.DEBUG, logger=LOG):
            assert (await h.call("/monitors")).status_code == 200
            assert (await h.call("/health", anonymous=True)).status_code == 200
        assert caplog.messages == []


class TestTheErrorShape:
    async def test_is_the_detail_the_dashboard_reads_on_every_failure_path(self, start):
        h = start()
        # 404 from a missing row, 422 from a bad payload, 401 from a missing token — all one shape
        missing = await h.call("/positions/ghost/vol")
        assert missing.status_code == 404
        assert missing.json() == {"detail": "position not found"}

        bad = await h.call("/positions", **json_body({"name": 1}))
        assert bad.status_code == 422
        assert isinstance(bad.json()["detail"], str)


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
