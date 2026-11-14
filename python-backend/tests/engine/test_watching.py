"""What a sweep records of the WATCHLIST: the daily close of every set of contracts an enabled rule
watches (#402), under exactly the holdings' sampling rules (`takes_sample`, ADR 0011). Port of
backend/src/engine/watching.test.ts.

Driven through `MonitorSweeper`, as the holdings' sampler is, for its reason: the figures must come
from the sweep's own batch, and a unit test handing the sampler a batch it built itself could not show
that no call was added for them.
"""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from harness import fake_fetcher
from optionality.contract import build_spx_code
from sweep import SWEEP_SETTINGS, insert_combo, insert_monitor

from optionality_backend.db.open import create_database
from optionality_backend.db.values import to_sqlite_json
from optionality_backend.engine import MonitorSweeper, SweeperDeps
from optionality_backend.env import settings_for

EXPIRY = "2026-10-31"
SHORT = build_spx_code(EXPIRY, "CALL", 8100)
LONG = build_spx_code(EXPIRY, "CALL", 8150)
KEY = ",".join(sorted([SHORT, LONG]))
SPREAD_LEGS = [{"sign": -1, "option_type": "CALL", "strike": 8100}, {"sign": 1, "option_type": "CALL", "strike": 8150}]


def quote(mid: float | None, **over: Any) -> dict[str, Any]:
    return {
        **({"bid_price": 0, "ask_price": 0} if mid is None else {"mid_price": mid}),
        "option_implied_volatility": 12.5,
        "option_vega": 3.25,
        "option_delta": 0.25,
        "option_contract_size": 100,
        **over,
    }


class World:
    """The suite's `beforeEach`: inside the sample hours, 11:00 in New York on a Thursday."""

    def __init__(self, folder: Path) -> None:
        self.db: sqlite3.Connection = create_database(folder / "test.db")
        self.now = datetime(2026, 10, 1, 15, 0, tzinfo=UTC)
        self.calls: list[list[str]] = []
        self.book: dict[str, dict[str, Any]] = {
            SHORT: quote(5),
            LONG: quote(2, option_implied_volatility=11.5, option_delta=0.125),
        }

    def provider(self, codes: list[str]) -> list[dict[str, Any]]:
        self.calls.append(list(codes))
        return [{"code": c, "name": c, **self.book[c]} for c in codes if c in self.book]

    async def sweep(self) -> None:
        await MonitorSweeper(
            SweeperDeps(
                db=self.db,
                settings=settings_for(**SWEEP_SETTINGS),
                fetch_quotes=fake_fetcher(self.provider),
                send=lambda _text: None,
                now=lambda: self.now,
            )
        ).sweep()

    def spread_rule(self, **over: Any) -> str:
        return insert_combo(
            self.db,
            **{
                "strike_date": EXPIRY,
                "code": "oct-calls",
                "threshold": 4,
                "direction": "above",
                "legs": SPREAD_LEGS,
                **over,
            },
        )

    def stored(self) -> list[dict[str, Any]]:
        cursor = self.db.execute("select * from watch_samples order by contracts, observed_on")
        names = [d[0] for d in cursor.description]
        return [dict(zip(names, r, strict=True)) for r in cursor.fetchall()]

    def hold(self, legs: Any) -> None:
        self.db.execute(
            """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
               values ('p1', 'held', null, ?, 1, 3.0, ?, '2026-09-01 00:00:00.000000')""",
            (EXPIRY, to_sqlite_json(legs)),
        )


@pytest.fixture
def w(tmp_path: Path):
    world = World(tmp_path)
    yield world
    world.db.close()


def matches(rows: list[dict[str, Any]], expected: list[dict[str, Any]]) -> bool:
    return len(rows) == len(expected) and all({k: r[k] for k in e} == e for r, e in zip(rows, expected, strict=True))


