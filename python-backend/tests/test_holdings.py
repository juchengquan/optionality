"""What a holding is worth and where it stands, computed once for everything that asks.

backend/src/holdings.ts has no test of its own: its two callers' suites rely on it —
`routes/positions.test.ts`'s `/positions/values` and "the exit schedule" (ported beside this, in
`tests/entrypoints/http/routes/test_positions.py`), and the bot's `/holdings` tests in `bot.test.ts`
(ported beside the bot, in `tests/entrypoints/bot/test_bot.py`). What those rely on is held here, on
the module itself: one batch, asked for each contract once and never when nothing is held; the figures
per holding in the listing's order; a schedule only where an Opened was declared, read with the exit
policy in Settings; and a batch that fails raising to the caller, which decides whether that is a 502
or a sentence.
"""

import json
import math

import pytest
from harness import NOW, fake_fetcher, priced_fetcher

from optionality_backend.db.open import create_database
from optionality_backend.db.queries import insert_position
from optionality_backend.env import settings_for
from optionality_backend.holdings import holding_values

TZ = "Asia/Singapore"
#: 28 DTE at the harness's clock, 2026-10-02
EXPIRY = "2026-10-30"
CONDOR = [
    {"side": "short", "option_type": "CALL", "strike": 8050},
    {"side": "long", "option_type": "CALL", "strike": 8075},
    {"side": "short", "option_type": "PUT", "strike": 7100},
    {"side": "long", "option_type": "PUT", "strike": 7075},
]


@pytest.fixture
def db(tmp_path):
    d = create_database(tmp_path / "test.db")
    yield d
    d.close()


def hold(db, name, legs=CONDOR, **over):
    """A holding as POST /positions stores one."""
    insert_position(
        db,
        {
            "id": name.ljust(32, "0"),
            "name": name,
            "strategy": None,
            "strike_date": EXPIRY,
            "contracts": 1,
            "entry": 6.86,
            "legs": json.dumps(legs, separators=(",", ":")),
            "created_at": "2026-10-01 00:00:00.000000",
            "opened_at": None,
            "manage_notified_at": None,
            "closed_on": None,
            "exit": None,
            "qty_corrected_at": None,
            **over,
        },
    )


def counting(asked):
    async def fetch(codes):
        asked.append(codes)
        return await priced_fetcher(codes)

    return fake_fetcher(fetch)


class TestOneBatch:
    async def test_asks_for_nothing_and_answers_nothing_with_nothing_held(self, db):
        asked = []
        valued = await holding_values(db, counting(asked), NOW, settings_for(), TZ)
        assert (valued.by_code, valued.values, asked) == ({}, [], [])

    async def test_asks_once_for_every_contract_held_each_once_and_in_order(self, db):
        # two holdings sharing a strike — a roll in progress — are one code in the batch, not two
        hold(db, "a", CONDOR[:2])
        hold(db, "b", [CONDOR[0], {"side": "long", "option_type": "CALL", "strike": 8100}])
        asked = []
        await holding_values(db, counting(asked), NOW, settings_for(), TZ)
        assert asked == [["US.SPXW261030C8050000", "US.SPXW261030C8075000", "US.SPXW261030C8100000"]]

    async def test_raises_what_the_batch_raised_and_leaves_the_wording_to_the_caller(self, db):
        hold(db, "a")

        async def down(codes):
            raise ConnectionRefusedError("connect ECONNREFUSED 127.0.0.1:33333")

        with pytest.raises(ConnectionRefusedError, match="ECONNREFUSED"):
            await holding_values(db, fake_fetcher(down), NOW, settings_for(), TZ)

    async def test_answers_the_batch_by_code_stamped_in_the_display_zone(self, db):
        # the route reads the contract size and the greeks from it, so it is the displayed records
        hold(db, "a", CONDOR[:1])
        valued = await holding_values(db, fake_fetcher(priced_fetcher), NOW, settings_for(), TZ)
        assert list(valued.by_code) == ["US.SPXW261030C8050000"]
        assert valued.by_code["US.SPXW261030C8050000"]["mid_price"] == 5.0
        assert valued.by_code["US.SPXW261030C8050000"]["fetched_at"] == "2026-10-02 13:26:06+08:00"


