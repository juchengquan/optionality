"""The error shape the dashboard parses: `{"detail": "..."}`, with the status a route chose.

backend/src/entrypoints/http/errors.ts has no test of its own: its callers' suites rely on it —
`app.test.ts`'s "the error shape" and "names one a route THREW", every route suite's 404 and 409, and
the market-data routes' 502 naming the Provider. Those are ported now and hold it through the routes;
these were written while they were not, mounting a route that raises each error, and are kept because
they hold the shape on its own, whatever any one route does.
"""

import logging

import pytest

from optionality_backend.entrypoints.http.errors import http_error, not_found, provider_failed

LOG = "optionality_backend.entrypoints.http.app"


def raising(h, error):
    async def route():
        raise error

    h.app.add_api_route("/raises", route)
    return h


class TestTheShapeTheDashboardReads:
    async def test_a_refusal_answers_its_status_and_its_detail(self, start):
        resp = await raising(start(), http_error(409, "position 'dec-condor' already exists")).call("/raises")
        assert resp.status_code == 409
        assert resp.json() == {"detail": "position 'dec-condor' already exists"}

    async def test_not_found_names_what_was_not_found(self, start):
        resp = await raising(start(), not_found("position")).call("/raises")
        assert (resp.status_code, resp.json()) == (404, {"detail": "position not found"})

    async def test_a_market_data_failure_is_a_502_naming_the_provider_and_what_it_said(self, start):
        # 502 rather than 500 because the fault is upstream, and the NAME because the dashboard prints
        # this detail verbatim: both market-data routes once said "OpenD call failed" whatever
        # OPTIONALITY_PROVIDER said
        err = provider_failed("ibkr", ConnectionRefusedError("connect ECONNREFUSED 127.0.0.1:4001"))
        resp = await raising(start(), err).call("/raises")
        assert (resp.status_code, resp.json()) == (
            502,
            {"detail": "ibkr call failed: connect ECONNREFUSED 127.0.0.1:4001"},
        )

    async def test_a_refusal_a_route_raised_is_logged_once_with_its_path_and_why(self, start, caplog):
        # app.test.ts's "names one a route THREW": a raised refusal takes a different path through the
        # app from a returned one, and was once logged by nothing
        h = raising(start(), not_found("position"))
        with caplog.at_level(logging.INFO, logger=LOG):
            await h.call("/raises")
        lines = [m for m in caplog.messages if "404" in m]
        assert len(lines) == 1, f"expected exactly one 404 line; saw {caplog.messages}"
        assert "/raises" in lines[0]
        assert "position not found" in lines[0], "and why"

    @pytest.mark.parametrize("detail", ["", "a sentence with “quotes” and a ✖"])
    async def test_the_detail_is_sent_as_written(self, start, detail):
        resp = await raising(start(), http_error(422, detail)).call("/raises")
        assert resp.json() == {"detail": detail}
