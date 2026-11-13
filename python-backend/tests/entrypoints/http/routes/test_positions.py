"""`/positions`. Port of backend/src/entrypoints/http/routes/positions.test.ts.

Every test comes across, each creating what it needs through the routes as the TypeScript's do. What
only the Python can get wrong is at the end: the TypeScript parses every answer through its zod schema,
which REFUSES what does not fit, where pydantic left to its defaults coerces it; zod's `.optional()`
refuses a null a PATCH might send; and the legs a holding stores are written as JSON.stringify writes
them, because both backends write one file.
"""

import json
import math
from datetime import UTC, datetime

import pytest
from harness import json_body, priced_fetcher
from optionality.contract import build_spx_code, parse_spx_code
from optionality.quote import Batch

from optionality_backend.db.queries import insert_position

EXPIRY = "2026-12-18"
CONDOR_LEGS = [
    {"side": "short", "option_type": "CALL", "strike": 8050},
    {"side": "long", "option_type": "CALL", "strike": 8075},
    {"side": "short", "option_type": "PUT", "strike": 7100},
    {"side": "long", "option_type": "PUT", "strike": 7075},
]


def condor(**over):
    return {
        "name": "1016_IC",
        "strategy": "iron_condor",
        "strike_date": EXPIRY,
        "contracts": 1,
        "entry": 3.0,
        "legs": CONDOR_LEGS,
        **over,
    }


def start_with(start, fetch_quotes=priced_fetcher):
    return start(fetch_quotes=fetch_quotes)


async def post(h, payload):
    return await h.call("/positions", **json_body(payload))


async def patch(h, id_, payload):
    return await h.call(f"/positions/{id_}", **{**json_body(payload), "method": "PATCH"})


async def delete(h, id_):
    return await h.call(f"/positions/{id_}", method="DELETE")


def links(h, monitor_id):
    """The links a monitor has, and the scope it was given."""
    ids = [
        r[0]
        for r in h.db.execute(
            "select position_id from monitor_positions where monitor_id = ? order by position_id", (monitor_id,)
        )
    ]
    row = h.db.execute("select scope from monitors where id = ?", (monitor_id,)).fetchone()
    return ids, (row[0] if row else None)


def created201(resp):
    """The id of what a 201 created, failing with the body when it was not one."""
    data = resp.json()
    assert resp.status_code == 201, json.dumps(data)
    return data["id"]


async def make_monitor(h, **over):
    return created201(
        await h.call(
            "/monitors", **json_body({"field": "option_delta", "threshold": 0.2, "direction": "above", **over})
        )
    )


async def make_position(h, name, strike_date, legs):
    return created201(await post(h, {"name": name, "strike_date": strike_date, "legs": legs}))


def leg_codes():
    return [build_spx_code(EXPIRY, leg["option_type"], leg["strike"]) for leg in CONDOR_LEGS]


def flat(v):
    return {c: v for c in leg_codes()}


class TestWhatVolDidToAHoldingOverItsOwnSamples:
    """The route reads history, which no other route does: every figure elsewhere comes from one live
    batch. It is a separate request from `/quotes` on purpose — the dashboard polls that every 15
    seconds per open tab, and this changes once a market day (ADR 0011)."""

    @staticmethod
    def sample(h, id_, on, dte, iv, vega):
        h.db.execute(
            """insert into position_samples (position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega)
               values (?, ?, ?, 3.0, ?, ?)""",
            (id_, on, dte, None if iv is None else json.dumps(iv), None if vega is None else json.dumps(vega)),
        )

    async def test_measures_the_vol_move_from_the_day_it_was_opened(self, start):
        h = start_with(start)
        id_ = created201(await post(h, condor(opened_at="2026-10-06")))
        sc = leg_codes()[0]
        self.sample(h, id_, "2026-10-06", 45, flat(10), flat(4))
        self.sample(h, id_, "2026-10-07", 44, {**flat(10), sc: 11}, flat(4))

        resp = await h.call(f"/positions/{id_}/vol")
        assert resp.status_code == 200
        # the 8050 call is SOLD, so a point on its vol costs its vega to buy back
        # and the gap it splits, at that same close (#333): 3.00 to close against 3.00 x sqrt(44 / 73)
        # on pace, so the rest is what is left of it once vol's 4 is taken out
        gap = 3.0 - 3.0 * math.sqrt(44 / 73)
        assert resp.json() == {
            "vol": 4,
            "from": "2026-10-06",
            "to": "2026-10-07",
            "days": 1,
            "reason": None,
            # a row with no observed time is said as one, never claimed as the close
            "at": "2026-10-07",
            "timing": "unrecorded",
            "gap": gap,
            "gap_reason": None,
            "rest": gap - 4,
            # the legs' flat vegas cancel: no cover, and why
            "vega": 0,
            "cover": None,
            "cover_reason": "its legs' vegas cancel out, so no move in vol would cover the gap",
        }

    async def test_says_so_plainly_when_there_is_no_baseline_rather_than_guessing_one(self, start):
        # the live condor's case, and the shape every Position declared after the fact is in
        h = start_with(start)
        id_ = created201(await post(h, condor(opened_at="2026-10-06")))
        self.sample(h, id_, "2026-10-12", 39, flat(10), flat(4))
        self.sample(h, id_, "2026-10-13", 38, flat(11), flat(4))

        resp = await h.call(f"/positions/{id_}/vol")
        assert resp.status_code == 200
        got = resp.json()
        assert {k: got[k] for k in ("vol", "from", "to", "days", "rest", "at")} == {
            "vol": None,
            "from": None,
            "to": None,
            "days": None,
            "rest": None,
            "at": "2026-10-13",
        }
        # and says why, in the service's words, for the dashboard to say as they are (#333)
        assert got["reason"] == (
            "its samples begin on 12 Oct, not on 6 Oct when it was Opened: the vol it was sold at was never recorded"
        )

    async def test_survives_a_sample_whose_stored_reading_is_not_a_number(self, start):
        # The route's own comment promises "a corrupt map costs the figure, never the request", and only
        # unparseable TEXT was covered. A map that parses but holds a string gave vol: NaN, and the
        # output schema REJECTS NaN — so the request answered 500 instead of a null figure. Found by a
        # code review; the 500 path had no test at all.
        h = start_with(start)
        id_ = created201(await post(h, condor(opened_at="2026-10-06")))
        sc = leg_codes()[0]
        self.sample(h, id_, "2026-10-06", 45, {**flat(10), sc: "not a number"}, flat(4))

        resp = await h.call(f"/positions/{id_}/vol")
        assert resp.status_code == 200, "a figure it cannot compute is not a server error"
        assert resp.json()["vol"] is None

    async def test_survives_a_sample_whose_stored_reading_is_a_json_null(self, start):
        # how a bad OpenD field actually lands: Number() of it is NaN, and JSON.stringify writes NaN as
        # null. The writer now rejects it, so this is the reader holding the line for rows already
        # stored that way.
        h = start_with(start)
        id_ = created201(await post(h, condor(opened_at="2026-10-06")))
        sc = leg_codes()[0]
        self.sample(h, id_, "2026-10-06", 45, {**flat(10), sc: None}, flat(4))

        resp = await h.call(f"/positions/{id_}/vol")
        assert resp.status_code == 200
        assert resp.json()["vol"] is None

    async def test_is_404_for_a_position_that_does_not_exist(self, start):
        h = start_with(start)
        assert (await h.call("/positions/nope/vol")).status_code == 404

    async def test_survives_a_sample_whose_stored_json_will_not_parse(self, start):
        # the maps are written by the sweeper and read here; a corrupt one should cost the figure, never
        # the request. Nothing else on the dashboard would load if this threw.
        h = start_with(start)
        id_ = created201(await post(h, condor(opened_at="2026-10-06")))
        h.db.execute(
            """insert into position_samples (position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega)
               values (?, '2026-10-06', 45, 3.0, '{not json', null)""",
            (id_,),
        )

        resp = await h.call(f"/positions/{id_}/vol")
        assert resp.status_code == 200
        assert resp.json()["vol"] is None


