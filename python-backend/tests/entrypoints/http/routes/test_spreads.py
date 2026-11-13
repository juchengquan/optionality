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
        assert await self.refused(h, self.one(legs=[PUTS[0], PUTS[0]])) == "'w' names PUT 7150 twice"
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
