"""`/positions`. Port of backend/src/entrypoints/http/routes/positions.test.ts.

Every test comes across, each creating what it needs through the routes as the TypeScript's do. What
only the Python can get wrong is at the end: the TypeScript parses every answer through its zod schema,
which REFUSES what does not fit, where pydantic left to its defaults coerces it; zod's `.optional()`
refuses a null a PATCH might send; and the legs a holding stores are written as JSON.stringify writes
them, because both backends write one file.
"""

import json

import pytest
from harness import json_body, priced_fetcher
from optionality.contract import build_spx_code
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
        assert resp.json() == {"vol": 4, "from": "2026-10-06", "to": "2026-10-07", "days": 1}

    async def test_says_so_plainly_when_there_is_no_baseline_rather_than_guessing_one(self, start):
        # the live condor's case, and the shape every Position declared after the fact is in
        h = start_with(start)
        id_ = created201(await post(h, condor(opened_at="2026-10-06")))
        self.sample(h, id_, "2026-10-12", 39, flat(10), flat(4))
        self.sample(h, id_, "2026-10-13", 38, flat(11), flat(4))

        resp = await h.call(f"/positions/{id_}/vol")
        assert resp.status_code == 200
        assert resp.json() == {"vol": None, "from": None, "to": None, "days": None}

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


PUT_SPREAD = [
    {"side": "short", "option_type": "PUT", "strike": 7100},
    {"side": "long", "option_type": "PUT", "strike": 7075},
]
FAR_PUT_SPREAD = [
    {"side": "short", "option_type": "PUT", "strike": 6000},
    {"side": "long", "option_type": "PUT", "strike": 5950},
]


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
        assert list(resp.json()) == ["vol", "from", "to", "days"]

    async def test_answers_a_method_no_route_serves_on_these_paths_as_hono_does(self, start):
        # `/{id}` is routed for PATCH and DELETE only, and `/values` for GET only: Starlette would
        # answer the rest with a 405, where Hono answers its plain-text 404
        h = start_with(start)
        for method, path in (("GET", "/positions/x"), ("POST", "/positions/values"), ("PUT", "/positions/x")):
            resp = await h.call(path, method=method)
            assert (resp.status_code, resp.text) == (404, "404 Not Found"), (method, path)