class TestAHoldingsDailySamples:
    """Stored history and nothing live (#295): the Provider throws once the holding is made, so a samples
    route that asked it anything would fail rather than pass."""

    @staticmethod
    def sample(h, id_, on, dte, cost, observed_at, iv=None, vega=None, delta=None, spx=None):
        h.db.execute(
            """insert into position_samples
                 (position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega, legs_delta, observed_at, spx)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (id_, on, dte, cost, iv, vega, delta, observed_at, spx),
        )

    @staticmethod
    async def made(start, **over):
        state = {"open": True}

        async def fetch(codes):
            if not state["open"]:
                raise RuntimeError("the samples asked the Provider")
            return [{"code": c} for c in codes]

        h = start_with(start, fetch)
        id_ = created201(await post(h, condor(**over)))
        state["open"] = False
        return h, id_

    async def test_serves_each_days_figures_its_on_pace_and_whether_it_was_a_close(self, start):
        h, id_ = await self.made(start, opened_at="2026-10-06", entry=3)
        self.sample(
            h, id_, "2026-10-06", 73, 2.9, "2026-10-06 20:00:00.000000",
            json.dumps(flat(14.5)), json.dumps(flat(4.25)), json.dumps(flat(0.2)), 6612.5,
        )  # fmt: skip
        self.sample(h, id_, "2026-10-07", 72, 2.75, "2026-10-08 00:30:00.000000")
        self.sample(h, id_, "2026-10-08", 71, 2.5, None)

        resp = await h.call(f"/positions/{id_}/samples")
        assert resp.status_code == 200
        data = resp.json()
        assert data["levels"] == {"dte_at_open": 73, "target": 1.5, "stop": 6, "target_dte": 18, "manage_by_dte": 21}
        assert data["samples"] == [
            {
                "observed_on": "2026-10-06", "observed_at": "2026-10-07 04:00:00+08:00", "timing": "close",
                "dte": 73, "cost_to_close": 2.9, "on_pace": 3, "spx": 6612.5,
                "legs_iv": flat(14.5), "legs_vega": flat(4.25), "legs_delta": flat(0.2),
            },
            {
                "observed_on": "2026-10-07", "observed_at": "2026-10-08 08:30:00+08:00", "timing": "after-close",
                "dte": 72, "cost_to_close": 2.75, "on_pace": 3 * math.sqrt(72 / 73), "spx": None,
                "legs_iv": None, "legs_vega": None, "legs_delta": None,
            },
            {
                "observed_on": "2026-10-08", "observed_at": None, "timing": "unrecorded",
                "dte": 71, "cost_to_close": 2.5, "on_pace": 3 * math.sqrt(71 / 73), "spx": None,
                "legs_iv": None, "legs_vega": None, "legs_delta": None,
            },
        ]  # fmt: skip

    async def test_serves_the_planned_decay_at_every_dte_from_the_open_to_expiry(self, start):
        h, id_ = await self.made(start, opened_at="2026-10-06", entry=3)
        plan = (await h.call(f"/positions/{id_}/samples")).json()["plan"]
        assert len(plan) == 74
        assert plan[0] == {"dte": 73, "on_pace": 3}
        assert plan[73 - 21] == {"dte": 21, "on_pace": 3 * math.sqrt(21 / 73)}
        assert plan[73] == {"dte": 0, "on_pace": 0}

    async def test_serves_no_schedule_and_no_plan_for_a_holding_whose_opened_nobody_recorded(self, start):
        h, id_ = await self.made(start, entry=3)
        self.sample(h, id_, "2026-10-06", 73, 2.9, "2026-10-06 20:00:00.000000")
        data = (await h.call(f"/positions/{id_}/samples")).json()
        assert data["levels"] is None
        assert data["plan"] == []
        assert data["samples"][0]["on_pace"] is None
        assert data["samples"][0]["cost_to_close"] == 2.9

    async def test_serves_a_debits_schedule_with_no_target_or_stop_and_its_signed_decay(self, start):
        h, id_ = await self.made(start, opened_at="2026-10-06", entry=-2)
        data = (await h.call(f"/positions/{id_}/samples")).json()
        assert data["levels"] == {
            "dte_at_open": 73, "target": None, "stop": None, "target_dte": None, "manage_by_dte": 21,
        }  # fmt: skip
        assert data["plan"][0] == {"dte": 73, "on_pace": -2}

    async def test_serves_nothing_after_a_backdated_close_and_deletes_nothing(self, start):
        h, id_ = await self.made(start, opened_at="2026-10-06", entry=3)
        self.sample(h, id_, "2026-10-06", 73, 2.9, "2026-10-06 20:00:00.000000")
        self.sample(h, id_, "2026-10-07", 72, 2.8, "2026-10-07 20:00:00.000000")
        h.db.execute("update positions set closed_on = '2026-10-06', exit = 2.9 where id = ?", (id_,))
        data = (await h.call(f"/positions/{id_}/samples")).json()
        assert [s["observed_on"] for s in data["samples"]] == ["2026-10-06"]
        assert h.db.execute("select count(*) from position_samples").fetchone()[0] == 2

    async def test_costs_a_corrupt_map_its_own_figure_never_the_request(self, start):
        h, id_ = await self.made(start, opened_at="2026-10-06", entry=3)
        sc = leg_codes()[0]
        self.sample(
            h, id_, "2026-10-06", 73, 2.9, "2026-10-06 20:00:00.000000",
            "{not json", json.dumps({**flat(4), sc: "four"}), json.dumps([0.2]),
        )  # fmt: skip
        resp = await h.call(f"/positions/{id_}/samples")
        assert resp.status_code == 200
        s = resp.json()["samples"][0]
        assert [s["legs_iv"], s["legs_vega"], s["legs_delta"]] == [None, None, None]

    async def test_costs_a_stamp_it_cannot_read_its_own_timing_never_the_request(self, start):
        h, id_ = await self.made(start, opened_at="2026-10-06", entry=3)
        self.sample(h, id_, "2026-10-06", 73, 2.9, "2026-10-06T20:00:00Z")
        self.sample(h, id_, "2026-10-07", 72, 2.8, "garbage")
        resp = await h.call(f"/positions/{id_}/samples")
        assert resp.status_code == 200
        assert [[s["timing"], s["observed_at"]] for s in resp.json()["samples"]] == [
            ["unrecorded", None],
            ["unrecorded", None],
        ]

    async def test_costs_a_reading_too_large_for_a_double_its_map_never_the_request(self, start):
        # JSON.parse reads 1e400 as Infinity; Python reads an integer that long exactly, and math.isfinite
        # of it overflows
        h, id_ = await self.made(start, opened_at="2026-10-06", entry=3)
        sc = leg_codes()[0]
        self.sample(h, id_, "2026-10-06", 73, 2.9, "2026-10-06 20:00:00.000000", f'{{"{sc}": 1{"0" * 400}}}')
        resp = await h.call(f"/positions/{id_}/samples")
        assert resp.status_code == 200
        assert resp.json()["samples"][0]["legs_iv"] is None

    async def test_answers_an_empty_history_for_a_holding_never_sampled(self, start):
        h, id_ = await self.made(start, opened_at="2026-10-06", entry=3)
        assert (await h.call(f"/positions/{id_}/samples")).json()["samples"] == []

    async def test_is_404_for_a_holding_that_does_not_exist(self, start):
        h = start_with(start)
        assert (await h.call("/positions/nope/samples")).status_code == 404


PUT_SPREAD = [
    {"side": "short", "option_type": "PUT", "strike": 7100},
    {"side": "long", "option_type": "PUT", "strike": 7075},
]
FAR_PUT_SPREAD = [
    {"side": "short", "option_type": "PUT", "strike": 6000},
    {"side": "long", "option_type": "PUT", "strike": 5950},
]


class TestThePayoffAtExpiry:
    """At expiry only, so it needs the legs, the Entry and the count and nothing else (ADR 0023): neither
    form may ask the Provider anything. The Provider here prices what a creation probe asks, and is then
    told to refuse, so a payoff that reached it would fail rather than pass (#291)."""

    @staticmethod
    def watching():
        state = {"open": True, "asked": []}

        async def fetch(codes):
            if not state["open"]:
                state["asked"].append(codes)
                raise RuntimeError("the payoff asked the Provider")
            return [{"code": c} for c in codes]

        return state, fetch

    async def test_draws_a_holdings_from_its_legs_its_entry_and_its_count_asking_the_provider_nothing(self, start):
        state, fetch = self.watching()
        h = start_with(start, fetch)
        id_ = created201(await post(h, condor(entry=3, contracts=2)))
        state["open"] = False
        resp = await h.call(f"/positions/{id_}/payoff")
        assert resp.status_code == 200
        assert resp.json() == {
            "at_strikes": [
                {"spx": 7075, "pnl": -44},
                {"spx": 7100, "pnl": 6},
                {"spx": 8050, "pnl": 6},
                {"spx": 8075, "pnl": -44},
            ],
            "slope_below": 0,
            "slope_above": 0,
            "breakevens": [7097, 8053],
            "max_profit": 6,
            "max_loss": -44,
        }
        assert state["asked"] == []

    async def test_draws_a_closed_holdings_too(self, start):
        state, fetch = self.watching()
        h = start_with(start, fetch)
        id_ = created201(await post(h, condor()))
        assert (await h.call(f"/positions/{id_}/close", **json_body({"exit": 1}))).status_code == 200
        state["open"] = False
        assert (await h.call(f"/positions/{id_}/payoff")).status_code == 200

    async def test_is_404_for_a_holding_that_does_not_exist(self, start):
        h = start_with(start)
        assert (await h.call("/positions/nope/payoff")).status_code == 404

    async def test_refuses_a_holding_with_no_entry(self, start):
        state, fetch = self.watching()
        h = start_with(start, fetch)
        id_ = created201(await post(h, condor(entry=None)))
        state["open"] = False
        resp = await h.call(f"/positions/{id_}/payoff")
        assert resp.status_code == 422
        assert resp.json()["detail"] == "position '1016_IC' has no entry: record what was taken in to draw its payoff"

    async def test_draws_draft_legs_for_an_entry_writing_nothing_and_asking_the_provider_nothing(self, start):
        state, fetch = self.watching()
        h = start_with(start, fetch)
        state["open"] = False
        before = h.db.execute("select count(*) from positions").fetchone()[0]
        resp = await h.call("/positions/payoff", **json_body({"legs": PUT_SPREAD, "entry": 1.5}))
        assert resp.status_code == 200
        # one contract when the count is not given, as a holding is
        assert resp.json() == {
            "at_strikes": [{"spx": 7075, "pnl": -23.5}, {"spx": 7100, "pnl": 1.5}],
            "slope_below": 0,
            "slope_above": 0,
            "breakevens": [7098.5],
            "max_profit": 1.5,
            "max_loss": -23.5,
        }
        assert h.db.execute("select count(*) from positions").fetchone()[0] == before
        assert state["asked"] == []

    async def test_counts_draft_legs_across_the_contracts_given(self, start):
        h = start_with(start)
        resp = await h.call("/positions/payoff", **json_body({"legs": PUT_SPREAD, "entry": 1.5, "contracts": 3}))
        assert resp.json()["max_profit"] == 4.5

    @pytest.mark.parametrize("strike", [0, -7100])
    async def test_refuses_a_draft_leg_whose_strike_is_not_above_zero_in_zods_words(self, start, strike):
        h = start_with(start)
        legs = [{"side": "short", "option_type": "PUT", "strike": strike}]
        resp = await h.call("/positions/payoff", **json_body({"legs": legs, "entry": 1}))
        assert resp.status_code == 422
        assert resp.json()["detail"] == "✖ Too small: expected number to be >0\n  → at legs[0].strike"

    async def test_refuses_draft_legs_with_no_entry_or_none_at_all(self, start):
        h = start_with(start)
        assert (await h.call("/positions/payoff", **json_body({"legs": PUT_SPREAD}))).status_code == 422
        assert (await h.call("/positions/payoff", **json_body({"legs": [], "entry": 1}))).status_code == 422
        sold = [{"side": "sold", "option_type": "PUT", "strike": 7100}]
        assert (await h.call("/positions/payoff", **json_body({"legs": sold, "entry": 1}))).status_code == 422


class TestDeletingAHoldingFreesTheRulesItsContractsWereBlocking:
    """Reported from the live dashboard: adding an entry answered `409 position '1120_BS_7100' already
    exists`, on a rule whose row showed no positions at all beside a holding that had an entry and an
    opened date.

    The chain, as the live database recorded it. A condor held the two strikes, so the rule was linked
    to the condor with scope "leg". A put spread at those same strikes was added later and changed
    nothing, because only ORPHANS are considered. The condor was then deleted, and deleting a holding
    clears its links — so the rule lost the only one it had. Nothing recomputes a link outside a
    create, so it stayed orphaned, invisible to the holding that was now the unambiguous owner of its
    contracts. The dashboard then offered to create a holding whose name was already taken, and the 409
    was the server catching it.

    Re-adopting after a delete is safe by adopt_orphan_monitors's own design: it looks only at monitors
    with no link and only ever adds. "What you already have cannot be taken away by something you
    subsequently hold" — nor by something you subsequently drop.
    """

    @staticmethod
    async def holding_of(h, name, legs, entry):
        return await post(h, condor(name=name, legs=legs, entry=entry))

    @staticmethod
    async def spread_rule(h):
        resp = await h.call(
            "/monitors",
            **json_body(
                {
                    "name": "spread_rule",
                    "strike_date": EXPIRY,
                    "field": "mid_price",
                    "threshold": 1,
                    "direction": "above",
                    "legs": [
                        {"sign": -1, "option_type": "PUT", "strike": 7100},
                        {"sign": 1, "option_type": "PUT", "strike": 7075},
                    ],
                }
            ),
        )
        return resp.json()["id"]

    @staticmethod
    async def leg_rule(h):
        resp = await h.call(
            "/monitors",
            **json_body(
                {
                    "field": "option_delta",
                    "threshold": 0.2,
                    "strike_date": EXPIRY,
                    "option_type": "CALL",
                    "strike": 8050,
                    "direction": "above",
                }
            ),
        )
        return resp.json()["id"]

    @staticmethod
    async def whole_rule(h):
        resp = await h.call(
            "/monitors",
            **json_body(
                {
                    "name": "whole_rule",
                    "strike_date": EXPIRY,
                    "field": "mid_price",
                    "threshold": 1,
                    "direction": "above",
                    "legs": [
                        {
                            "sign": -1 if leg["side"] == "short" else 1,
                            "option_type": leg["option_type"],
                            "strike": leg["strike"],
                        }
                        for leg in CONDOR_LEGS
                    ],
                }
            ),
        )
        return resp.json()["id"]

    async def test_adopts_the_holding_left_behind_which_the_delete_had_orphaned_it_from(self, start):
        h = start_with(start)
        wide = created201(await self.holding_of(h, "wide", CONDOR_LEGS, 3.0))
        rid = await self.spread_rule(h)
        # the condor holds these strikes among others, so the rule watches part of it
        assert links(h, rid) == ([wide], "leg"), "linked to the wider holding"

        # the narrower holding arrives later and changes nothing: only orphans are considered
        narrow = created201(await self.holding_of(h, "narrow", PUT_SPREAD, 1.2))
        assert links(h, rid) == ([wide], "leg"), "still the wider one"

        # deleting the wider holding clears that link. Without re-adoption the rule is orphaned for
        # ever, beside a holding that now covers its contracts exactly.
        assert (await delete(h, wide)).status_code == 204
        assert links(h, rid) == ([narrow], "all")

    async def test_reports_the_holding_s_entry_afterwards_which_is_what_the_owner_could_not_see(self, start):
        h = start_with(start)
        wide = created201(await self.holding_of(h, "wide", CONDOR_LEGS, 3.0))
        rid = await self.spread_rule(h)
        created201(await self.holding_of(h, "narrow", PUT_SPREAD, 1.2))
        await delete(h, wide)

        rows = (await h.call("/quotes")).json()
        assert next(r for r in rows if r["id"] == rid)["entry"] == 1.2, "the entry the rule could not see"

    async def test_clears_the_scope_of_a_rule_left_holding_nothing_so_it_stops_claiming_one(self, start):
        # A rule's scope says HOW it covers its holding — "all" the whole thing, "leg" part of it.
        # Deleting the holding cleared the link and left the scope behind, so the live
        # US.SPXW261120C8200000 read scope "leg" while holding nothing at all. No figure derives from it
        # (every one guards on positions being non-empty), so this is truthfulness rather than a wrong
        # number — but a rule that says it watches part of something, beside an empty list of what, is
        # a thing a reader has to explain away.
        h = start_with(start)
        only = created201(await self.holding_of(h, "only", CONDOR_LEGS, 3.0))
        rid = await self.leg_rule(h)
        # one leg of the condor, so it covers part of it
        assert links(h, rid) == ([only], "leg")

        assert (await delete(h, only)).status_code == 204
        assert links(h, rid) == ([], None), "no holding, and no claim to one"

    async def test_leaves_the_scope_of_a_rule_that_still_has_a_holding(self, start):
        # only the link-less are cleared: a rule whose holding survives must keep saying how it covers
        # it, or the next sweep reads a whole-position rule as a leg rule
        h = start_with(start)
        keep = created201(await self.holding_of(h, "keep", CONDOR_LEGS, 3.0))
        rid = await self.leg_rule(h)
        other = created201(await self.holding_of(h, "other", FAR_PUT_SPREAD, 0.5))

        assert (await delete(h, other)).status_code == 204
        assert links(h, rid) == ([keep], "leg"), "untouched"

    async def test_keeps_the_scope_adoption_worked_out_rather_than_clearing_it_straight_after(self, start):
        # The clearing sits beside adoption in the same transaction, and this is what says the two do
        # not fight. Order-independent, which the first version of the comment beside the code denied:
        # clearing skips anything with a link and adoption always sets a scope on what it places, so
        # each only touches rows the other leaves alone. A mutation sweep swapped them and nothing
        # failed, which is how that was found.
        h = start_with(start)
        wide = created201(await self.holding_of(h, "wide", CONDOR_LEGS, 3.0))
        rid = await self.spread_rule(h)
        narrow = created201(await self.holding_of(h, "narrow", PUT_SPREAD, 1.2))

        await delete(h, wide)
        assert links(h, rid) == ([narrow], "all"), "adopted, and its new scope kept"

    async def test_leaves_a_rule_that_already_has_a_link_alone(self, start):
        # only orphans are considered, so a rule that has worked for weeks cannot lose its holding
        # because of something that happened to another one
        h = start_with(start)
        keep = created201(await self.holding_of(h, "keep", CONDOR_LEGS, 3.0))
        rid = await self.whole_rule(h)
        assert links(h, rid) == ([keep], "all")

        other = created201(await self.holding_of(h, "other", FAR_PUT_SPREAD, 0.5))
        assert (await delete(h, other)).status_code == 204
        assert links(h, rid) == ([keep], "all"), "untouched by an unrelated delete"

    async def test_adopts_nothing_when_the_delete_leaves_nothing_to_adopt(self, start):
        h = start_with(start)
        only = created201(await self.holding_of(h, "only", CONDOR_LEGS, 3.0))
        rid = await self.whole_rule(h)
        await delete(h, only)
        # and no scope either: it covered a holding that is gone
        assert links(h, rid) == ([], None), "nothing holds these contracts now"


class TestTheRoundTrip:
    async def test_creates_lists_and_deletes(self, start):
        h = start_with(start)
        created = await post(h, condor())
        assert created.status_code == 201
        data = created.json()
        assert len(data["id"]) == 32
        assert data["name"] == "1016_IC"
        assert data["strategy"] == "iron_condor"
        assert len(data["legs"]) == 4

        assert (await post(h, condor())).status_code == 409  # name taken

        assert [p["name"] for p in (await h.call("/positions")).json()] == ["1016_IC"]

        assert (await delete(h, data["id"])).status_code == 204
        assert (await h.call("/positions")).json() == []

    async def test_accepts_a_single_held_option_as_a_position(self, start):
        h = start_with(start)
        assert (await post(h, condor(name="one", legs=[CONDOR_LEGS[0]]))).status_code == 201

    async def test_refuses_a_position_with_no_legs_at_all(self, start):
        h = start_with(start)
        assert (await post(h, condor(name="none", legs=[]))).status_code == 422

    async def test_refuses_a_side_that_is_neither_long_nor_short_including_the_old_sold_bought(self, start):
        # ADR 0013 renamed Side. A caller still sending the old word gets a 422 naming the field, not a
        # holding whose legs every figure then reads as bought
        h = start_with(start)
        for side in ["sold", "bought", "buy"]:
            resp = await post(h, condor(legs=[{"side": side, "option_type": "CALL", "strike": 8050}]))
            assert resp.status_code == 422, side

    async def test_normalises_a_compact_date_and_refuses_an_impossible_one(self, start):
        h = start_with(start)
        created = await post(h, condor(name="compact", strike_date="20261218"))
        assert created.json()["strike_date"] == EXPIRY
        assert (await post(h, condor(name="bad", strike_date="2026-02-30"))).status_code == 422

    async def test_is_a_404_for_a_position_that_was_never_there(self, start):
        h = start_with(start)
        assert (await patch(h, "nope", {"entry": 1.0})).status_code == 404
        assert (await delete(h, "nope")).status_code == 404

    async def test_defaults_contracts_to_one_and_refuses_zero(self, start):
        h = start_with(start)
        created = (await post(h, {"name": "d", "strike_date": EXPIRY, "legs": [CONDOR_LEGS[0]]})).json()
        assert created["contracts"] == 1
        assert created["entry"] is None
        assert (await post(h, condor(name="z", contracts=0))).status_code == 422


class TestTheCreationGate:
    async def test_refuses_while_any_leg_does_not_exist_and_persists_nothing(self, start):
        # the same strict gate as monitors: nothing enters the table unverified
        async def fetch(codes):
            unknown = [c for c in codes if c.endswith("C8050000")]
            records = (await priced_fetcher([c for c in codes if c not in unknown])).records
            return Batch(records=records, unknown=unknown)

        h = start_with(start, fetch)
        resp = await post(h, condor())
        assert resp.status_code == 422
        assert "does not exist" in resp.json()["detail"]
        assert (await h.call("/positions")).json() == []

    async def test_refuses_when_the_probe_threw(self, start):
        async def fetch(codes):
            raise RuntimeError("Client connection failed!")

        h = start_with(start, fetch)
        resp = await post(h, condor())
        assert resp.status_code == 422
        # the Provider's own sentence, which is what says whether it could not be reached or answered
        # and declined the security (ADR 0018)
        assert (
            resp.json()["detail"]
            == "cannot verify contract: the Provider did not confirm it — Client connection failed!"
        )


class TestPositionsValues:
    async def test_reports_cost_to_close_p_l_the_contract_size_and_the_greeks(self, start):
        h = start_with(start)
        await post(h, condor(entry=3.0, contracts=2))
        values = (await h.call("/positions/values")).json()
        assert len(values) == 1
        v = values[0]
        assert v["cost_to_close"] == 4.5  # (5.0 + 3.0) sold back − (2.0 + 1.5) returned
        assert v["pnl"] == (3.0 - 4.5) * 2 * 100  # sold at 3.00, costs 4.50 to close
        assert v["contract_size"] == 100.0
        # exposure-signed, not cost-signed: two short legs against two long at 0.2 each
        assert v["greeks"]["option_delta"] == 0
        assert v["fetched_at"].endswith("+08:00")

    async def test_takes_the_contract_size_from_the_quotes_rather_than_assuming_100(self, start):
        # every other test prices at 100, so a route answering a constant 100 passed them all; only a
        # size no constant would guess tells the quotes' figure from an assumption
        async def fetch(codes):
            return [{**r, "option_contract_size": 10} for r in (await priced_fetcher(codes)).records]

        h = start_with(start, fetch)
        await post(h, condor(entry=3.0, contracts=2))
        v = (await h.call("/positions/values")).json()[0]
        assert v["contract_size"] == 10
        assert v["pnl"] == (3.0 - 4.5) * 2 * 10

    async def test_reports_no_contract_size_and_so_no_p_l_when_no_quote_carries_one(self, start):
        # the cost to close is points and needs no size; P&L is money and is never priced at a guess
        async def fetch(codes):
            records = (await priced_fetcher(codes)).records
            return [{k: x for k, x in r.items() if k != "option_contract_size"} for r in records]

        h = start_with(start, fetch)
        await post(h, condor(entry=3.0, contracts=2))
        v = (await h.call("/positions/values")).json()[0]
        assert v["cost_to_close"] == 4.5
        assert v["contract_size"] is None
        assert v["pnl"] is None

    async def test_reports_each_leg_s_own_delta_which_the_position_s_greeks_sum_away(self, start):
        # the short leg's delta is the risk this book is managed by; `greeks` is a signed sum over the
        # legs and is not it. Per leg, keyed by contract, from the same batch as the cost to close (#318)
        short: object = -0.31

        async def fetch(codes):
            records = (await priced_fetcher(codes)).records
            return [{**r, "option_delta": short} if r["code"].endswith("P7100000") else r for r in records]

        h = start_with(start, fetch)
        await post(h, condor())
        legs = (await h.call("/positions/values")).json()[0]["legs_delta"]
        assert sorted(legs) == sorted(build_spx_code(EXPIRY, l["option_type"], l["strike"]) for l in CONDOR_LEGS)
        assert legs[build_spx_code(EXPIRY, "PUT", 7100)] == -0.31
        assert legs[build_spx_code(EXPIRY, "CALL", 8050)] == 0.2
        # all or nothing, as the sample's map is: a map over three legs of four is not served
        short = None
        assert (await h.call("/positions/values")).json()[0]["legs_delta"] is None

    async def test_reports_spx_s_price_from_its_own_batch_and_why_not_where_there_are_none(self, start):
        # every leg's premium is set so that it inverts to 7000, whatever its side: the figure is the
        # index the holdings were valued against (ADR 0024), on each holding as the contract size is
        premiums = True

        def premium(code: str) -> float:
            c = parse_spx_code(code)
            assert c is not None
            if c.option_type == "CALL":
                return ((c.strike + 10) / 7000 - 1) * 100
            return (1 - (c.strike - 10) / 7000) * 100

        async def fetch(codes):
            records = (await priced_fetcher(codes)).records
            if not premiums:
                return records
            return [{**r, "last_price": 10, "option_premium": premium(r["code"])} for r in records]

        h = start_with(start, fetch)
        await post(h, condor())
        v = (await h.call("/positions/values")).json()[0]
        assert v["spx"] == 7000
        assert v["spx_reason"] is None
        premiums = False
        bare = (await h.call("/positions/values")).json()[0]
        assert bare["spx"] is None
        assert bare["spx_reason"] == "the Provider gives no option premium to derive it from"

    async def test_places_each_short_strike_against_that_spx_and_only_the_strikes_without_it(self, start):
        # #297: the strike strip's figures, on each holding, from the same batch
        premiums = True

        def premium(code: str) -> float:
            c = parse_spx_code(code)
            assert c is not None
            if c.option_type == "CALL":
                return ((c.strike + 10) / 7000 - 1) * 100
            return (1 - (c.strike - 10) / 7000) * 100

        async def fetch(codes):
            records = (await priced_fetcher(codes)).records
            figures = [
                {
                    **r,
                    "option_delta": 0.2 if r["code"][-8] == "C" else -0.25,
                    "option_implied_volatility": 20,
                }
                for r in records
            ]
            if not premiums:
                return figures
            return [{**r, "last_price": 10, "option_premium": premium(r["code"])} for r in figures]

        h = start_with(start, fetch)
        await post(h, condor())
        v = (await h.call("/positions/values")).json()[0]

        def sigma(points: float) -> float:
            return round(points / (7000 * 0.2 * math.sqrt(v["dte"] / 365)), 2)

        # one sigma of SPX to expiry from each short leg's own IV, the price map's band (#298)
        width = round(7000 * 0.2 * math.sqrt(v["dte"] / 365), 2)

        # the SHORT legs only, in the holding's own order: the call at 8050 and the put at 7100
        assert v["short_strikes"] == [
            {
                "code": build_spx_code(EXPIRY, "CALL", 8050),
                "option_type": "CALL",
                "strike": 8050,
                "delta": 0.2,
                "points": 1050,
                "sigma": sigma(1050),
                "one_sigma": width,
            },
            {
                "code": build_spx_code(EXPIRY, "PUT", 7100),
                "option_type": "PUT",
                "strike": 7100,
                "delta": -0.25,
                "points": -100,
                "sigma": sigma(-100),
                "one_sigma": width,
            },
        ]
        premiums = False
        bare = (await h.call("/positions/values")).json()[0]
        assert [[s["delta"], s["points"], s["sigma"], s["one_sigma"]] for s in bare["short_strikes"]] == [
            [0.2, None, None, None],
            [-0.25, None, None, None],
        ]

    async def test_reports_the_share_of_a_credit_captured_so_far_and_none_for_a_debit(self, start):
        # what the redesigned page shows beside the P&L (ADR 0023), decided here rather than divided out
        # in the browser (ADR 0005) — and named in the response model, which drops what it does not
        h = start_with(start)
        await post(h, condor(entry=9.0))
        await post(
            h,
            {
                "name": "1016_C8050",
                "strike_date": EXPIRY,
                "entry": -6.0,
                "legs": [{"side": "long", "option_type": "CALL", "strike": 8050}],
            },
        )
        values = (await h.call("/positions/values")).json()
        share = {v["name"]: v["captured"] for v in values}
        # sold for 9.00 and 4.50 to close: half of it kept
        assert share["1016_IC"] == 0.5
        # bought for 6.00: a debit has no credit to keep a share of, as it has no Target
        assert share["1016_C8050"] is None

    async def test_reports_nothing_rather_than_something_wrong_when_a_leg_goes_unpriced(self, start):
        # full quotes while creating, since the gate demands every leg exists; one dropped afterwards
        complete = True

        async def fetch(codes):
            records = (await priced_fetcher(codes)).records
            return records if complete else records[:-1]

        h = start_with(start, fetch)
        assert (await post(h, condor())).status_code == 201
        complete = False
        v = (await h.call("/positions/values")).json()[0]
        assert v["cost_to_close"] is None
        assert v["pnl"] is None
        assert v["captured"] is None

    async def test_is_an_empty_list_with_nothing_held_and_makes_no_call(self, start):
        calls = 0

        async def fetch(codes):
            nonlocal calls
            calls += 1
            return await priced_fetcher(codes)

        h = start_with(start, fetch)
        assert (await h.call("/positions/values")).json() == []
        assert calls == 0

    async def test_answers_502_rather_than_500_when_the_provider_call_fails_and_names_it(self, start):
        # one sentence for both market-data routes, from the Provider's own name: this read "OpenD call
        # failed" in two places whatever was actually answering (`errors.provider_failed`)
        first = True

        async def fetch(codes):
            nonlocal first
            if first:
                first = False
                return await priced_fetcher(codes)
            raise RuntimeError("quota exceeded")

        h = start_with(start, fetch)
        await post(h, condor())
        resp = await h.call("/positions/values")
        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert detail == "moomoo call failed: quota exceeded"
        assert "OpenD" not in detail


class TestRecordingACreditAfterTheFact:
    async def test_fills_in_an_entry_that_was_unknown_at_creation(self, start):
        h = start_with(start)
        id_ = (await post(h, condor(entry=None))).json()["id"]
        assert (await h.call("/positions/values")).json()[0]["pnl"] is None

        patched = await patch(h, id_, {"entry": 3.0})
        assert patched.status_code == 200
        assert patched.json()["entry"] == 3.0
        # cost to close is 4.5, so sold at 3.00 is down 1.50 a contract
        assert (await h.call("/positions/values")).json()[0]["pnl"] == -150.0

    async def test_refuses_an_empty_patch_rather_than_reporting_a_change_it_did_not_make(self, start):
        h = start_with(start)
        id_ = (await post(h, condor())).json()["id"]
        resp = await patch(h, id_, {})
        assert resp.status_code == 422
        assert resp.json()["detail"] == "nothing to update"

    async def test_never_edits_the_legs_a_different_structure_is_a_different_holding(self, start):
        h = start_with(start)
        id_ = (await post(h, condor())).json()["id"]
        patched = await patch(h, id_, {"legs": [CONDOR_LEGS[0]], "contracts": 3})
        assert patched.status_code == 200
        data = patched.json()
        assert len(data["legs"]) == 4
        assert data["contracts"] == 3


CALL_SPREAD = [
    {"side": "short", "option_type": "CALL", "strike": 8050},
    {"side": "long", "option_type": "CALL", "strike": 8075},
]
ROLLED_CALL_SPREAD = [
    {"side": "short", "option_type": "CALL", "strike": 8050},
    {"side": "long", "option_type": "CALL", "strike": 8100},
]
ELSEWHERE = [{"side": "short", "option_type": "CALL", "strike": 9000}]


def leg_rule_8050(h):
    return make_monitor(h, strike_date="2026-10-16", option_type="CALL", strike=8050)


class TestAMonitorFindingThePositionThatHoldsIt:
    async def test_links_a_leg_rule_to_the_position_holding_that_contract(self, start):
        # creating a monitor linked it to nothing, so everything the Position work built — entry, P&L,
        # the derived total — silently applied only to monitors predating the backfill migration
        h = start_with(start)
        pid = await make_position(h, "1016_bs_8050", "2026-10-16", CALL_SPREAD)
        mid = await leg_rule_8050(h)
        assert links(h, mid) == ([pid], "leg")

    async def test_calls_it_the_whole_position_when_the_rule_covers_it_exactly(self, start):
        h = start_with(start)
        pid = await make_position(h, "1016_bs_8050", "2026-10-16", CALL_SPREAD)
        mid = await make_monitor(
            h,
            name="1016_bs",
            strike_date="2026-10-16",
            field="mid_price",
            threshold=9,
            legs=[
                {"sign": 1, "option_type": "CALL", "strike": 8050},
                {"sign": -1, "option_type": "CALL", "strike": 8075},
            ],
        )
        assert links(h, mid) == ([pid], "all")

    async def test_spans_both_spreads_of_a_condor_which_is_not_ambiguity(self, start):
        # a combined stop over two credit spreads belongs to neither alone (ADR 0004)
        h = start_with(start)
        calls = await make_position(h, "calls", "2026-10-16", CALL_SPREAD)
        puts = await make_position(h, "puts", "2026-10-16", PUT_SPREAD)
        mid = await make_monitor(
            h,
            name="condor_stop",
            strike_date="2026-10-16",
            field="mid_price",
            threshold=9,
            legs=[
                {"sign": 1, "option_type": "CALL", "strike": 8050},
                {"sign": -1, "option_type": "CALL", "strike": 8075},
                {"sign": 1, "option_type": "PUT", "strike": 7100},
                {"sign": -1, "option_type": "PUT", "strike": 7075},
            ],
        )
        ids, scope = links(h, mid)
        assert sorted(ids) == sorted([calls, puts])
        assert scope == "all"

    async def test_links_nothing_for_a_strike_nothing_holds(self, start):
        # watching a strike you have no position in is legitimate; it has no entry and no P&L
        h = start_with(start)
        mid = await leg_rule_8050(h)
        assert links(h, mid) == ([], None)

    async def test_links_nothing_for_a_contract_two_positions_hold(self, start):
        h = start_with(start)
        await make_position(h, "old_roll", "2026-10-16", CALL_SPREAD)
        await make_position(h, "new_roll", "2026-10-16", ROLLED_CALL_SPREAD)
        mid = await leg_rule_8050(h)
        assert links(h, mid) == ([], None)


class TestAPositionAdoptingTheMonitorsAlreadyWatchingIt:
    async def test_works_in_the_order_monitor_then_position_not_only_position_then_monitor(self, start):
        # the link used to be worked out only when a monitor was created, so setting the alarm before
        # recording the holding left it orphaned for ever, with no entry and no P&L
        h = start_with(start)
        mid = await leg_rule_8050(h)
        assert links(h, mid) == ([], None)

        pid = await make_position(h, "1016_bs_8050", "2026-10-16", CALL_SPREAD)
        assert links(h, mid) == ([pid], "leg")

    async def test_never_takes_a_link_away(self, start):
        # why this is not "recompute the links every sweep". Rolling a spread leaves the old and the new
        # sharing a strike for a day; a recomputing job would call that contract ambiguous and silently
        # unlink a monitor that had worked for weeks — the entry and P&L vanishing mid-session with
        # nothing to explain it.
        h = start_with(start)
        first = await make_position(h, "old_roll", "2026-10-16", CALL_SPREAD)
        mid = await leg_rule_8050(h)
        assert links(h, mid) == ([first], "leg")

        await make_position(h, "new_roll", "2026-10-16", ROLLED_CALL_SPREAD)
        assert links(h, mid) == ([first], "leg")

    async def test_does_not_resolve_an_ambiguity_it_cannot_resolve(self, start):
        # an orphan created while two positions already share its strike stays an orphan, and a later
        # position does not talk adoption into guessing
        h = start_with(start)
        await make_position(h, "old_roll", "2026-10-16", CALL_SPREAD)
        await make_position(h, "new_roll", "2026-10-16", ROLLED_CALL_SPREAD)
        mid = await leg_rule_8050(h)
        assert links(h, mid) == ([], None)

        await make_position(h, "elsewhere", "2026-11-20", ELSEWHERE)
        assert links(h, mid) == ([], None)


class TestDeletingAHolding:
    async def test_takes_its_links_with_it_and_leaves_the_rules_alone(self, start):
        # the same foreign-key fault #70 fixed on the monitor side. Every Position in the live database
        # is linked, so deleting one was broken for all of them (#71).
        h = start_with(start)
        pid = await make_position(h, "1016_bs_8050", "2026-10-16", CALL_SPREAD)
        mid = await leg_rule_8050(h)
        assert links(h, mid) == ([pid], "leg")

        assert (await delete(h, pid)).status_code == 204
        # the rule survives: nothing here deletes one as a side effect. It simply stops knowing what it
        # was watching — links AND scope, since a scope says how it covers a holding it no longer has —
        # and would be adopted again if the holding came back.
        assert h.db.execute("select id from monitors where id = ?", (mid,)).fetchone()
        assert links(h, mid) == ([], None), "no links, and no scope claiming one"

    async def test_re_adopts_the_rule_if_the_holding_comes_back(self, start):
        h = start_with(start)
        pid = await make_position(h, "1016_bs_8050", "2026-10-16", CALL_SPREAD)
        mid = await leg_rule_8050(h)
        await delete(h, pid)
        assert links(h, mid)[0] == []

        again = await make_position(h, "1016_bs_8050", "2026-10-16", CALL_SPREAD)
        assert links(h, mid) == ([again], "leg")


class TestGapsTheSinglePositionTestsCannotShow:
    async def test_lists_by_expiry_then_by_name(self, start):
        h = start_with(start)
        await make_position(h, "zulu", "2026-10-16", [CONDOR_LEGS[0]])
        await make_position(h, "alpha", "2026-11-20", [CONDOR_LEGS[1]])
        await make_position(h, "mike", "2026-10-16", [CONDOR_LEGS[2]])
        assert [p["name"] for p in (await h.call("/positions")).json()] == ["mike", "zulu", "alpha"]

    async def test_asks_for_a_shared_contract_once_not_once_per_position_holding_it(self, start):
        # two positions can hold the same strike — a vertical and a condor wing, or a roll in progress.
        # Without deduping, the batch sends it twice and the whole point of one call per sweep is lost.
        asked = []

        async def fetch(codes):
            asked.append(codes)
            return await priced_fetcher(codes)

        h = start_with(start, fetch)
        await make_position(h, "a", EXPIRY, CALL_SPREAD)
        await make_position(h, "b", EXPIRY, ROLLED_CALL_SPREAD)
        asked.clear()
        await h.call("/positions/values")
        assert len(asked) == 1
        assert asked[0] == list(dict.fromkeys(asked[0]))
        assert len(asked[0]) == 3  # 8050 once, plus 8075 and 8100

    async def test_leaves_an_already_linked_monitor_alone_when_an_unrelated_holding_arrives(self, start):
        # adoption looks ONLY at monitors with no link. Were it to reconsider every monitor, this
        # position would make it re-derive a link it already has — and writing the same link twice is a
        # primary-key violation, so the unrelated creation would fail outright.
        h = start_with(start)
        pid = await make_position(h, "held", "2026-10-16", CALL_SPREAD)
        mid = await leg_rule_8050(h)
        assert links(h, mid) == ([pid], "leg")

        other = await post(h, {"name": "elsewhere", "strike_date": "2026-11-20", "legs": ELSEWHERE})
        assert other.status_code == 201
        assert links(h, mid) == ([pid], "leg")

    async def test_adoption_never_clears_a_scope_the_delete_does_and_nothing_else(self, start):
        # This asserted the opposite until 2026-10-15, and the reason it gave was narrower than the
        # behaviour it pinned: "adoption that cleared it would be taking something away, which is the
        # one thing it must never do". That constraint is on ADOPTION, and it still holds — the
        # clearing lives in clear_scope_of_orphans, called from the delete route after adoption has had
        # its turn. Keeping the scope after the holding went was what fell out, not what was chosen, and
        # it left the live US.SPXW261120C8200000 reading scope "leg" while holding nothing.
        #
        # Both halves are here: the delete clears, and a LATER unrelated holding appearing does not
        # touch the monitor at all, which is the original concern made explicit.
        h = start_with(start)
        pid = await make_position(h, "held", "2026-10-16", CALL_SPREAD)
        mid = await leg_rule_8050(h)
        await delete(h, pid)
        assert links(h, mid) == ([], None), "the delete clears it"

        await make_position(h, "elsewhere", "2026-11-20", ELSEWHERE)
        assert links(h, mid) == ([], None), "and adoption leaves it exactly as it was"

    async def test_adoption_leaves_a_scope_it_cannot_place_alone_rather_than_clearing_it(self, start):
        # the original concern, as its own test: a monitor whose holding is still there keeps its scope
        # when an unrelated holding is created, and POST /positions must never reach for it. Set up by
        # hand, because the only route that clears a scope is the delete.
        h = start_with(start)
        pid = await make_position(h, "held", "2026-10-16", CALL_SPREAD)
        mid = await leg_rule_8050(h)
        assert links(h, mid) == ([pid], "leg")

        await make_position(h, "elsewhere", "2026-11-20", ELSEWHERE)
        assert links(h, mid) == ([pid], "leg"), "untouched by someone else's holding"


#: Its own expiry, not the suite's: the harness clock is 2026-10-02, and a 45-DTE-at-open scenario
#: against the suite's December expiry would put the Opened in the FUTURE — which the guard correctly
#: reports as unknown, and which is how the first version of these passed every assertion except the
#: one that looked at the pace.
SCHED_EXPIRY = "2026-10-30"  # 28 DTE at the harness clock
OPENED = "2026-09-15"  # 45 DTE at open


class TestTheExitSchedule:
    """ADR 0011. The schedule is a REFERENCE: no alarm is raised from it, and `opened_at` is the opt-in
    because nothing is inferred from `created_at`, which is the day a Position was RECORDED rather than
    put on."""

    @staticmethod
    def spread(**over):
        return {
            "name": "1030_IC",
            "strategy": "iron_condor",
            "strike_date": SCHED_EXPIRY,
            "contracts": 1,
            "entry": 6.86,
            "legs": CONDOR_LEGS,
            **over,
        }

    @staticmethod
    async def values(h):
        return (await h.call("/positions/values")).json()

    async def test_is_null_for_a_position_whose_opened_nobody_declared(self, start):
        h = start_with(start)
        created201(await post(h, self.spread()))
        [p] = await self.values(h)
        assert p["opened_at"] is None
        assert p["schedule"] is None, "nothing is inferred from created_at"
        assert p["dte"] == 28, "the DTE is still reported, schedule or not"

    async def test_is_computed_once_an_opened_is_declared_on_creation(self, start):
        h = start_with(start)
        created201(await post(h, self.spread(opened_at=OPENED)))
        [p] = await self.values(h)
        s = p["schedule"]

        assert p["opened_at"] == OPENED
        assert s["dte_at_open"] == 45
        assert s["target"] == pytest.approx(3.43, abs=0.005)
        assert s["stop"] == pytest.approx(13.72, abs=0.005)
        # a 50% Target is not reached by decay ALONE until ~11 DTE, which is the headline finding:
        # hitting it at 21 came from an IV drop or a move, not from waiting
        assert s["target_dte"] == 11
        assert s["manage_by_dte"] == 21
        # 6.86 × √(28/45)
        assert s["on_pace"] == pytest.approx(6.86 * (28 / 45) ** 0.5, abs=5e-7)

    async def test_carries_whether_a_level_is_reached_which_the_schema_would_otherwise_strip(self, start):
        # The hazard is not the arithmetic — the library's cases have that — it is the reply's schema,
        # which DROPS keys it does not name, silently, so a field computed in the domain and never
        # listed there reaches the dashboard as undefined.
        h = start_with(start)
        created201(await post(h, self.spread(opened_at=OPENED)))
        [p] = await self.values(h)
        s = p["schedule"]

        # 28 DTE against a 21-DTE deadline, and no cost to close in this fixture
        assert s["reached"] is None, "nothing to compare, so nothing reached"
        assert s["manage_by_due"] is False, "28 DTE is a week outside the deadline"
        assert "reached" in s, "the key survives the schema"
        assert "manage_by_due" in s

    async def test_can_be_declared_after_the_fact_which_is_the_only_way_the_existing_five_get_one(self, start):
        h = start_with(start)
        id_ = created201(await post(h, self.spread()))
        assert (await self.values(h))[0]["schedule"] is None

        resp = await patch(h, id_, {"opened_at": OPENED})
        assert resp.status_code == 200
        assert (await self.values(h))[0]["schedule"]["dte_at_open"] == 45

    async def test_accepts_either_spelling_of_the_date_as_every_other_date_here_does(self, start):
        h = start_with(start)
        created201(await post(h, self.spread(opened_at="20260915")))
        assert (await self.values(h))[0]["opened_at"] == OPENED

    async def test_reports_the_gap_to_pace_against_the_live_cost_to_close(self, start):
        h = start_with(start)
        created201(await post(h, self.spread(opened_at=OPENED)))
        [p] = await self.values(h)
        s = p["schedule"]
        assert s["on_pace"] is not None
        # behind is positive: costing MORE than it should is the direction that hurts
        assert s["pace_gap"] == pytest.approx(p["cost_to_close"] - s["on_pace"], abs=5e-7)

    async def test_says_unknown_rather_than_a_number_when_the_opened_is_in_the_future(self, start):
        # a DTE further out than the Opened one means the Opened is wrong, and a wrong Opened must read
        # as unknown rather than as a pace above Entry
        h = start_with(start)
        created201(await post(h, self.spread(opened_at="2026-10-20")))
        s = (await self.values(h))[0]["schedule"]
        assert s["dte_at_open"] == 10
        assert s["on_pace"] is None, "28 DTE today against 10 at open is not arithmetic, it is bad data"
        assert s["pace_gap"] is None

    async def test_refuses_an_opened_that_is_not_a_date(self, start):
        h = start_with(start)
        resp = await post(h, self.spread(opened_at="last tuesday"))
        assert resp.status_code == 422


class TestDeletingAPositionThatHasBeenSampled:
    """The third time this foreign key has bitten. monitor_positions did it in #71, the sweep's expiry
    path did it in #81, and `position_samples` did it the moment ADR 0011 added a child table without
    touching the delete path — which made DELETE refuse for EVERY Position, since the first sweep after
    that deploy gave all five a sample.

    The samples go with the holding, unlike the Monitors: a Monitor survives and simply stops knowing
    what it watched, while a series of what-this-was-worth means nothing without it.
    """

    @staticmethod
    def sample(h, position_id, on):
        h.db.execute(
            """insert into position_samples (position_id, observed_on, dte, cost_to_close)
               values (?, ?, 30, 4.0)""",
            (position_id, on),
        )

    @staticmethod
    def count(h, table):
        return h.db.execute(f"select count(*) from {table}").fetchone()[0]

    async def test_deletes_it_and_its_samples_with_it(self, start):
        h = start_with(start)
        id_ = created201(await post(h, condor()))
        self.sample(h, id_, "2026-10-11")
        self.sample(h, id_, "2026-10-12")
        assert self.count(h, "position_samples") == 2

        resp = await delete(h, id_)
        assert resp.status_code == 204, resp.text
        assert self.count(h, "positions") == 0
        assert self.count(h, "position_samples") == 0

    async def test_leaves_another_position_s_samples_alone(self, start):
        h = start_with(start)
        keep = created201(await post(h, condor(name="keep")))
        drop = created201(await post(h, condor(name="drop")))
        self.sample(h, keep, "2026-10-12")
        self.sample(h, drop, "2026-10-12")

        assert (await delete(h, drop)).status_code == 204
        assert [r[0] for r in h.db.execute("select position_id from position_samples")] == [keep]

    async def test_still_deletes_one_that_has_no_samples_at_all(self, start):
        h = start_with(start)
        id_ = created201(await post(h, condor()))
        assert (await delete(h, id_)).status_code == 204


class TestClosingAHoldingKeepsIt:
    """ADR 0022. The harness's clock is 2026-10-02T05:26Z, which is still 2026-10-02 in New York."""

    @staticmethod
    async def close(h, id_, payload=None):
        return await h.call(f"/positions/{id_}/close", **json_body({} if payload is None else payload))

    @staticmethod
    def monitor_row(h, id_):
        row = h.db.execute("select enabled, disabled_reason from monitors where id = ?", (id_,)).fetchone()
        return None if row is None else {"enabled": row[0], "disabled_reason": row[1]}

    @staticmethod
    def add_sample(h, position_id, observed_on):
        h.db.execute(
            "insert into position_samples (position_id, observed_on, dte, cost_to_close) values (?, ?, 30, 2.5)",
            (position_id, observed_on),
        )

    @staticmethod
    def sample_count(h, position_id):
        return h.db.execute("select count(*) from position_samples where position_id = ?", (position_id,)).fetchone()[0]

    async def test_records_the_day_and_the_exit_and_keeps_the_legs_the_entry_and_the_samples(self, start):
        h = start_with(start)
        pid = created201(await post(h, condor(contracts=2)))
        self.add_sample(h, pid, "2026-10-01")

        resp = await self.close(h, pid, {"exit": 0.4})
        data = resp.json()
        assert resp.status_code == 200, json.dumps(data)
        assert {k: data[k] for k in ("id", "closed_on", "exit", "entry", "legs", "realized_points")} == {
            "id": pid,
            "closed_on": "2026-10-02",
            "exit": 0.4,
            "entry": 3.0,
            "legs": CONDOR_LEGS,
            # Entry less Exit across the contracts held, in points: P&L is money and needs a quote
            "realized_points": 5.2,
        }
        assert data["disabled_monitors"] == []
        assert self.sample_count(h, pid) == 1, "the history survives the close"

    async def test_closes_without_an_exit_and_then_says_nothing_about_what_it_made(self, start):
        h = start_with(start)
        pid = created201(await post(h, condor()))
        data = (await self.close(h, pid)).json()
        assert (data["closed_on"], data["exit"], data["realized_points"]) == ("2026-10-02", None, None)

    async def test_takes_the_day_it_was_closed_when_it_is_given_the_way_opened_is(self, start):
        h = start_with(start)
        pid = created201(await post(h, condor(opened_at="2026-09-01")))
        data = (await self.close(h, pid, {"exit": 0.4, "closed_on": "20260930"})).json()
        assert data["closed_on"] == "2026-09-30"

    async def test_defaults_to_the_expiry_for_a_holding_closed_after_it_since_nothing_is_held_past_one(self, start):
        # an iron condor that expired worthless on 09-25 and was only told to the app today
        h = start_with(start)
        pid = created201(await post(h, condor(strike_date="2026-09-25")))
        data = (await self.close(h, pid, {"exit": 0})).json()
        assert (data["closed_on"], data["exit"], data["realized_points"]) == ("2026-09-25", 0, 3)

    async def test_refuses_a_day_before_it_was_opened_and_a_day_after_its_expiry(self, start):
        h = start_with(start)
        pid = created201(await post(h, condor(opened_at="2026-09-01")))
        early = await self.close(h, pid, {"closed_on": "2026-08-31"})
        assert early.status_code == 422
        assert "before it was opened" in early.json()["detail"]
        late = await self.close(h, pid, {"closed_on": "2026-12-19"})
        assert late.status_code == 422
        assert "after its expiry" in late.json()["detail"]
        assert (await h.call("/positions")).json()[0]["closed_on"] is None, "and nothing was written"

    async def test_refuses_an_impossible_date_and_an_exit_that_is_not_a_number(self, start):
        h = start_with(start)
        pid = created201(await post(h, condor()))
        assert (await self.close(h, pid, {"closed_on": "2026-13-01"})).status_code == 422
        assert (await self.close(h, pid, {"exit": "0.40"})).status_code == 422

    async def test_is_409_for_a_holding_already_closed_and_keeps_what_the_first_close_said(self, start):
        h = start_with(start)
        pid = created201(await post(h, condor()))
        await self.close(h, pid, {"exit": 0.4})
        again = await self.close(h, pid, {"exit": 9})
        assert again.status_code == 409
        assert again.json()["detail"] == "position '1016_IC' is already closed"
        assert (await h.call("/positions")).json()[0]["exit"] == 0.4

    async def test_is_a_404_for_a_holding_that_was_never_there(self, start):
        h = start_with(start)
        assert (await self.close(h, "nope", {"exit": 0.4})).status_code == 404

    async def test_disables_the_rules_watching_it_says_which_and_keeps_them(self, start):
        h = start_with(start)
        pid = created201(await post(h, condor()))
        leg = await make_monitor(h, strike_date=EXPIRY, option_type="CALL", strike=8050)
        data = (await self.close(h, pid, {"exit": 0.4})).json()
        assert data["disabled_monitors"] == [{"id": leg, "code": build_spx_code(EXPIRY, "CALL", 8050)}]
        assert self.monitor_row(h, leg) == {"enabled": 0, "disabled_reason": "holding-closed"}
        # ...and it stops claiming the holding, so nothing alive is ever valued against a closed one
        assert links(h, leg) == ([], None)

    async def test_leaves_a_rule_already_off_as_the_owner_left_it_and_does_not_claim_to_have_disabled_it(self, start):
        h = start_with(start)
        pid = created201(await post(h, condor()))
        leg = await make_monitor(h, strike_date=EXPIRY, option_type="CALL", strike=8050)
        await h.call(f"/monitors/{leg}", **{**json_body({"enabled": False}), "method": "PATCH"})
        data = (await self.close(h, pid, {"exit": 0.4})).json()
        assert data["disabled_monitors"] == []
        assert self.monitor_row(h, leg) == {"enabled": 0, "disabled_reason": "manual"}

    async def test_disables_a_rule_spanning_two_holdings_when_either_closes_since_it_would_value_legs_no_longer_held(
        self, start
    ):
        h = start_with(start)
        calls = await make_position(h, "1016_bs_8050", EXPIRY, CONDOR_LEGS[:2])
        puts = await make_position(h, "1016_bp_7100", EXPIRY, CONDOR_LEGS[2:])
        both = created201(
            await h.call(
                "/monitors",
                **json_body(
                    {
                        "name": "1016_IC",
                        "strike_date": EXPIRY,
                        "field": "option_delta",
                        "threshold": 0.2,
                        "direction": "above",
                        "legs": [
                            {"sign": -1, "option_type": "CALL", "strike": 8050},
                            {"sign": -1, "option_type": "PUT", "strike": 7100},
                        ],
                    }
                ),
            )
        )
        assert links(h, both)[0] == sorted([calls, puts])

        await self.close(h, puts, {"exit": 0.1})
        assert self.monitor_row(h, both) == {"enabled": 0, "disabled_reason": "holding-closed"}
        # the link to the holding still held is kept, as deleting the other spread would keep it
        assert links(h, both)[0] == [calls]

    async def test_is_listed_with_what_it_made_and_left_out_of_everything_live(self, start):
        calls = 0

        async def fetch(codes):
            nonlocal calls
            calls += 1
            return await priced_fetcher(codes)

        h = start_with(start, fetch)
        pid = created201(await post(h, condor()))
        await self.close(h, pid, {"exit": 0.4})

        [listed] = (await h.call("/positions")).json()
        assert (listed["id"], listed["closed_on"], listed["exit"], listed["realized_points"]) == (
            pid,
            "2026-10-02",
            0.4,
            2.6,
        )
        calls = 0
        assert (await h.call("/positions/values")).json() == [], "nothing open is valued"
        assert calls == 0, "and the Provider is asked nothing"

    async def test_never_adopts_a_new_rule_onto_a_closed_holding(self, start):
        h = start_with(start)
        pid = created201(await post(h, condor()))
        await self.close(h, pid, {"exit": 0.4})
        leg = await make_monitor(h, strike_date=EXPIRY, option_type="CALL", strike=8050)
        assert links(h, leg) == ([], None)

    async def test_lets_the_same_contracts_be_held_again_and_the_new_holding_adopts_the_rules(self, start):
        h = start_with(start)
        first = created201(await post(h, condor()))
        await self.close(h, first, {"exit": 0.4})
        leg = await make_monitor(h, strike_date=EXPIRY, option_type="CALL", strike=8050)
        again = created201(await post(h, condor(name="1016_IC_again")))
        assert links(h, leg) == ([again], "leg")

    async def test_can_still_be_deleted_for_a_holding_recorded_by_mistake_and_its_samples_go_with_it(self, start):
        h = start_with(start)
        pid = created201(await post(h, condor()))
        self.add_sample(h, pid, "2026-10-01")
        await self.close(h, pid, {"exit": 0.4})
        assert (await delete(h, pid)).status_code == 204
        assert self.sample_count(h, pid) == 0

    async def test_hands_a_rule_to_the_holding_that_still_holds_its_contract_and_leaves_it_on_a_roll(self, start):
        # Found in review: the close disabled the rule, unlinked it, and adoption then linked it to the
        # rolled holding — leaving the new trade's alarm OFF, as "holding-closed", with no notice. A rule
        # is switched off only when something it names is no longer held by anything open.
        h = start_with(start)
        old = created201(await post(h, condor()))
        leg = await make_monitor(h, strike_date=EXPIRY, option_type="CALL", strike=8050)
        # the roll: a new call spread sharing the short strike, recorded before the old one is closed
        rolled = await make_position(
            h,
            "1016_bs_8050_rolled",
            EXPIRY,
            [
                {"side": "short", "option_type": "CALL", "strike": 8050},
                {"side": "long", "option_type": "CALL", "strike": 8100},
            ],
        )
        assert links(h, leg)[0] == [old], "linked to the old holding until it closes"

        data = (await self.close(h, old, {"exit": 0.4})).json()
        assert data["disabled_monitors"] == []
        assert self.monitor_row(h, leg) == {"enabled": 1, "disabled_reason": None}
        assert links(h, leg) == ([rolled], "leg")

    async def test_closes_on_the_new_york_market_day_not_the_utc_one(self, start):
        # 02:00 UTC on the 10th is 21:00 on the 9th in New York: every clock the suite used fell on the
        # same date in both, which is how a UTC date passed for a market one
        h = start_with(start)
        h.now = datetime(2026, 11, 10, 2, 0, tzinfo=UTC)
        pid = created201(await post(h, condor()))
        assert (await self.close(h, pid, {"exit": 0.4})).json()["closed_on"] == "2026-11-09"

    async def test_refuses_a_day_that_has_not_come_yet_in_new_york(self, start):
        h = start_with(start)
        h.now = datetime(2026, 11, 10, 2, 0, tzinfo=UTC)
        pid = created201(await post(h, condor()))
        early = await self.close(h, pid, {"closed_on": "2026-11-10"})
        assert early.status_code == 422
        assert "after today" in early.json()["detail"]

    async def test_reads_no_sample_after_the_day_it_closed_and_deletes_none_when_the_close_is_backdated(self, start):
        # the sweep sampled it on the 2nd and 3rd, then the owner recorded that it closed on the 2nd: what
        # it was worth after it was sold is not its history, but nothing is thrown away either
        h = start_with(start)
        pid = created201(await post(h, condor(opened_at="2026-09-01")))
        ivs = lambda v: json.dumps({c: v for c in leg_codes()})
        for on, dte, iv in (("2026-09-01", 45, 10), ("2026-09-02", 44, 11), ("2026-09-03", 43, 15)):
            h.db.execute(
                """insert into position_samples (position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega)
                   values (?, ?, ?, 3.0, ?, ?)""",
                (pid, on, dte, ivs(iv), ivs(4)),
            )
        await self.close(h, pid, {"exit": 0.4, "closed_on": "2026-09-02"})
        vol = (await h.call(f"/positions/{pid}/vol")).json()
        assert vol["to"] == "2026-09-02", "measured to the close, not past it"
        assert self.sample_count(h, pid) == 3, "and every sample is still stored"

    async def test_corrects_the_exit_and_the_day_after_the_close_which_a_mistyped_close_needs(self, start):
        h = start_with(start)
        pid = created201(await post(h, condor(opened_at="2026-09-01")))
        self.add_sample(h, pid, "2026-09-02")
        await self.close(h, pid, {"exit": 0.4})
        resp = await patch(h, pid, {"exit": 0.45, "closed_on": "2026-09-30"})
        assert resp.status_code == 200
        data = resp.json()
        assert (data["exit"], data["closed_on"], data["realized_points"]) == (0.45, "2026-09-30", 2.55)
        assert self.sample_count(h, pid) == 1, "without losing the history a delete would"

    async def test_clears_an_exit_back_to_blank_as_a_close_may_leave_it_and_says_nothing_about_what_it_made(
        self, start
    ):
        h = start_with(start)
        pid = created201(await post(h, condor()))
        await self.close(h, pid, {"exit": 0.4})
        resp = await patch(h, pid, {"exit": None})
        assert resp.status_code == 200
        data = resp.json()
        assert (data["exit"], data["realized_points"], data["closed_on"]) == (None, None, "2026-10-02")

    async def test_refuses_an_exit_or_a_close_day_on_a_holding_still_held(self, start):
        h = start_with(start)
        pid = created201(await post(h, condor()))
        resp = await patch(h, pid, {"exit": 0.4})
        assert resp.status_code == 422
        assert resp.json()["detail"] == "position '1016_IC' is not closed: close it first"
        assert (await patch(h, pid, {"closed_on": "2026-10-01"})).status_code == 422

    async def test_holds_a_corrected_day_to_the_same_three_bounds_as_the_close(self, start):
        h = start_with(start)
        pid = created201(await post(h, condor(opened_at="2026-09-01")))
        await self.close(h, pid, {"exit": 0.4})
        assert "before it was opened" in (await patch(h, pid, {"closed_on": "2026-08-31"})).json()["detail"]
        assert "after today" in (await patch(h, pid, {"closed_on": "2026-10-03"})).json()["detail"]
        assert (await h.call("/positions")).json()[0]["closed_on"] == "2026-10-02", "and nothing was written"


def insert_holding(h, name, strike_date, legs, **over):
    """A holding stored as POST /positions stores one, with what the route would refuse to write."""
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
        "closed_on": None,
        "exit": None,
        **over,
    }
    insert_position(h.db, row)
    return row["id"]


class TestWhatOnlyThePythonCanGetWrong:
    async def test_answers_the_stored_holding_in_the_shape_the_dashboard_reads(self, start):
        # created_at converts to DISPLAY_TZ; opened_at is a calendar day and does not; the manage-by
        # stamp is the sweep's bookkeeping and is not served
        h = start()
        insert_holding(
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
                # still held: no close, no exit, and nothing realized yet (ADR 0022)
                "closed_on": None,
                "exit": None,
                "realized_points": None,
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
        insert_holding(h, "bad", "2026-12-18", legs)
        resp = await h.call("/positions")
        assert (resp.status_code, resp.json()) == (500, {"detail": "internal error"}), why

    async def test_refuses_a_number_that_is_not_finite_rather_than_writing_infinity(self, start):
        # SQLite's REAL holds an infinity, which zod refuses and json.dumps would write as `Infinity`
        h = start()
        insert_holding(h, "inf", "2026-12-18", CONDOR_LEGS, entry=float("inf"))
        resp = await h.call("/positions")
        assert (resp.status_code, resp.json()) == (500, {"detail": "internal error"})

    async def test_drops_a_key_a_stored_leg_carries_that_the_schema_does_not_name(self, start):
        # zod's object strips unknown keys, and so does the model
        h = start()
        insert_holding(h, "extra", "2026-12-18", [{**CONDOR_LEGS[0], "note": "rolled"}])
        assert (await h.call("/positions")).json()[0]["legs"] == [CONDOR_LEGS[0]]

    async def test_reads_stored_legs_as_json_parse_does_refusing_nan(self, start):
        # Python's json reads the bare token NaN, which is not JSON; JSON.parse refuses the whole row.
        # In a key the schema strips, so the model cannot be what refuses it
        h = start()
        insert_holding(h, "nan", "2026-12-18", [])
        legs = '[{"side":"short","option_type":"CALL","strike":8050,"note":NaN}]'
        h.db.execute("update positions set legs = ? where name = 'nan'", (legs,))
        resp = await h.call("/positions")
        assert (resp.status_code, resp.json()) == (500, {"detail": "internal error"})

    async def test_stores_the_legs_as_json_stringify_writes_them(self, start):
        # both backends write one file, and a strike Python wrote as 8050.0 would be a second spelling
        # of the same leg (db/values.py)
        h = start_with(start)
        id_ = created201(await post(h, condor(legs=[{**CONDOR_LEGS[0], "note": "rolled"}, CONDOR_LEGS[1]])))
        stored = h.db.execute("select legs from positions where id = ?", (id_,)).fetchone()[0]
        assert stored == (
            '[{"side":"short","option_type":"CALL","strike":8050},{"side":"long","option_type":"CALL","strike":8075}]'
        )

    @pytest.mark.parametrize("field", ["entry", "contracts", "strategy", "opened_at"])
    async def test_a_patch_refuses_a_null_rather_than_reading_it_as_not_sent(self, start, field):
        # zod's `.optional()` refuses an explicit null, so None in the route can only mean "not sent";
        # a null that slipped through would answer "nothing to update", or change nothing and say 200
        h = start_with(start)
        id_ = created201(await post(h, condor()))
        resp = await patch(h, id_, {field: None})
        assert resp.status_code == 422
        assert resp.json()["detail"] != "nothing to update"

    async def test_a_sample_map_that_is_not_an_object_costs_the_figure_never_the_request(self, start):
        # the shape check is the route's own: the library's sample takes a map or None, and an array
        # handed to it would be refused there — a 500 — where the TypeScript's route answers null
        h = start_with(start)
        id_ = created201(await post(h, condor(opened_at="2026-10-06")))
        TestWhatVolDidToAHoldingOverItsOwnSamples.sample(h, id_, "2026-10-06", 45, [1, 2], flat(4))
        resp = await h.call(f"/positions/{id_}/vol")
        assert (resp.status_code, resp.json()["vol"]) == (200, None)

    async def test_serves_the_vol_figure_under_from_which_python_cannot_name_a_field(self, start):
        h = start_with(start)
        id_ = created201(await post(h, condor(opened_at="2026-10-06")))
        resp = await h.call(f"/positions/{id_}/vol")
        assert list(resp.json()) == [
            "vol",
            "from",
            "to",
            "days",
            "reason",
            "at",
            "timing",
            "gap",
            "gap_reason",
            "rest",
            "vega",
            "cover",
            "cover_reason",
        ]

    async def test_answers_a_method_no_route_serves_on_these_paths_as_hono_does(self, start):
        # `/{id}` is routed for PATCH and DELETE only, and `/values` for GET only: Starlette would
        # answer the rest with a 405, where Hono answers its plain-text 404
        h = start_with(start)
        for method, path in (("GET", "/positions/x"), ("POST", "/positions/values"), ("PUT", "/positions/x")):
            resp = await h.call(path, method=method)
            assert (resp.status_code, resp.text) == (404, "404 Not Found"), (method, path)


#: a 1×2 put ratio: one leg per contract, the short one held twice over (#351)
RATIO = [
    {"side": "long", "option_type": "PUT", "strike": 7100},
    {"side": "short", "option_type": "PUT", "strike": 7075, "qty": 2},
]


class TestAQuantityPerLeg:
    """#351: one leg per contract, with a quantity, recorded as given and drawn with it."""

    async def test_records_a_legs_quantity_and_a_quantity_of_one_as_none(self, start):
        h = start_with(start)
        created201(await post(h, condor(name="ratio", legs=RATIO)))
        created201(await post(h, condor(name="ones", legs=[{**leg, "qty": 1} for leg in RATIO])))

        def stored(name):
            return json.loads(h.db.execute("select legs from positions where name = ?", (name,)).fetchone()[0])

        assert stored("ratio") == RATIO
        assert stored("ones") == [{k: v for k, v in leg.items() if k != "qty"} for leg in RATIO]

    async def test_draws_a_holdings_payoff_with_its_quantities(self, start):
        h = start_with(start)
        id_ = created201(await post(h, condor(name="ratio", legs=RATIO, entry=0.5, contracts=1)))
        payoff = (await h.call(f"/positions/{id_}/payoff")).json()
        # below the short strike two puts are owed against one held
        assert payoff["slope_below"] == 1
        assert payoff["at_strikes"] == [{"spx": 7075, "pnl": 25.5}, {"spx": 7100, "pnl": 0.5}]
