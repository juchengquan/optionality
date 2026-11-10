"""Request validation that answers the way FastAPI does: a 422 whose `detail` is zod's text.

backend/src/entrypoints/http/validate.ts has no test of its own: its callers' suites rely on it. So
this holds what they rely on, on a probe route mounted on the harness's app — written while the routes
that validate were not ported, and kept because it holds `valid` apart from any one schema —
`routes/monitors.test.ts` on a union validated by the member the body's
shape names, with the member's own message; `routes/positions.test.ts` and the door scenarios on the
422's `{"detail"}` reading exactly as zod's `prettifyError` writes it; and `app.test.ts` on that 422
being named in the log, once. What Hono's validator does with a body that is not JSON is held too,
because `valid` is built on it and the Python has to do it by hand.

What only the Python can get wrong is at the end.
"""

import json
import logging
from typing import Annotated

import pytest
from fastapi import Depends

from optionality_backend.entrypoints.http.validate import valid
from optionality_backend.schemas.monitor import ComboMonitorIn, MonitorCreateIn, MonitorIn, monitor_create_member
from optionality_backend.schemas.position import PositionIn

JSON = {"Content-Type": "application/json"}
LOG = "optionality_backend.entrypoints.http.app"


@pytest.fixture
def h(start):
    """The harness's app, with two probe routes that answer what they were given, as validated."""
    h = start()
    holding = valid("json", PositionIn)
    rule = valid("json", MonitorCreateIn, monitor_create_member)

    @h.app.post("/probe/positions")
    async def positions(given: Annotated[PositionIn, Depends(holding)]) -> dict:
        return given.model_dump(exclude_unset=True)

    @h.app.post("/probe/monitors")
    async def monitors(given: Annotated[ComboMonitorIn | MonitorIn, Depends(rule)]) -> dict:
        return {"as": type(given).__name__, **given.model_dump(exclude_unset=True)}

    return h


async def post(h, path, body, headers=JSON):
    return await h.call(
        path, method="POST", headers=headers, content=body if isinstance(body, str) else json.dumps(body)
    )


class TestARefusal:
    async def test_is_a_422_whose_detail_is_zods_text(self, h):
        resp = await post(h, "/probe/positions", {"name": "dec-condor", "strike_date": "2026-12-18", "legs": []})
        assert resp.status_code == 422
        assert resp.json() == {"detail": "✖ Too small: expected array to have >=1 items\n  → at legs"}

    async def test_of_a_union_is_the_member_the_bodys_shape_names_in_its_own_words(self, h):
        # a union every member refuses answers "Invalid input" and nothing else
        date = "✖ invalid strike_date '18 Dec': use YYYY-MM-DD or YYYYMMDD\n  → at strike_date"
        single = {"strike_date": "18 Dec", "option_type": "CALL", "strike": 7300, "threshold": 0.3}
        assert (await post(h, "/probe/monitors", single)).json() == {"detail": date}
        combo = {"name": "w", "strike_date": "18 Dec", "legs": [], "threshold": 1}
        assert (await post(h, "/probe/monitors", combo)).json() == {
            "detail": f"{date}\n✖ Too small: expected array to have >=2 items\n  → at legs"
        }

    async def test_is_named_in_the_log_once_with_what_was_wrong(self, h, caplog):
        with caplog.at_level(logging.INFO, logger=LOG):
            await post(h, "/probe/positions", {"name": 1})
        lines = [r.getMessage() for r in caplog.records if r.name == LOG and "422" in r.getMessage()]
        assert len(lines) == 1, f"expected exactly one 422 line; saw {lines}"
        assert "POST /probe/positions" in lines[0]
        assert "detail" in lines[0]


