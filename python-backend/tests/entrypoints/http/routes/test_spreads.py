"""`POST /spreads`. Port of backend/src/entrypoints/http/routes/spreads.test.ts.

The door scenarios hold what both backends answer; this holds the parts a scenario reads only in
passing — that a refusal is decided before the Provider is asked, that the probe is ONE call, and that
the links and scopes come out as the two older routes would have left them.
"""

import asyncio
import copy
import json
import re
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

import pytest
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

#: six legs on one expiry: the most one spread may have (#334)
SIX = [
    *PUTS,
    *CALLS,
    {"side": "long", "option_type": "PUT", "strike": 7050},
    {"side": "long", "option_type": "CALL", "strike": 7800},
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


def links_of(h, monitor_id):
    """The rows a monitor links to, and its scope."""
    ids = [
        r[0]
        for r in h.db.execute(
            "select position_id from monitor_positions where monitor_id = ? order by position_id", (monitor_id,)
        )
    ]
    return [ids, h.db.execute("select scope from monitors where id = ?", (monitor_id,)).fetchone()[0]]


def created(resp):
    data = resp.json()
    assert resp.status_code == 201, json.dumps(data)
    return data


async def holding(h, name, legs):
    return created(
        await h.call("/positions", **json_body({"name": name, "strike_date": EXPIRY, "legs": legs, "entry": 1}))
    )


class TestLinkingANewHoldingsOwnMonitors:
    """A holding that shares a contract with another one was the case positions_holding calls ambiguous
    against the whole book: its own stop and delta rule came out linked to nothing."""

    async def test_links_them_to_the_holding_they_were_made_for_when_another_holding_shares_a_leg(self, start):
        h = start()
        await holding(
            h,
            "first",
            [
                {"side": "short", "option_type": "PUT", "strike": 7100},
                {"side": "long", "option_type": "PUT", "strike": 7050},
            ],
        )
        added = created(
            await post(
                h,
                {
                    "strike_date": EXPIRY,
                    "spreads": [held_spread("second", PUTS, 1.5, {"option_type": "PUT", "strike": 7150})],
                },
            )
        )
        second = added["positions"][0]["id"]
        assert [links_of(h, m["id"]) for m in added["monitors"]] == [[[second], "all"], [[second], "leg"]]

    async def test_links_them_to_the_new_holding_when_it_scales_in_on_the_same_strikes(self, start):
        h = start()
        await holding(h, "first", PUTS)
        added = created(
            await post(
                h,
                {
                    "strike_date": EXPIRY,
                    "spreads": [held_spread("second", PUTS, 1.5, {"option_type": "PUT", "strike": 7150})],
                },
            )
        )
        second = added["positions"][0]["id"]
        assert [links_of(h, m["id"]) for m in added["monitors"]] == [[[second], "all"], [[second], "leg"]]


class TestAllOfItOrNoneOfItWhenTheWriteItselfFails:
    """A probe that writes behind the checks' backs: what a second save landing between this one's checks
    and its transaction looks like."""

    @staticmethod
    def racing(holder, sql):
        async def fetch(codes):
            holder["h"].db.execute(sql)
            return Batch(records=[{"code": c} for c in codes], unknown=[])

        return fetch

    async def test_leaves_nothing_behind_when_a_monitor_clashes_after_the_holdings_were_written(self, start):
        holder = {}
        holder["h"] = h = start(
            fetch_quotes=self.racing(
                holder,
                f"""insert into monitors (id, code, strike_date, option_type, strike, field, threshold, direction,
                compare, enabled, triggered, created_at) values ('race', 'c', '{EXPIRY}', 'CMB', 0, 'mid_price', 9,
                'above', 'abs', 1, 0, '2026-10-02 00:00:00.000000')""",
            )
        )
        resp = await post(h, condor())
        assert resp.status_code == 409
        assert resp.json()["detail"] == "monitor for (c, mid_price) already exists"
        assert [count(h, "positions"), count(h, "monitors"), count(h, "monitor_positions")] == [0, 1, 0]

    async def test_leaves_nothing_behind_when_a_holdings_name_is_taken_after_the_checks(self, start):
        holder = {}
        holder["h"] = h = start(
            fetch_quotes=self.racing(
                holder,
                f"""insert into positions (id, name, strike_date, contracts, legs, created_at)
                values ('race', 'c', '{EXPIRY}', 1, '[]', '2026-10-02 00:00:00.000000')""",
            )
        )
        resp = await post(h, condor())
        assert resp.status_code == 409
        assert resp.json()["detail"] == "position 'c' already exists"
        assert [count(h, "positions"), count(h, "monitors"), count(h, "monitor_positions")] == [1, 0, 0]


class TestASpreadOfSixLegs:
    async def test_is_recorded_with_its_value_and_every_short_legs_delta_probing_all_six_in_one_call(self, start):
        asked, fetch = counting()
        h = start(fetch_quotes=fetch)
        spread = {
            "name": "six",
            "legs": SIX,
            "held": True,
            "entry": 3,
            "opened_at": "2026-10-01",
            "monitors": [
                {"threshold": 6},
                {"option_type": "PUT", "strike": 7150, "threshold": 0.3},
                {"option_type": "CALL", "strike": 7700, "threshold": 0.3},
            ],
        }
        resp = await post(h, {"strike_date": EXPIRY, "spreads": [spread]})
        assert resp.status_code == 201, json.dumps(resp.json())
        assert asked == [sorted(code(leg["option_type"], leg["strike"]) for leg in SIX)]
        assert len(json.loads(h.db.execute("select legs from positions").fetchone()[0])) == 6
        value = h.db.execute("select legs from monitors where field = 'mid_price'").fetchone()[0]
        assert [leg["sign"] for leg in json.loads(value)] == [-1, 1, -1, 1, 1, 1]


class TestWhatASpreadMayNotSay:
    @staticmethod
    async def refused(h, payload):
        resp = await post(h, payload)
        assert resp.status_code == 422
        return resp.json()["detail"]

    @staticmethod
    def one(**over):
        spread = {"name": "w", "legs": PUTS, "held": False, "monitors": [{"threshold": 2}], **over}
        return {"strike_date": EXPIRY, "spreads": [spread]}

    async def test_a_blank_name(self, start):
        h = start()
        assert await self.refused(h, self.one(name="")) == (
            "✖ Too small: expected string to have >=1 characters\n  → at spreads[0].name"
        )

    async def test_one_contract_twice_on_one_side_or_on_both(self, start):
        h = start()
        assert await self.refused(h, self.one(legs=[PUTS[0], PUTS[0]])) == (
            "'w' names PUT 7150 twice: give the one leg a quantity"
        )
        assert await self.refused(h, self.one(legs=[PUTS[0], {**PUTS[0], "side": "long"}])) == (
            "'w' is both short and long PUT 7150"
        )
        nothing_written(h)

    async def test_more_than_eight_spreads_or_more_than_six_legs_to_one(self, start):
        h = start()
        nine = [{"name": f"w{i}", "legs": PUTS, "held": False, "monitors": [{"threshold": 2}]} for i in range(9)]
        assert await self.refused(h, {"strike_date": EXPIRY, "spreads": nine}) == (
            "✖ Too big: expected array to have <=8 items\n  → at spreads"
        )
        seven = [*SIX, {"side": "long", "option_type": "CALL", "strike": 7850}]
        assert await self.refused(h, self.one(legs=seven)) == (
            "✖ Too big: expected array to have <=6 items\n  → at spreads[0].legs"
        )

    async def test_more_than_32_legs_in_all_before_the_provider_is_asked(self, start):
        asked, fetch = counting()
        h = start(fetch_quotes=fetch)
        six = [{"name": f"w{i}", "legs": SIX, "held": False, "monitors": [{"threshold": 2}]} for i in range(6)]
        assert await self.refused(h, {"strike_date": EXPIRY, "spreads": six}) == (
            "this request has 36 legs: at most 32 in one request"
        )
        assert asked == []
        nothing_written(h)
        # decided FIRST in the request's own checks: a name given twice, which is refused in step 1
        # too, is not what a request this size is told
        twice = [{**sp, "name": f"w{i % 2}"} for i, sp in enumerate(six)]
        assert await self.refused(h, {"strike_date": EXPIRY, "spreads": twice}) == (
            "this request has 36 legs: at most 32 in one request"
        )
        # 32 exactly is within it
        legs32 = [*six[:5], {**six[5], "legs": SIX[:2]}]
        assert (await post(h, {"strike_date": EXPIRY, "spreads": legs32})).status_code == 201


#: a put butterfly, 1×2×1, the middle sold twice over (#351)
FLY = [
    {"side": "long", "option_type": "PUT", "strike": 7100},
    {"side": "short", "option_type": "PUT", "strike": 7150, "qty": 2},
    {"side": "long", "option_type": "PUT", "strike": 7200},
]


class TestAQuantityPerLeg:
    @staticmethod
    def fly(**over):
        spread = {
            "name": "fly",
            "legs": FLY,
            "held": True,
            "entry": -1.2,
            "opened_at": "2026-10-01",
            "monitors": [{"threshold": 2.4}, {"option_type": "PUT", "strike": 7150, "threshold": 0.3}],
            **over,
        }
        return {"strike_date": EXPIRY, "spreads": [spread]}

    @staticmethod
    async def refused(h, payload):
        resp = await post(h, payload)
        assert resp.status_code == 422
        return resp.json()["detail"]

    async def test_records_a_butterfly_as_one_leg_per_contract(self, start):
        asked, fetch = counting()
        h = start(fetch_quotes=fetch)
        resp = await post(h, self.fly())
        assert resp.status_code == 201, resp.text
        # three contracts asked, once each: a quantity adds nothing to the probe
        assert asked == [sorted(code(leg["option_type"], leg["strike"]) for leg in FLY)]
        held = h.db.execute("select legs from positions").fetchone()[0]
        assert json.loads(held) == FLY
        value, scope = h.db.execute("select legs, scope from monitors where code = 'fly'").fetchone()
        assert json.loads(value) == [
            {"sign": 1, "option_type": "PUT", "strike": 7100},
            {"sign": -1, "option_type": "PUT", "strike": 7150, "qty": 2},
            {"sign": 1, "option_type": "PUT", "strike": 7200},
        ]
        assert scope == "all"
        # the short leg's |Δ| is one contract's, so one rule on it whatever its quantity
        assert count(h, "monitors") == 2

    async def test_stores_a_quantity_of_one_as_no_quantity(self, start):
        h = start()
        ones = [{**leg, "qty": 1} for leg in FLY]
        assert (await post(h, self.fly(legs=ones))).status_code == 201
        held = h.db.execute("select legs from positions").fetchone()[0]
        assert not any("qty" in leg for leg in json.loads(held))
        value = h.db.execute("select legs from monitors where code = 'fly'").fetchone()[0]
        assert not any("qty" in leg for leg in json.loads(value))

    async def test_serves_the_quantity_back_on_the_holding_and_on_the_rule(self, start):
        h = start()
        assert (await post(h, self.fly())).status_code == 201
        [position] = (await h.call("/positions")).json()
        assert position["legs"][1] == {"side": "short", "option_type": "PUT", "strike": 7150, "qty": 2}
        assert "qty" not in position["legs"][0]
        monitors = (await h.call("/monitors")).json()
        value = next(m for m in monitors if m["code"] == "fly")
        assert value["legs"][1] == {"sign": -1, "option_type": "PUT", "strike": 7150, "qty": 2}
        assert "qty" not in value["legs"][0]

    async def test_refuses_a_quantity_of_none_of_more_than_ten_or_of_a_part(self, start):
        asked, fetch = counting()
        h = start(fetch_quotes=fetch)

        def at(qty):
            return self.fly(legs=[FLY[0], {**FLY[1], "qty": qty}, FLY[2]])

        assert await self.refused(h, at(0)) == "✖ Too small: expected number to be >=1\n  → at spreads[0].legs[1].qty"
        assert await self.refused(h, at(11)) == "✖ Too big: expected number to be <=10\n  → at spreads[0].legs[1].qty"
        assert await self.refused(h, at(1.5)) == (
            "✖ Invalid input: expected int, received number\n  → at spreads[0].legs[1].qty"
        )
        assert asked == []
        nothing_written(h)

    @staticmethod
    def scope_of(h, code):
        return h.db.execute(
            "select m.scope, group_concat(p.name) from monitors m left join monitor_positions mp on mp.monitor_id = m.id "
            "left join positions p on p.id = mp.position_id where m.code = ? group by m.id",
            (code,),
        ).fetchone()

    async def test_adopts_a_watched_1x1x1_into_a_held_butterfly_as_a_leg_rule(self, start):
        h = start()
        one = [{k: v for k, v in leg.items() if k != "qty"} for leg in FLY]
        watched = {"name": "w", "legs": one, "held": False, "monitors": [{"threshold": 2}]}
        assert (await post(h, {"strike_date": EXPIRY, "spreads": [watched]})).status_code == 201
        assert (await post(h, self.fly())).status_code == 201
        assert self.scope_of(h, "w") == ("leg", "fly")
        assert self.scope_of(h, "fly") == ("all", "fly")

    async def test_adopts_a_watched_butterfly_into_a_held_1x1x1_as_a_leg_rule(self, start):
        h = start()
        one = [{k: v for k, v in leg.items() if k != "qty"} for leg in FLY]
        watched = {"name": "w", "legs": FLY, "held": False, "monitors": [{"threshold": 2}]}
        assert (await post(h, {"strike_date": EXPIRY, "spreads": [watched]})).status_code == 201
        assert (await post(h, self.fly(name="one", legs=one, entry=0.5))).status_code == 201
        assert self.scope_of(h, "w") == ("leg", "one")
        assert self.scope_of(h, "one") == ("all", "one")

    async def test_counts_legs_not_contracts_times_quantity_against_the_probes_bound(self, start):
        h = start()
        tens = [{**leg, "qty": 10} for leg in SIX]
        many = [{"name": f"w{i}", "legs": tens, "held": False, "monitors": [{"threshold": 2}]} for i in range(5)]
        # 30 legs, 300 contracts: 30 codes at most are asked
        assert (await post(h, {"strike_date": EXPIRY, "spreads": many})).status_code == 201


class TestAHeldSpreadReplacingTheWatchRulesItClashesWith:
    @staticmethod
    async def watch(h, monitors):
        return created(
            await post(
                h,
                {
                    "strike_date": EXPIRY,
                    "spreads": [{"name": "p", "legs": PUTS, "held": False, "monitors": monitors}],
                },
            )
        )

    @staticmethod
    def ids(h):
        return [r[0] for r in h.db.execute("select id from monitors order by id")]

    async def test_deletes_the_clashing_watch_rules_and_makes_the_holdings_in_their_place(self, start):
        h = start()
        watched = await self.watch(h, [{"threshold": 1.8}, {"option_type": "PUT", "strike": 7150, "threshold": 0.15}])
        added = created(
            await post(
                h,
                {
                    "strike_date": EXPIRY,
                    "spreads": [held_spread("p", PUTS, 1.5, {"option_type": "PUT", "strike": 7150})],
                },
            )
        )
        assert added["replaced"] == watched["monitors"]
        now = self.ids(h)
        assert len(now) == 2
        assert not {m["id"] for m in watched["monitors"]} & set(now)
        id_ = added["positions"][0]["id"]
        assert [links_of(h, m["id"]) for m in added["monitors"]] == [[[id_], "all"], [[id_], "leg"]]
        assert h.db.execute("select threshold from monitors where code = 'p'").fetchone()[0] == 3

    async def test_leaves_a_watch_rule_alone_when_its_default_was_switched_off(self, start):
        h = start()
        watched = await self.watch(h, [{"threshold": 1.8}, {"option_type": "PUT", "strike": 7150, "threshold": 0.15}])
        spread = {**held_spread("p", PUTS, 1.5, {"option_type": "PUT", "strike": 7150}), "monitors": [{"threshold": 3}]}
        added = created(await post(h, {"strike_date": EXPIRY, "spreads": [spread]}))
        assert added["replaced"] == [watched["monitors"][0]]
        kept = watched["monitors"][1]["id"]
        assert kept in self.ids(h)
        assert h.db.execute("select threshold from monitors where id = ?", (kept,)).fetchone()[0] == 0.15
        assert links_of(h, kept) == [[added["positions"][0]["id"]], "leg"]

    async def test_refuses_writing_nothing_a_clash_with_a_rule_another_holding_owns(self, start):
        h = start()
        await holding(h, "first", PUTS)
        owned = created(
            await h.call(
                "/monitors",
                **json_body({"strike_date": EXPIRY, "option_type": "PUT", "strike": 7150, "threshold": 0.2}),
            )
        )
        assert len(links_of(h, owned["id"])[0]) == 1
        resp = await post(
            h,
            {
                "strike_date": EXPIRY,
                "spreads": [held_spread("second", PUTS, 1.5, {"option_type": "PUT", "strike": 7150})],
            },
        )
        assert resp.status_code == 409
        assert [count(h, "positions"), count(h, "monitors")] == [1, 1]

    async def ringing(self, h, enabled=True, **over):
        """A watch rule on the 7150 put's delta, ringing since an alarm was sent, as the sweep left it."""
        watched = await self.watch(h, [{"option_type": "PUT", "strike": 7150, "threshold": 0.15, **over}])
        id_ = watched["monitors"][0]["id"]
        h.db.execute(
            "update monitors set triggered = 1, last_alarm_at = '2026-11-09 15:00:00.000000', last_value = -0.21, "
            "enabled = ? where id = ?",
            (1 if enabled else 0, id_),
        )
        h.db.commit()
        return id_

    @staticmethod
    def state(h):
        return h.db.execute(
            "select triggered, last_alarm_at, last_value from monitors where code = ? and field = 'option_delta'",
            (code("PUT", 7150),),
        ).fetchone()

    @staticmethod
    async def hold_put(h, **rule):
        spread = {
            "name": "p7150", "legs": [PUTS[0]], "held": True, "entry": 2,
            "monitors": [{"option_type": "PUT", "strike": 7150, **rule}],
        }  # fmt: skip
        return created(await post(h, {"strike_date": EXPIRY, "spreads": [spread]}))

    async def test_carries_a_ringing_rules_alarm_over_to_the_holdings_rule_watching_it_the_same_way(self, start):
        # the threshold may move, as a PATCH moving it alone keeps the state (#292): no second "crossed" (#336)
        h = start()
        await self.ringing(h)
        added = await self.hold_put(h, field="option_delta", threshold=0.25)
        assert len(added["replaced"]) == 1
        assert tuple(self.state(h)) == (1, "2026-11-09 15:00:00.000000", -0.21)

    async def test_starts_the_alarm_afresh_where_the_holdings_rule_watches_another_way(self, start):
        h = start()
        await self.ringing(h)
        await self.hold_put(h, field="option_delta", threshold=0.25, direction="below")
        assert tuple(self.state(h)) == (0, None, None)

    async def test_starts_the_alarm_afresh_where_the_watch_rule_was_switched_off(self, start):
        h = start()
        await self.ringing(h, enabled=False)
        await self.hold_put(h, field="option_delta", threshold=0.15)
        assert tuple(self.state(h)) == (0, None, None)

    async def test_never_deletes_for_a_spread_that_is_only_watched(self, start):
        h = start()
        await self.watch(h, [{"threshold": 1.8}])
        resp = await post(
            h,
            {
                "strike_date": EXPIRY,
                "spreads": [{"name": "p", "legs": PUTS, "held": False, "monitors": [{"threshold": 2}]}],
            },
        )
        assert resp.status_code == 409
        assert count(h, "monitors") == 1


class TestGetSpreadsQuote:
    """`GET /spreads/quote` — any SPX structure priced live, in one bounded call (#452, ADR 0027)."""

    D = EXPIRY.replace("-", "")
    #: Thursday 1 October 2026, 11:00 New York: in the regular session
    SESSION = datetime(2026, 10, 1, 15, 0, tzinfo=UTC)
    PUT_SPREAD = f"{D}:-P6800,+P6750"
    CALL_SPREAD = f"{D}:-C7300,+C7350x2"

    @staticmethod
    def leg(bid, ask, delta, **over):
        return {
            "bid_price": bid,
            "ask_price": ask,
            "mid_price": (bid + ask) / 2,
            "option_delta": delta,
            "option_gamma": 0.001,
            "option_theta": -0.5,
            "option_vega": 4,
            "option_implied_volatility": 18,
            "option_contract_size": 100,
            **over,
        }

    def book(self):
        return {
            code("PUT", 6800): self.leg(10.5, 11, -0.2),
            code("PUT", 6750): self.leg(8.25, 8.75, -0.15),
            code("CALL", 7300): self.leg(2.5, 3, 0.2),
            code("CALL", 7350): self.leg(1.5, 2, 0.15),
        }

    def quoting_book(self, book=None, unknown=()):
        book = self.book() if book is None else book

        async def inner(codes):
            return Batch(
                records=[{"code": c, **book[c]} for c in codes if c in book], unknown=[c for c in codes if c in unknown]
            )

        return counting(inner)

    @staticmethod
    async def ask(h, *spreads):
        return await h.call("/spreads/quote?" + "&".join(f"spread={quote(s, safe='')}" for s in spreads))

    async def test_prices_two_structures_in_one_provider_call_carrying_every_distinct_leg_once(self, start):
        asked, fetch = self.quoting_book()
        h = start(fetch_quotes=fetch)
        h.now = self.SESSION
        resp = await self.ask(h, self.PUT_SPREAD, self.CALL_SPREAD, f"{self.D}:-P6800")
        answer = resp.json()
        assert resp.status_code == 200, json.dumps(answer)
        assert asked == [sorted([code("CALL", 7300), code("CALL", 7350), code("PUT", 6750), code("PUT", 6800)])]
        assert answer["phase"] == "regular"
        assert [[leg["code"] for leg in s["legs"]] for s in answer["spreads"]] == [
            [code("PUT", 6800), code("PUT", 6750)],
            [code("CALL", 7300), code("CALL", 7350)],
            [code("PUT", 6800)],
        ]

    async def test_answers_each_structure_s_value_natural_fill_signed_greeks_and_its_legs(self, start):
        h = start(fetch_quotes=self.quoting_book()[1])
        h.now = self.SESSION
        puts, calls = (await self.ask(h, self.PUT_SPREAD, self.CALL_SPREAD)).json()["spreads"]
        assert puts["expiry"] == EXPIRY
        assert puts["value"] == 8.5 - 10.75
        assert puts["natural"] == {"bid": 8.25 - 11, "ask": 8.75 - 10.5}
        assert puts["greeks"]["option_delta"] == pytest.approx(-0.15 + 0.2, abs=1e-10)
        first = puts["legs"][0]
        assert {k: first[k] for k in ("side", "option_type", "strike", "qty", "code", "bid_price", "ask_price")} == {
            "side": "short",
            "option_type": "PUT",
            "strike": 6800,
            "qty": 1,
            "code": code("PUT", 6800),
            "bid_price": 10.5,
            "ask_price": 11,
        }
        assert (first["mid_price"], first["error"], first["last_known"]) == (10.75, None, None)
        # a quantity multiplies its leg's figures
        assert calls["legs"][1]["qty"] == 2
        assert calls["value"] == 2 * 1.75 - 2.75
        assert calls["natural"] == {"bid": 2 * 1.5 - 3, "ask": 2 * 2 - 2.5}
        # the short strikes, as a combo on /quotes places them
        assert [s["code"] for s in calls["short_strikes"]] == [code("CALL", 7300)]

    async def test_draws_the_payoff_from_the_entry_given_else_from_the_mid_else_the_shape_alone(self, start):
        h = start(fetch_quotes=self.quoting_book({**self.book(), code("PUT", 6750): self.leg(0, 0, -0.15)})[1])
        h.now = self.SESSION
        given, mid, shape = (await self.ask(h, f"{self.PUT_SPREAD}@1.25", self.CALL_SPREAD, self.PUT_SPREAD)).json()[
            "spreads"
        ]
        assert (given["payoff_basis"], given["entry"], given["payoff"]["max_profit"]) == ("entry", 1.25, 1.25)
        assert mid["payoff_basis"] == "mid"
        # opened at the mid, a debit of 0.75: what it loses where neither call is in the money
        assert mid["payoff"]["at_strikes"][0] == {"spx": 7300, "pnl": -0.75}
        assert shape["payoff_basis"] == "shape"
        assert [shape["payoff"][k] for k in ("breakevens", "max_profit", "max_loss")] == [None, None, None]
        assert shape["payoff"]["at_strikes"] == [{"spx": 6750, "pnl": -50}, {"spx": 6800, "pnl": 0}]

    async def test_dashes_a_leg_quoted_0_0_and_its_structure_s_value_and_natural_and_still_sums_its_greeks(self, start):
        h = start(fetch_quotes=self.quoting_book({**self.book(), code("PUT", 6750): self.leg(0, 0, -0.15)})[1])
        (puts,) = (await self.ask(h, self.PUT_SPREAD)).json()["spreads"]
        assert (puts["legs"][1]["mid_price"], puts["legs"][1]["error"]) == (None, "no two-sided quote")
        assert (puts["value"], puts["natural"]) == (None, None)
        assert puts["greeks"]["option_delta"] == pytest.approx(0.05, abs=1e-10)

    async def test_serves_each_leg_s_last_regular_session_close_beside_it_never_summed(self, start):
        h = start(fetch_quotes=self.quoting_book({**self.book(), code("PUT", 6750): self.leg(0, 0, -0.15)})[1])
        p6800, p6750 = code("PUT", 6800), code("PUT", 6750)
        # the short put watched alone: Wednesday's close at 16:14 New York; and both, the day before
        h.db.execute(
            "insert into watch_samples (contracts, observed_on, dte, legs_mid, observed_at)"
            " values (?, '2026-09-30', 42, ?, '2026-09-30 20:14:00.000000')",
            (p6800, json.dumps({p6800: 10.25})),
        )
        h.db.execute(
            "insert into watch_samples (contracts, observed_on, dte, legs_mid, observed_at)"
            " values (?, '2026-09-29', 43, ?, '2026-09-29 20:14:00.000000')",
            (",".join(sorted([p6750, p6800])), json.dumps({p6750: 8, p6800: 10})),
        )
        (puts,) = (await self.ask(h, self.PUT_SPREAD)).json()["spreads"]
        k0, k1 = puts["legs"][0]["last_known"], puts["legs"][1]["last_known"]
        assert (k0["price"], k0["observed_on"], k0["timing"]) == (10.25, "2026-09-30", "close")
        assert (k1["price"], k1["observed_on"], k1["timing"]) == (8, "2026-09-29", "close")
        assert puts["value"] is None
        assert puts["payoff_basis"] == "shape"

    async def test_fails_only_the_structure_holding_a_contract_the_provider_does_not_know(self, start):
        h = start(fetch_quotes=self.quoting_book(unknown=[code("CALL", 7350)])[1])
        h.now = self.SESSION
        puts, calls = (await self.ask(h, self.PUT_SPREAD, f"{self.CALL_SPREAD}@-1")).json()["spreads"]
        assert puts["error"] is None
        assert puts["value"] is not None
        assert calls["error"] == f"unknown contract: {code('CALL', 7350)}"
        assert [calls[k] for k in ("value", "natural", "payoff", "payoff_basis")] == [None, None, None, None]
        assert calls["legs"][1]["error"] == "unknown contract"

    async def test_answers_502_in_the_error_shape_when_the_provider_is_down(self, start):
        async def down(codes):
            raise RuntimeError("connect ECONNREFUSED")

        h = start(fetch_quotes=down)
        resp = await self.ask(h, self.PUT_SPREAD)
        assert resp.status_code == 502
        assert resp.json() == {"detail": "moomoo call failed: connect ECONNREFUSED"}

    @pytest.mark.parametrize(
        ("spreads", "words"),
        [
            ([], "give at least one spread"),
            ([f"{D}-P6800"], "is not <expiry>:<legs>"),
            ([f"{D}:-Q6800"], 'leg 1 "-Q6800" is not'),
            (["20261332:-P6800"], "invalid expiry"),
            ([f"{D}:-P6800x0"], "a quantity is 1 to 10, not 0"),
            ([f"{D}:-P6800x11"], "a quantity is 1 to 10, not 11"),
            (["20260930:-P6800"], "20260930 has expired"),
            ([f"{D}:-P6800,+P6750,-P6700,+P6650,-P6600,+P6550,-P6500"], "has 7 legs: at most 6"),
            (
                [*[f"{D}:-P6800,+P6750,-P6700,+P6650,-P6600,+P6550"] * 5, f"{D}:-P6800,+P6750,-P6700"],
                "this request has 33 legs: at most 32 in one request",
            ),
        ],
        ids=[
            "no spread",
            "a structure that is not the grammar",
            "a leg that is not the grammar",
            "an expiry that is no date",
            "quantity 0",
            "quantity 11",
            "an expired expiry",
            "seven legs in one structure",
            "33 legs in all",
        ],
    )
    async def test_refuses_with_422_and_the_reason_asking_the_provider_nothing(self, start, spreads, words):
        asked, fetch = self.quoting_book()
        h = start(fetch_quotes=fetch)
        resp = await self.ask(h, *spreads)
        assert resp.status_code == 422
        assert words in resp.json()["detail"]
        assert asked == []

    async def test_reads_a_raw_plus_in_the_query_which_arrives_as_a_space_as_long(self, start):
        h = start(fetch_quotes=self.quoting_book()[1])
        resp = await h.call(f"/spreads/quote?spread={self.D}:-P6800,+P6750")
        assert resp.status_code == 200
        assert resp.json()["spreads"][0]["legs"][1]["side"] == "long"

    async def test_answers_the_same_request_again_within_5s_from_the_same_call_spending_nothing(self, start):
        asked, fetch = self.quoting_book()
        h = start(fetch_quotes=fetch)
        h.now = self.SESSION
        first = (await self.ask(h, self.PUT_SPREAD, self.CALL_SPREAD)).json()
        h.now = self.SESSION + timedelta(milliseconds=4999)
        # the same structures, the other way round and their legs reordered: the same request
        again = (await self.ask(h, f"{self.D}:+C7350x2,-C7300", self.PUT_SPREAD)).json()
        assert len(asked) == 1
        assert again["fetched_at"] == first["fetched_at"]
        assert again["spreads"][1] == first["spreads"][0]
        h.now = self.SESSION + timedelta(milliseconds=5000)
        await self.ask(h, self.PUT_SPREAD, self.CALL_SPREAD)
        assert len(asked) == 2

    async def test_joins_a_call_still_in_flight_rather_than_making_a_second(self, start):
        gate = asyncio.Event()
        asked, fetch = self.quoting_book()

        async def held(codes):
            answer = await fetch(codes)
            await gate.wait()
            return answer

        h = start(fetch_quotes=held)
        both = asyncio.gather(self.ask(h, self.PUT_SPREAD), self.ask(h, self.PUT_SPREAD))
        await asyncio.sleep(0)
        gate.set()
        assert [r.status_code for r in await both] == [200, 200]
        assert len(asked) == 1

    async def test_refuses_the_13th_uncached_call_inside_30s_with_429_and_the_wait_and_a_cached_one_is_free(
        self, start
    ):
        asked, fetch = self.quoting_book()
        h = start(fetch_quotes=fetch)
        for i in range(12):
            h.now = self.SESSION + timedelta(seconds=i)
            assert (await self.ask(h, f"{self.D}:-P{6000 + i * 5}")).status_code == 200
        assert len(asked) == 12
        # a repeat of the last, inside its 5s, is answered without a call
        assert (await self.ask(h, f"{self.D}:-P6055")).status_code == 200
        refused = await self.ask(h, f"{self.D}:-P6800")
        assert refused.status_code == 429
        # the first call was at +0s and it is now +11s: the next is allowed 19 seconds from now
        assert refused.json() == {
            "detail": "spread quotes are capped at 12 Provider calls in 30 seconds: the next is allowed in 19s"
        }
        assert len(asked) == 12
        h.now = self.SESSION + timedelta(seconds=30)
        assert (await self.ask(h, f"{self.D}:-P6800")).status_code == 200

    async def test_caps_at_spread_quote_calls_per_30s_where_env_says(self, start):
        h = start(fetch_quotes=self.quoting_book()[1], settings={"spread_quote_calls_per_30s": 1})
        assert (await self.ask(h, self.PUT_SPREAD)).status_code == 200
        assert (await self.ask(h, self.CALL_SPREAD)).status_code == 429

    async def test_shares_one_cap_with_the_mcp_door(self, start):
        asked, fetch = self.quoting_book()
        h = start(fetch_quotes=fetch, settings={"spread_quote_calls_per_30s": 1})
        assert (await self.ask(h, self.PUT_SPREAD)).status_code == 200
        message = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "price_spreads",
                "arguments": {
                    "structures": [
                        {"expiry": self.D, "legs": [{"side": "short", "option_type": "CALL", "strike": 7300}]}
                    ]
                },
            },
        }
        resp = await h.call(
            "/mcp", method="POST", content=json.dumps(message), headers={"Content-Type": "application/json"}
        )
        result = resp.json()["result"]
        assert result["isError"] is True
        assert re.search(r"answered 429: spread quotes are capped at 1 Provider calls", result["content"][0]["text"])
        assert len(asked) == 1

    async def test_wants_the_api_s_token(self, start):
        h = start(fetch_quotes=self.quoting_book()[1])
        resp = await h.call(f"/spreads/quote?spread={quote(self.PUT_SPREAD, safe='')}", anonymous=True)
        assert resp.status_code == 401