class TestEachHolding:
    async def test_values_each_in_the_order_they_are_listed(self, db):
        hold(db, "zulu", CONDOR, entry=3.0, contracts=2)
        hold(db, "alpha", CONDOR[:1], strike_date="2026-11-20")
        valued = await holding_values(db, fake_fetcher(priced_fetcher), NOW, settings_for(), TZ)
        assert [v.row["name"] for v in valued.values] == ["zulu", "alpha"]
        zulu = valued.values[0]
        assert zulu.position.name == "zulu"
        # (5.0 + 3.0) sold back − (2.0 + 1.5) returned
        assert zulu.cost == 4.5
        assert zulu.pnl == (3.0 - 4.5) * 2 * 100
        assert [v.dte for v in valued.values] == [28, 49]

    async def test_values_nothing_rather_than_something_wrong_where_a_leg_is_unpriced(self, db):
        hold(db, "a")

        async def short_one(codes):
            return (await priced_fetcher(codes)).records[:-1]

        [v] = (await holding_values(db, fake_fetcher(short_one), NOW, settings_for(), TZ)).values
        assert (v.cost, v.pnl, v.captured) == (None, None, None)

    async def test_captures_a_share_of_a_credit_from_the_same_cost_and_none_of_a_debit(self, db):
        # the route serves it beside the cost it was divided from, so it must be THAT cost (ADR 0023)
        hold(db, "credit", CONDOR, entry=9.0)
        hold(db, "debit", CONDOR[:1], entry=-6.0)
        credit, debit = (await holding_values(db, fake_fetcher(priced_fetcher), NOW, settings_for(), TZ)).values
        assert (credit.cost, credit.captured) == (4.5, 0.5)
        assert debit.captured is None


class TestTheSchedule:
    async def test_is_none_for_a_holding_whose_opened_nobody_declared(self, db):
        hold(db, "a")
        [v] = (await holding_values(db, fake_fetcher(priced_fetcher), NOW, settings_for(), TZ)).values
        assert v.schedule is None
        assert v.dte == 28, "the DTE is still reported, schedule or not"

    async def test_is_placed_by_the_day_it_was_opened_against_the_live_cost_to_close(self, db):
        hold(db, "a", opened_at="2026-09-15")
        [v] = (await holding_values(db, fake_fetcher(priced_fetcher), NOW, settings_for(), TZ)).values
        on_pace = 6.86 * math.sqrt(28 / 45)
        assert v.schedule == {
            "dte_at_open": 45,
            "on_pace": on_pace,
            "pace_gap": 4.5 - on_pace,
            "target": 6.86 * 0.5,
            "stop": 6.86 * 2.0,
            "target_dte": 11,
            "manage_by_dte": 21,
            "reached": None,
            "manage_by_due": False,
        }

    async def test_reads_the_exit_policy_from_settings(self, db):
        # the three knobs from `.env`, not the defaults: a reader that ignored them would pass the test
        # above and put the wrong Target on the dashboard the day the owner moved one
        hold(db, "a", opened_at="2026-09-15")
        settings = settings_for(exit_take_fraction=0.25, exit_stop_multiple=3.0, exit_manage_by_dte=30)
        [v] = (await holding_values(db, fake_fetcher(priced_fetcher), NOW, settings, TZ)).values
        assert v.schedule is not None
        assert (v.schedule["target"], v.schedule["stop"]) == (6.86 * 0.75, 6.86 * 3.0)
        assert (v.schedule["manage_by_dte"], v.schedule["manage_by_due"]) == (30, True)
