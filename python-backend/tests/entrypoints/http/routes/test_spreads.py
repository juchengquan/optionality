"""`POST /spreads`. Port of backend/src/entrypoints/http/routes/spreads.test.ts.

The door scenarios hold what both backends answer; this holds the parts a scenario reads only in
passing — that a refusal is decided before the Provider is asked, that the probe is ONE call, and that
the links and scopes come out as the two older routes would have left them.
"""

import copy
import json

from harness import days_from_now, json_body, poisonable
from optionality.contract import build_spx_code
from optionality.quote import Batch

EXPIRY = days_from_now(40)
PUTS = [
    {"side": "short", "option_type": "PUT", "strike": 7150},
    {"side": "long", "option_type": "PUT", "strike": 7100},
]
CALLS = [
    {"side": "short", "option_type": "CALL", "strike": 7700},
    {"side": "long", "option_type": "CALL", "strike": 7750},
]


def held_spread(name, legs, entry, short):
    return {
        "name": name,
        "legs": legs,
        "held": True,
        "entry": entry,
        "opened_at": "2026-10-01",
        "monitors": [{"threshold": entry * 2}, {**short, "threshold": 0.3}],
    }


def condor():
    return {
        "strike_date": EXPIRY,
        "spreads": [
            held_spread("p", PUTS, 1.5, {"option_type": "PUT", "strike": 7150}),
            held_spread("c", CALLS, 1.25, {"option_type": "CALL", "strike": 7700}),
        ],
    }


def counting(inner=None):
    """Every code each probe asked for, in order."""
    asked: list[list[str]] = []

    async def fetch(codes):
        asked.append(list(codes))
        if inner is None:
            return Batch(records=[{"code": c} for c in codes], unknown=[])
        return await inner(codes)

    return asked, fetch


async def post(h, payload):
    return await h.call("/spreads", **json_body(payload))


def count(h, table):
    return h.db.execute(f"select count(*) from {table}").fetchone()[0]


def nothing_written(h):
    assert [count(h, "positions"), count(h, "monitors"), count(h, "monitor_positions")] == [0, 0, 0]


def code(type_, strike):
    return build_spx_code(EXPIRY, type_, strike)