class TestAnAcceptedBody:
    async def test_reaches_the_route_as_the_schema_parsed_it(self, h):
        resp = await post(
            h,
            "/probe/positions",
            {
                "name": "c",
                "strike_date": "20261218",
                "legs": [{"side": "long", "option_type": "PUT", "strike": 7000}],
                "extra": 1,
            },
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "name": "c",
            "strike_date": "2026-12-18",
            "legs": [{"side": "long", "option_type": "PUT", "strike": 7000.0}],
        }

    async def test_of_a_union_is_the_member_it_was_meant_for(self, h):
        combo = {
            "name": "w",
            "strike_date": "2026-12-18",
            "threshold": 1,
            "legs": [{"sign": 1, "option_type": "CALL", "strike": 1}, {"sign": -1, "option_type": "CALL", "strike": 2}],
        }
        assert (await post(h, "/probe/monitors", combo)).json()["as"] == "ComboMonitorIn"
        single = {"strike_date": "2026-12-18", "option_type": "CALL", "strike": 7300, "threshold": 0.3}
        assert (await post(h, "/probe/monitors", single)).json()["as"] == "MonitorIn"


class TestABodyThatIsNotJson:
    async def test_is_a_400_in_plain_text_when_it_says_it_is_json(self, h):
        # Hono's validator throws its own HTTPException, which renders its message as plain text
        resp = await post(h, "/probe/positions", "{not json")
        assert resp.status_code == 400
        assert resp.text == "Malformed JSON in request body"
        assert resp.headers["content-type"].startswith("text/plain")

    async def test_is_read_as_nothing_at_all_when_it_does_not_say_so(self, h):
        # Hono reads a body only under a JSON content type, and validates {} otherwise
        for headers in ({}, {"Content-Type": "text/plain"}):
            resp = await post(h, "/probe/positions", '{"name": "c"}', headers)
            assert resp.status_code == 422
            assert resp.json()["detail"].startswith("✖ Invalid input: expected string, received undefined\n  → at name")

    async def test_is_read_under_any_json_content_type(self, h):
        body = {
            "name": "c",
            "strike_date": "2026-12-18",
            "legs": [{"side": "long", "option_type": "PUT", "strike": 7000}],
        }
        for kind in ("application/json; charset=utf-8", "APPLICATION/JSON", "application/vnd.api+json"):
            assert (await post(h, "/probe/positions", body, {"Content-Type": kind})).status_code == 200, kind


class TestTheTag:
    def test_says_what_it_validates_and_with_which_schema_for_the_docs(self):
        # what hono-openapi's own validator carries, so /openapi.json documents a request from the very
        # schema that checks it (openapi.ts)
        check = valid("json", MonitorCreateIn, monitor_create_member)
        assert (check.target, check.schema) == ("json", MonitorCreateIn)


class TestWhatOnlyThePythonCanGetWrong:
    async def test_a_body_javascript_cannot_parse_is_malformed_here_too(self, h):
        # Python's json reads NaN and Infinity, which JSON.parse refuses, as it refuses an empty body
        for body in ('{"name": NaN}', '{"name": Infinity}', ""):
            resp = await post(h, "/probe/positions", body)
            assert (resp.status_code, resp.text) == (400, "Malformed JSON in request body"), body

    async def test_a_leading_byte_order_mark_is_not_part_of_the_json(self, h):
        # the Fetch API decodes a body as TextDecoder does, which drops it
        body = '\ufeff{"name": "c", "strike_date": "2026-12-18", "legs": [{"side": "long", "option_type": "PUT", "strike": 7000}]}'
        assert (await post(h, "/probe/positions", body)).status_code == 200

    async def test_a_number_too_big_for_a_double_is_the_infinity_zod_refuses(self, h):
        body = '{"name": "c", "strike_date": "2026-12-18", "legs": [], "entry": 1e400}'
        assert (await post(h, "/probe/positions", body)).json()["detail"] == (
            "✖ Too small: expected array to have >=1 items\n  → at legs\n"
            "✖ Invalid input: expected number, received Infinity\n  → at entry"
        )
