"""`/positions`. Port of backend/src/entrypoints/http/routes/positions.test.ts — PARTLY, as the
module is: only `GET /positions` is ported (ADR 0021, phase 3).

Of the TypeScript's tests, the one about the listing itself is here: "lists by expiry, then by name".
It creates its holdings through POST /positions there; POST is not ported, so here they are inserted
as rows the way POST stores them, and the expectation is the TypeScript's. Every other test needs a
route that is not ported yet, and arrives with it. `GET /positions` is also held end to end by the
door scenario `http/get-positions-lists-what-is-held.json`.

What only the Python can get wrong is at the end: the TypeScript parses every answer through its zod
schema, which REFUSES what does not fit, and pydantic, left to its defaults, coerces it instead.
"""

import json

import pytest

from optionality_backend.db.queries import insert_position

CONDOR_LEGS = [
    {"side": "short", "option_type": "CALL", "strike": 8050},
    {"side": "long", "option_type": "CALL", "strike": 8075},
    {"side": "short", "option_type": "PUT", "strike": 7100},
    {"side": "long", "option_type": "PUT", "strike": 7075},
]


def make_position(h, name, strike_date, legs, **over):
    """A holding as POST /positions stores one: what the TypeScript test creates through the route."""
    row = {
        "id": name.ljust(32, "0"),
        "name": name,
        "strategy": None,
        "strike_date": strike_date,
        "contracts": 1,
        "entry": None,
        "legs": json.dumps(legs, separators=(",", ":")),
        "created_at": "2026-10-02 05:26:06.299000",
        "opened_at": None,
        "manage_notified_at": None,
        **over,
    }
    insert_position(h.db, row)
    return row["id"]


class TestGapsTheSinglePositionTestsCannotShow:
    async def test_lists_by_expiry_then_by_name(self, start):
        h = start()
        make_position(h, "zulu", "2026-10-16", [CONDOR_LEGS[0]])
        make_position(h, "alpha", "2026-11-20", [CONDOR_LEGS[1]])
        make_position(h, "mike", "2026-10-16", [CONDOR_LEGS[2]])
        assert [p["name"] for p in (await h.call("/positions")).json()] == ["mike", "zulu", "alpha"]


class TestWhatOnlyThePythonCanGetWrong:
    async def test_answers_the_stored_holding_in_the_shape_the_dashboard_reads(self, start):
        # created_at converts to DISPLAY_TZ; opened_at is a calendar day and does not; the manage-by
        # stamp is the sweep's bookkeeping and is not served
        h = start()
        make_position(
            h, "dec-condor", "2026-12-18", CONDOR_LEGS, strategy="iron condor", entry=6.4, opened_at="2026-10-12"
        )
        assert (await h.call("/positions")).json() == [
            {
                "id": "dec-condor".ljust(32, "0"),
                "name": "dec-condor",
                "strategy": "iron condor",
                "strike_date": "2026-12-18",
                "contracts": 1,
                "entry": 6.4,
                "legs": CONDOR_LEGS,
                "created_at": "2026-10-02 13:26:06+08:00",
                "opened_at": "2026-10-12",
            }
        ]

    async def test_is_an_empty_list_with_nothing_held(self, start):
        assert (await start().call("/positions")).json() == []

    @pytest.mark.parametrize(
        ("why", "legs"),
        [
            # the side the TypeScript's schema is written to refuse: a stored leg that still said "sold"
            # would otherwise be served, and read by the dashboard as long (ADR 0013)
            ("an old side", [{"side": "sold", "option_type": "CALL", "strike": 8050}]),
            # pydantic's default would serve 8050.0; zod's z.number() refuses a string
            ("a strike as text", [{"side": "short", "option_type": "CALL", "strike": "8050"}]),
            # pydantic's default reads true as 1.0; zod refuses it
            ("a strike as a boolean", [{"side": "short", "option_type": "CALL", "strike": True}]),
            ("a leg with a field missing", [{"side": "short", "strike": 8050}]),
            ("legs that are not a list", {"side": "short"}),
        ],
    )
    async def test_refuses_to_serve_a_stored_holding_its_schema_refuses(self, start, why, legs):
        # a 500 in the dashboard's shape, as zod's parse failing inside `reply` is in the TypeScript
        h = start()
        make_position(h, "bad", "2026-12-18", legs)
        resp = await h.call("/positions")
        assert (resp.status_code, resp.json()) == (500, {"detail": "internal error"}), why

    async def test_refuses_a_number_that_is_not_finite_rather_than_writing_infinity(self, start):
        # SQLite's REAL holds an infinity, which zod refuses and json.dumps would write as `Infinity`
        h = start()
        make_position(h, "inf", "2026-12-18", CONDOR_LEGS, entry=float("inf"))
        resp = await h.call("/positions")
        assert (resp.status_code, resp.json()) == (500, {"detail": "internal error"})

    async def test_drops_a_key_a_stored_leg_carries_that_the_schema_does_not_name(self, start):
        # zod's object strips unknown keys, and so does the model
        h = start()
        make_position(h, "extra", "2026-12-18", [{**CONDOR_LEGS[0], "note": "rolled"}])
        assert (await h.call("/positions")).json()[0]["legs"] == [CONDOR_LEGS[0]]

    async def test_reads_stored_legs_as_json_parse_does_refusing_nan(self, start):
        # Python's json reads the bare token NaN, which is not JSON; JSON.parse refuses the whole row.
        # In a key the schema strips, so the model cannot be what refuses it
        h = start()
        make_position(h, "nan", "2026-12-18", [])
        legs = '[{"side":"short","option_type":"CALL","strike":8050,"note":NaN}]'
        h.db.execute("update positions set legs = ? where name = 'nan'", (legs,))
        resp = await h.call("/positions")
        assert (resp.status_code, resp.json()) == (500, {"detail": "internal error"})