class TestAddingSpreadsWithTheirMonitors:
    async def test_records_a_condor_as_two_holdings_and_four_monitors_probing_every_leg_in_one_call(self, start):
        asked, fetch = counting()
        h = start(fetch_quotes=fetch)
        resp = await post(h, condor())
        added = resp.json()
        assert resp.status_code == 201, json.dumps(added)
        assert [p["name"] for p in added["positions"]] == ["p", "c"]
        assert [[m["code"], m["field"]] for m in added["monitors"]] == [
            ["p", "mid_price"],
            [code("PUT", 7150), "option_delta"],
            ["c", "mid_price"],
            [code("CALL", 7700), "option_delta"],
        ]
        assert asked == [sorted(code(leg["option_type"], leg["strike"]) for leg in PUTS + CALLS)]

        positions = h.db.execute("select name, entry, opened_at, contracts from positions order by name").fetchall()
        assert [tuple(p) for p in positions] == [("c", 1.25, "2026-10-01", 1), ("p", 1.5, "2026-10-01", 1)]
        value = h.db.execute(
            "select option_type, threshold, direction, compare, scope, legs from monitors where code = 'p'"
        ).fetchone()
        assert tuple(value)[:5] == ("CMB", 3, "above", "abs", "all")
        assert json.loads(value[5]) == [
            {"sign": -1, "option_type": "PUT", "strike": 7150},
            {"sign": 1, "option_type": "PUT", "strike": 7100},
        ]
        delta = h.db.execute(
            "select threshold, scope, strike from monitors where field = 'option_delta' and option_type = 'PUT'"
        ).fetchone()
        assert tuple(delta) == (0.3, "leg", 7150)
        assert count(h, "monitor_positions") == 4

    async def test_records_a_watched_spreads_monitors_and_no_holding(self, start):
        h = start()
        resp = await post(
            h,
            {
                "strike_date": EXPIRY,
                "spreads": [
                    {
                        "name": "w",
                        "legs": PUTS,
                        "held": False,
                        "monitors": [
                            {"threshold": 1.8},
                            {"option_type": "PUT", "strike": 7150, "threshold": 0.15},
                        ],
                    }
                ],
            },
        )
        assert resp.status_code == 201
        assert resp.json()["positions"] == []
        assert [count(h, "positions"), count(h, "monitors"), count(h, "monitor_positions")] == [0, 2, 0]

    async def test_creates_only_the_monitors_it_was_sent(self, start):
        h = start()
        resp = await post(
            h,
            {
                "strike_date": EXPIRY,
                "spreads": [{"name": "p", "legs": PUTS, "held": True, "entry": 1.5, "monitors": [{"threshold": 3}]}],
            },
        )
        assert resp.status_code == 201
        assert [count(h, "positions"), count(h, "monitors")] == [1, 1]

    async def test_writes_nothing_when_one_leg_is_refused_by_the_provider(self, start):
        asked, fetch = counting(poisonable("C7750"))
        h = start(fetch_quotes=fetch)
        resp = await post(h, condor())
        assert resp.status_code == 422
        assert "does not exist" in resp.json()["detail"]
        assert "C7750000" in resp.json()["detail"]
        assert len(asked) == 1
        nothing_written(h)

    async def test_writes_nothing_and_asks_nothing_when_one_monitor_is_invalid(self, start):
        asked, fetch = counting()
        h = start(fetch_quotes=fetch)
        bad = copy.deepcopy(condor())
        bad["spreads"][1]["monitors"][1] = {"option_type": "CALL", "strike": 7700, "threshold": 0}
        resp = await post(h, bad)
        assert resp.status_code == 422
        assert resp.json()["detail"] == (
            "threshold must be positive when compare='abs' (values are compared as absolutes)"
        )
        assert asked == []
        nothing_written(h)

    async def test_refuses_a_leg_rule_on_a_contract_that_is_not_one_of_the_spreads_legs(self, start):
        h = start()
        resp = await post(
            h,
            {
                "strike_date": EXPIRY,
                "spreads": [
                    {
                        "name": "p",
                        "legs": PUTS,
                        "held": False,
                        "monitors": [{"option_type": "PUT", "strike": 7000, "threshold": 0.2}],
                    }
                ],
            },
        )
        assert resp.status_code == 422
        # 7000, as JavaScript writes the number, not Python's 7000.0
        assert resp.json()["detail"] == "monitor 1 of 'p' watches PUT 7000, which is not one of its legs"
        nothing_written(h)

    async def test_refuses_a_rule_that_names_a_leg_by_half(self, start):
        h = start()
        resp = await post(
            h,
            {
                "strike_date": EXPIRY,
                "spreads": [
                    {"name": "p", "legs": PUTS, "held": False, "monitors": [{"strike": 7150, "threshold": 0.2}]}
                ],
            },
        )
        assert resp.status_code == 422
        assert resp.json()["detail"] == "monitor 1 of 'p' names a leg: give both its option_type and its strike"

    async def test_refuses_an_entry_on_a_spread_that_is_only_watched(self, start):
        h = start()
        resp = await post(
            h,
            {
                "strike_date": EXPIRY,
                "spreads": [{"name": "w", "legs": PUTS, "held": False, "entry": 1.5, "monitors": [{"threshold": 2}]}],
            },
        )
        assert resp.status_code == 422
        assert resp.json()["detail"] == (
            "'w' is watched, not held: an entry, a count and an Opened belong to a holding"
        )

    async def test_refuses_a_spread_that_would_record_nothing_at_all(self, start):
        h = start()
        resp = await post(
            h, {"strike_date": EXPIRY, "spreads": [{"name": "w", "legs": PUTS, "held": False, "monitors": []}]}
        )
        assert resp.status_code == 422
        assert resp.json()["detail"] == "'w' is neither held nor watched: nothing would be recorded"

    async def test_refuses_the_value_of_a_single_leg(self, start):
        h = start()
        resp = await post(
            h,
            {
                "strike_date": EXPIRY,
                "spreads": [{"name": "s", "legs": PUTS[:1], "held": False, "monitors": [{"threshold": 2}]}],
            },
        )
        assert resp.status_code == 422
        assert resp.json()["detail"] == "'s' has one leg, so its value is that contract's: watch the leg instead"

    async def test_refuses_two_spreads_of_one_name_and_one_rule_given_twice(self, start):
        h = start()
        twice = await post(
            h,
            {
                "strike_date": EXPIRY,
                "spreads": [
                    {"name": "x", "legs": PUTS, "held": False, "monitors": [{"threshold": 2}]},
                    {"name": "x", "legs": CALLS, "held": False, "monitors": [{"threshold": 2}]},
                ],
            },
        )
        assert twice.status_code == 422
        assert twice.json()["detail"] == "'x' is named twice"
        rule = await post(
            h,
            {
                "strike_date": EXPIRY,
                "spreads": [
                    {
                        "name": "x",
                        "legs": PUTS,
                        "held": False,
                        "monitors": [
                            {"option_type": "PUT", "strike": 7150, "threshold": 0.2},
                            {"option_type": "PUT", "strike": 7150, "threshold": 0.3},
                        ],
                    }
                ],
            },
        )
        assert rule.status_code == 422
        assert rule.json()["detail"] == f"the monitor for ({code('PUT', 7150)}, option_delta) is given twice"
        nothing_written(h)

    async def test_refuses_a_name_already_held_and_a_monitor_already_there_without_asking(self, start):
        asked, fetch = counting()
        h = start(fetch_quotes=fetch)
        assert (await post(h, condor())).status_code == 201
        asked.clear()

        held = await post(
            h,
            {"strike_date": EXPIRY, "spreads": [held_spread("p", PUTS, 1, {"option_type": "PUT", "strike": 7150})]},
        )
        assert held.status_code == 409
        assert held.json()["detail"] == "position 'p' already exists"

        watched = await post(
            h,
            {
                "strike_date": EXPIRY,
                "spreads": [
                    {
                        "name": "other",
                        "legs": PUTS,
                        "held": False,
                        "monitors": [{"option_type": "PUT", "strike": 7150, "threshold": 0.2}],
                    }
                ],
            },
        )
        assert watched.status_code == 409
        assert watched.json()["detail"] == f"monitor for ({code('PUT', 7150)}, option_delta) already exists"
        assert asked == []
        assert [count(h, "positions"), count(h, "monitors")] == [2, 4]

    async def test_adopts_a_rule_already_watching_what_the_new_holding_holds(self, start):
        h = start()
        before = await h.call(
            "/monitors",
            **json_body({"strike_date": EXPIRY, "option_type": "PUT", "strike": 7100, "threshold": 0.1}),
        )
        id_ = before.json()["id"]
        resp = await post(
            h,
            {
                "strike_date": EXPIRY,
                "spreads": [{"name": "p", "legs": PUTS, "held": True, "entry": 1.5, "monitors": []}],
            },
        )
        assert resp.status_code == 201
        assert h.db.execute("select scope from monitors where id = ?", (id_,)).fetchone()[0] == "leg"

    async def test_refuses_an_empty_request_and_an_unreadable_expiry_in_zods_words(self, start):
        h = start()
        empty = await post(h, {"strike_date": EXPIRY, "spreads": []})
        assert empty.status_code == 422
        assert empty.json()["detail"] == "✖ Too small: expected array to have >=1 items\n  → at spreads"
        date = await post(h, {**condor(), "strike_date": "next friday"})
        assert date.status_code == 422
        assert "invalid strike_date 'next friday'" in date.json()["detail"]