class TestTheDailyCloseOfWhatIsWatched:
    async def test_records_a_watched_spreads_contracts_each_mid_iv_vega_and_delta_its_dte_size_and_stamp(
        self, w: World
    ) -> None:
        w.spread_rule()
        await w.sweep()
        assert w.stored() == [
            {
                "contracts": KEY,
                "observed_on": "2026-10-01",
                "dte": 30,
                "legs_mid": to_sqlite_json({SHORT: 5, LONG: 2}),
                "legs_iv": to_sqlite_json({SHORT: 12.5, LONG: 11.5}),
                "legs_vega": to_sqlite_json({SHORT: 3.25, LONG: 3.25}),
                "legs_delta": to_sqlite_json({SHORT: 0.25, LONG: 0.125}),
                "observed_at": "2026-10-01 15:00:00.000000",
                "spx": None,
                "contract_size": 100,
            }
        ]

    async def test_asks_the_provider_for_nothing_more_one_call_the_codes_the_rules_already_needed(
        self, w: World
    ) -> None:
        w.spread_rule()
        insert_monitor(w.db, strike_date=EXPIRY, code=SHORT, option_type="CALL", strike=8100)
        await w.sweep()
        assert w.calls == [sorted([SHORT, LONG])]
        assert [s["contracts"] for s in w.stored()] == sorted([SHORT, KEY])

    async def test_keeps_one_history_for_every_rule_on_the_same_contracts_whatever_their_signs_fields_or_names(
        self, w: World
    ) -> None:
        w.spread_rule()
        w.spread_rule(field="option_delta", threshold=0.3, direction="above")
        w.spread_rule(
            code="oct-calls-debit",
            legs=[
                {"sign": 1, "option_type": "CALL", "strike": 8100},
                {"sign": -1, "option_type": "CALL", "strike": 8150, "qty": 2},
            ],
        )
        await w.sweep()
        assert [s["contracts"] for s in w.stored()] == [KEY]

    async def test_records_a_watched_single_contract_as_a_set_of_one(self, w: World) -> None:
        insert_monitor(w.db, strike_date=EXPIRY, code=SHORT, option_type="CALL", strike=8100)
        await w.sweep()
        assert matches(w.stored(), [{"contracts": SHORT, "legs_mid": to_sqlite_json({SHORT: 5})}])

    async def test_records_nothing_for_a_rule_switched_off(self, w: World) -> None:
        w.spread_rule(enabled=0, disabled_reason="manual")
        await w.sweep()
        assert w.stored() == []

    async def test_records_nothing_for_a_rule_switched_off_though_its_contracts_are_in_the_batch_for_others(
        self, w: World
    ) -> None:
        w.spread_rule(enabled=0, disabled_reason="manual")
        insert_monitor(w.db, strike_date=EXPIRY, code=SHORT, option_type="CALL", strike=8100)
        insert_monitor(w.db, strike_date=EXPIRY, code=LONG, option_type="CALL", strike=8150)
        await w.sweep()
        assert [s["contracts"] for s in w.stored()] == sorted([SHORT, LONG])

    async def test_leaves_the_contracts_an_open_holding_holds_exactly_to_the_holdings_own_samples(
        self, w: World
    ) -> None:
        w.hold(
            [
                {"side": "short", "option_type": "CALL", "strike": 8100},
                {"side": "long", "option_type": "CALL", "strike": 8150},
            ]
        )
        w.spread_rule()
        await w.sweep()
        assert w.stored() == []

    async def test_still_records_a_candidate_that_shares_only_one_contract_with_a_holding(self, w: World) -> None:
        w.hold(
            [
                {"side": "short", "option_type": "CALL", "strike": 8050},
                {"side": "long", "option_type": "CALL", "strike": 8100},
            ]
        )
        w.spread_rule()
        await w.sweep()
        assert [s["contracts"] for s in w.stored()] == [KEY]

    async def test_stops_once_the_contracts_have_expired(self, w: World) -> None:
        w.spread_rule(strike_date="2026-09-30")
        insert_monitor(w.db, strike_date="2026-09-30", code=build_spx_code("2026-09-30", "CALL", 8100))
        await w.sweep()
        assert w.stored() == []


class TestUnderExactlyTheHoldingsSamplingRules:
    async def test_settles_on_the_close_a_mark_that_moves_after_16_15_does_not_move_the_days_row(
        self, w: World
    ) -> None:
        w.spread_rule()
        w.now = datetime(2026, 10, 1, 20, 14, tzinfo=UTC)  # 16:14 in New York
        await w.sweep()
        w.book[SHORT] = quote(7)
        w.now = datetime(2026, 10, 2, 0, 30, tzinfo=UTC)  # 20:30, the same New York day
        await w.sweep()
        assert matches(
            w.stored(),
            [
                {
                    "observed_on": "2026-10-01",
                    "legs_mid": to_sqlite_json({SHORT: 5, LONG: 2}),
                    "observed_at": "2026-10-01 20:14:00.000000",
                }
            ],
        )

    async def test_fills_a_day_out_of_hours_with_no_price_and_its_vol_when_no_contract_has_a_book(
        self, w: World
    ) -> None:
        w.spread_rule()
        w.book = {SHORT: quote(None), LONG: quote(None)}
        w.now = datetime(2026, 10, 2, 1, 0, tzinfo=UTC)  # 21:00 in New York, after the close
        await w.sweep()
        assert matches(
            w.stored(),
            [
                {
                    "observed_on": "2026-10-01",
                    "legs_mid": None,
                    "legs_iv": to_sqlite_json({SHORT: 12.5, LONG: 12.5}),
                    "observed_at": "2026-10-02 01:00:00.000000",
                }
            ],
        )

    async def test_never_replaces_a_stored_price_with_an_empty_one(self, w: World) -> None:
        w.spread_rule()
        await w.sweep()
        w.book = {SHORT: quote(None), LONG: quote(5.5)}
        w.now = datetime(2026, 10, 1, 16, 0, tzinfo=UTC)
        await w.sweep()
        assert matches(w.stored(), [{"legs_mid": to_sqlite_json({SHORT: 5, LONG: 2})}])

    async def test_records_a_row_on_a_saturday_carrying_the_last_close_forward(self, w: World) -> None:
        w.spread_rule()
        w.now = datetime(2026, 10, 3, 14, 0, tzinfo=UTC)  # a Saturday, mid-morning in New York
        await w.sweep()
        assert matches(w.stored(), [{"observed_on": "2026-10-03", "dte": 28}])

    async def test_writes_nothing_on_a_sweep_that_would_store_the_same_row_again(self, w: World) -> None:
        w.spread_rule()
        await w.sweep()
        before = w.stored()
        w.now = datetime(2026, 10, 1, 15, 5, tzinfo=UTC)
        await w.sweep()
        assert w.stored() == before

    async def test_writes_when_a_figure_moves_in_the_hours(self, w: World) -> None:
        w.spread_rule()
        await w.sweep()
        w.book[LONG] = quote(2.5)
        w.now = datetime(2026, 10, 1, 15, 5, tzinfo=UTC)
        await w.sweep()
        assert matches(
            w.stored(),
            [{"legs_mid": to_sqlite_json({SHORT: 5, LONG: 2.5}), "observed_at": "2026-10-01 15:05:00.000000"}],
        )

    async def test_records_nothing_for_contracts_the_provider_returned_nothing_for(self, w: World) -> None:
        w.spread_rule()
        w.book = {}
        await w.sweep()
        assert w.stored() == []
