"""What a sweep does to HOLDINGS: the daily sample, and the manage-by notice. Port of
backend/src/engine/positions.test.ts.

Both are `positions.py`'s and neither is an alarm. They are driven through `MonitorSweeper` anyway,
and deliberately: the batch they read is the sweep's batch, the instant they stamp is the sweep's
instant, and a unit test that handed `record_samples` a record it built itself would stop proving the
thing that actually broke twice — that a Position's legs are IN the batch. The sweeper is imported
from the engine's door, as the TypeScript's is from `./index.ts`.

What only the Python can get wrong is at the end.
"""

import json
import logging
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from harness import FakeProvider, fake_fetcher
from optionality.contract import build_spx_code
from optionality.vol import VolSample, vol_attribution
from sweep import SINGLE_CODE as CODE
from sweep import SWEEP_SETTINGS, insert_monitor, quoting

from optionality_backend.db.open import create_database
from optionality_backend.db.queries import find_position, list_position_samples
from optionality_backend.db.values import to_sqlite_json
from optionality_backend.engine import MonitorSweeper, SweeperDeps
from optionality_backend.env import settings_for
from optionality_backend.hydrate import to_position
from optionality_backend.notify import NotifySender

LOG = "optionality_backend.engine.positions"

TWO_LEGS = [
    {"side": "short", "option_type": "CALL", "strike": 8050},
    {"side": "long", "option_type": "CALL", "strike": 8075},
]


class Book:
    """The suite's `beforeEach`: a fresh database, the clock, and what was sent."""

    def __init__(self, folder: Path) -> None:
        self.db: sqlite3.Connection = create_database(folder / "test.db")
        self.now = datetime(2026, 10, 1, 5, 0, tzinfo=UTC)
        self.sent: list[str] = []

    def days_from_now(self, n: int) -> str:
        return (self.now + timedelta(days=n)).date().isoformat()

    def future(self) -> str:
        return self.days_from_now(30)

    def past(self) -> str:
        return self.days_from_now(-1)

    def sold(self) -> str:
        """The short leg of the two-leg spread, 30 days out."""
        return build_spx_code(self.future(), "CALL", 8050)

    def bought(self) -> str:
        return build_spx_code(self.future(), "CALL", 8075)

    def monitor(self, **over: Any) -> str:
        return insert_monitor(self.db, **{"strike_date": self.future(), **over})

    def sweeper(self, fetch: FakeProvider, send: NotifySender | None = None, **over: Any) -> MonitorSweeper:
        """`send` is overridden only where the test is about a send that FAILS, which a collecting
        fake cannot do."""
        return MonitorSweeper(
            SweeperDeps(
                db=self.db,
                settings=settings_for(**{**SWEEP_SETTINGS, **over}),
                fetch_quotes=fake_fetcher(fetch),
                send=send or self.sent.append,
                now=lambda: self.now,
            )
        )

    def held(self, name: str, strike_date: str | None = None, legs: Any = None) -> str:
        """A Position with no Opened, for the sampler: entry 2.0, 30 days out, a two-leg call spread."""
        id_ = name.ljust(32, "0")
        self.db.execute(
            """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                              opened_at, manage_notified_at)
       values (?, ?, null, ?, 1, 2.0, ?, '2026-08-01 00:00:00.000000', null, null)""",
            (id_, name, strike_date or self.future(), to_sqlite_json(TWO_LEGS if legs is None else legs)),
        )
        return id_

    def samples(self) -> list[dict[str, Any]]:
        cursor = self.db.execute(
            "select position_id, observed_on, dte, cost_to_close from position_samples order by position_id"
        )
        names = [d[0] for d in cursor.description]
        return [dict(zip(names, r, strict=True)) for r in cursor.fetchall()]

    def column(self, sql: str, *params: Any) -> Any:
        found = self.db.execute(sql, params).fetchone()
        return None if found is None else found[0]

    def spread(self, sold: float, bought: float) -> FakeProvider:
        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [{"code": c, "name": c, "mid_price": sold if c == self.sold() else bought} for c in codes]

        return fetch

    def writes(self) -> int:
        return self.db.execute("select total_changes()").fetchone()[0]


@pytest.fixture
def b(tmp_path: Path):
    book = Book(tmp_path)
    yield book
    book.db.close()


class TestPositionsInTheBatch:
    async def test_fetches_a_held_positions_legs_even_when_nothing_alarms_on_them(self, b: Book) -> None:
        # the dashboard values a position from this same fetch, and a held position must not read as
        # "—" merely because you happen not to be watching it
        b.db.execute(
            """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values (?, 'held', 'credit_spread', ?, 1, 2.0, ?, '2026-08-01 00:00:00.000000')""",
            ("p" * 32, b.future(), to_sqlite_json(TWO_LEGS)),
        )
        b.monitor()
        asked: list[list[str]] = []

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            asked.append(codes)
            return [{"code": c, "name": c, "option_delta": 0.1} for c in codes]

        await b.sweeper(fetch).sweep()

        assert asked[0] == sorted([CODE, b.sold(), b.bought()])

    async def test_widens_the_batch_only_the_alarm_loop_still_runs_over_the_active_monitors(self, b: Book) -> None:
        b.db.execute(
            """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values (?, 'held', 'credit_spread', ?, 1, 2.0, ?, '2026-08-01 00:00:00.000000')""",
            ("p" * 32, b.future(), to_sqlite_json(TWO_LEGS[:1])),
        )
        # no monitors at all: the position's legs are fetched and nothing alarms
        asked: list[list[str]] = []

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            asked.append(codes)
            return [{"code": c, "name": c, "option_delta": 0.99} for c in codes]

        s = b.sweeper(fetch)
        await s.sweep()
        assert b.sent == []
        assert s.health.last_sweep_ok() is True
        assert asked[0] == [b.sold()]


class TestRecordingWhatAPositionWasWorth:
    """One observation per Position per market day, so the √T decay shape can be checked against this
    book rather than defended on arithmetic — it had one confirming observation when it was chosen
    (ADR 0011). Nothing reads these yet; that is the point of starting now."""

    @pytest.fixture(autouse=True)
    def _in_the_sample_hours(self, b: Book) -> None:
        # 11:00 in New York, the same market day as the suite's 01:00 clock: the suite's clock is the
        # small hours, which is now when nothing is written
        b.now = datetime(2026, 10, 1, 15, 0, tzinfo=UTC)

    async def test_writes_one_row_per_position_with_the_cost_to_close_and_the_dashboards_dte(self, b: Book) -> None:
        id_ = b.held("held")
        await b.sweeper(b.spread(5.0, 1.0)).sweep()

        # sold 5.00 and bought 1.00: 4.00 to buy the spread back
        assert b.samples() == [{"position_id": id_, "observed_on": "2026-10-01", "dte": 30, "cost_to_close": 4}]

    async def test_keeps_the_last_sweep_of_a_market_day_not_the_first(self, b: Book) -> None:
        # the sweep runs every 60 seconds and a day of samples is a day, not 1,440 of them. Last rather
        # than first because the service runs through the close, so the row converges on the settled
        # mark instead of the opening spread.
        id_ = b.held("held")
        await b.sweeper(b.spread(5.0, 1.0)).sweep()
        b.now = datetime(2026, 10, 1, 19, 55, tzinfo=UTC)
        await b.sweeper(b.spread(4.0, 1.0)).sweep()

        assert b.samples() == [{"position_id": id_, "observed_on": "2026-10-01", "dte": 30, "cost_to_close": 3}]

    @staticmethod
    def pricing(short: str, sold: float, without: str | None = None) -> FakeProvider:
        """The held spread priced at codes fixed by the caller — so moving the clock does not move the
        contracts — with both vol readings unless `without` names one."""

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {
                    "code": c,
                    "name": c,
                    "mid_price": sold if c == short else 1.0,
                    **({} if without == "iv" else {"option_implied_volatility": 14.5}),
                    **({} if without == "vega" else {"option_vega": 4.25}),
                }
                for c in codes
            ]

        return fetch

    @staticmethod
    def rows(b: Book) -> list[tuple[Any, ...]]:
        return b.db.execute(
            """select observed_on, cost_to_close, observed_at,
                      legs_iv is not null, legs_vega is not null
               from position_samples order by observed_on"""
        ).fetchall()

    async def test_stamps_every_write_with_the_sweeps_own_instant(self, b: Book) -> None:
        # so a chart can tell a close from a point filled after hours (ADR 0011)
        b.held("held")
        await b.sweeper(b.spread(5.0, 1.0)).sweep()  # 11:00 EDT on 2026-10-01
        assert b.column("select observed_at from position_samples") == "2026-10-01 15:00:00.000000"

    async def test_never_changes_a_complete_row_outside_the_hours_however_the_mark_moves(self, b: Book) -> None:
        # a settled close stays the close; 22:00 on a New York Thursday is Friday in UTC, and the row is
        # still Thursday's
        b.held("held")
        short = b.sold()
        await b.sweeper(self.pricing(short, 5.0)).sweep()  # 11:00 on 2026-10-01
        b.now = datetime(2026, 10, 2, 2, 0, tzinfo=UTC)  # 22:00 on 2026-10-01 in New York, Friday in UTC
        await b.sweeper(self.pricing(short, 3.0)).sweep()

        assert self.rows(b) == [("2026-10-01", 4, "2026-10-01 15:00:00.000000", 1, 1)]

    async def test_takes_a_holdings_first_sample_whatever_the_hour_and_leaves_it_alone_after(self, b: Book) -> None:
        # the owner records a trade in the Singapore morning, which is New York's evening after the
        # close of the day it was put on: under the hours alone its first row would be the next day's,
        # never its Opened day, and the vol chain would never start (takes_sample)
        b.now = datetime(2026, 10, 2, 0, 30, tzinfo=UTC)  # 20:30 on 2026-10-01 in New York
        id_ = b.held("recorded-late")
        short = b.sold()
        await b.sweeper(self.pricing(short, 5.0)).sweep()
        b.now = datetime(2026, 10, 2, 0, 45, tzinfo=UTC)  # 20:45, a moved mark, and the row now exists
        await b.sweeper(self.pricing(short, 4.0)).sweep()

        assert b.samples() == [{"position_id": id_, "observed_on": "2026-10-01", "dte": 31, "cost_to_close": 4}]
        assert self.rows(b)[0][2] == "2026-10-02 00:30:00.000000"

    async def test_fills_a_day_whose_session_was_missed_whole_after_the_hours_and_marks_it(self, b: Book) -> None:
        # a reboot waiting at the FileVault login, OpenD waiting for one: no sweep ran in the session,
        # and a day with no row is a hole that blanks the Vol part for good (vol.py)
        b.held("held")
        short = b.sold()
        await b.sweeper(self.pricing(short, 5.0)).sweep()  # 11:00 on 2026-10-01
        b.now = datetime(2026, 10, 3, 0, 30, tzinfo=UTC)  # 20:30 on 2026-10-02: its whole session missed
        await b.sweeper(self.pricing(short, 4.0)).sweep()
        b.now = datetime(2026, 10, 3, 0, 45, tzinfo=UTC)
        await b.sweeper(self.pricing(short, 3.0)).sweep()

        assert self.rows(b) == [
            ("2026-10-01", 4, "2026-10-01 15:00:00.000000", 1, 1),
            ("2026-10-02", 3, "2026-10-03 00:30:00.000000", 1, 1),
        ]

    async def test_completes_a_row_the_feed_left_without_its_vega_after_the_hours_from_a_sweep_with_both(
        self, b: Book
    ) -> None:
        # the vol chain needs an IV and a vega for every leg on every day; the row is written whole
        b.held("held")
        short = b.sold()
        await b.sweeper(self.pricing(short, 5.0, "vega")).sweep()  # 11:00: the vegas withheld all session
        b.now = datetime(2026, 10, 2, 0, 30, tzinfo=UTC)  # 20:30 the same market day
        await b.sweeper(self.pricing(short, 4.5)).sweep()

        assert self.rows(b) == [("2026-10-01", 3.5, "2026-10-02 00:30:00.000000", 1, 1)]

    async def test_does_not_complete_a_row_from_a_sweep_missing_the_other_map(self, b: Book) -> None:
        # the row is written whole, so this would trade the stored IV for the missing vega
        b.held("held")
        short = b.sold()
        await b.sweeper(self.pricing(short, 5.0, "vega")).sweep()
        b.now = datetime(2026, 10, 2, 0, 30, tzinfo=UTC)
        await b.sweeper(self.pricing(short, 4.5, "iv")).sweep()

        assert self.rows(b) == [("2026-10-01", 4, "2026-10-01 15:00:00.000000", 1, 0)]

    async def test_starts_the_vol_chain_on_the_opened_day_for_a_trade_recorded_after_the_close(self, b: Book) -> None:
        # the regression the hours alone caused, end to end: vol_attribution returns None unless the
        # first sample is dated Opened
        strike = "2026-10-31"
        sold = build_spx_code(strike, "CALL", 8050)
        id_ = "late".ljust(32, "0")
        b.db.execute(
            """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                              opened_at, manage_notified_at)
       values (?, 'late', null, ?, 1, 2.0, ?, '2026-10-02 00:30:00.000000', '2026-10-01', null)""",
            (id_, strike, to_sqlite_json(TWO_LEGS)),
        )

        def book(sold_iv: float) -> FakeProvider:
            def fetch(codes: list[str]) -> list[dict[str, Any]]:
                return [
                    {
                        "code": c,
                        "name": c,
                        "mid_price": 5.0 if c == sold else 1.0,
                        "option_implied_volatility": sold_iv if c == sold else 11.0,
                        "option_vega": 1.4 if c == sold else 0.9,
                    }
                    for c in codes
                ]

            return fetch

        b.now = datetime(2026, 10, 2, 0, 30, tzinfo=UTC)  # 20:30 on the Opened day, after the close
        await b.sweeper(book(10.5)).sweep()
        b.now = datetime(2026, 10, 2, 15, 0, tzinfo=UTC)  # 11:00 the next day, in the session
        await b.sweeper(book(11.5)).sweep()

        chain = [
            VolSample(
                observed_on=s["observed_on"],
                dte=s["dte"],
                legs_iv=None if s["legs_iv"] is None else json.loads(s["legs_iv"]),
                legs_vega=None if s["legs_vega"] is None else json.loads(s["legs_vega"]),
            )
            for s in list_position_samples(b.db, id_)
        ]
        found = find_position(b.db, id_)
        assert found is not None
        attributed = vol_attribution(chain, to_position(found))
        assert attributed is not None
        assert (attributed.from_, attributed.to, attributed.days) == ("2026-10-01", "2026-10-02", 1)

    async def test_settles_on_the_close_a_mark_that_moves_after_1615_does_not_move_the_days_row(self, b: Book) -> None:
        # SPXW trades again from about 20:15 in Global Trading Hours, and until this the day's row was
        # rewritten by every overnight mark that differed, up to New York's midnight. 16:15 is the
        # options' close, a quarter hour after the stocks'.
        b.held("held")
        short = b.sold()
        b.now = datetime(2026, 10, 1, 20, 14, 45, tzinfo=UTC)  # 16:14:45 EDT
        await b.sweeper(self.pricing(short, 5.0)).sweep()
        b.now = datetime(2026, 10, 1, 20, 15, 0, tzinfo=UTC)  # 16:15:00 EDT, the close itself, still in
        await b.sweeper(self.pricing(short, 4.5)).sweep()
        b.now = datetime(2026, 10, 1, 20, 15, 15, tzinfo=UTC)  # the next sweep, after the close
        await b.sweeper(self.pricing(short, 4.0)).sweep()
        b.now = datetime(2026, 10, 2, 1, 30, tzinfo=UTC)  # 21:30, overnight trading, same market day
        await b.sweeper(self.pricing(short, 3.0)).sweep()

        assert self.rows(b) == [("2026-10-01", 3.5, "2026-10-01 20:15:00.000000", 1, 1)]

    async def test_fills_a_day_before_the_open_and_the_session_then_writes_over_it(self, b: Book) -> None:
        # a day with no row is filled whenever it is first seen, the small hours included; inside the
        # hours the row is written freely again, so the session's figures replace the overnight ones
        b.held("held")
        short = b.sold()
        b.now = datetime(2026, 10, 1, 13, 29, 59, tzinfo=UTC)  # 09:29:59 EDT, no row for the day yet
        await b.sweeper(self.pricing(short, 5.0)).sweep()
        b.now = datetime(2026, 10, 1, 13, 30, 0, tzinfo=UTC)  # 09:30, the session
        await b.sweeper(self.pricing(short, 4.5)).sweep()

        assert self.rows(b) == [("2026-10-01", 3.5, "2026-10-01 13:30:00.000000", 1, 1)]

    async def test_leaves_a_provisional_fill_alone_before_the_open(self, b: Book) -> None:
        b.held("held")
        short = b.sold()
        b.now = datetime(2026, 10, 1, 4, 5, tzinfo=UTC)  # 00:05 EDT, the first sweep of the day
        await b.sweeper(self.pricing(short, 5.0)).sweep()
        b.now = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)  # 05:00 EDT, a moved overnight mark
        await b.sweeper(self.pricing(short, 4.0)).sweep()

        assert self.rows(b) == [("2026-10-01", 4, "2026-10-01 04:05:00.000000", 1, 1)]

    async def test_replaces_the_midnight_fill_with_the_evenings_after_a_session_missed_whole(self, b: Book) -> None:
        # the first sweep after New York's midnight fills the day from overnight marks; the session is
        # then missed and the service is back at 20:30 — the evening's reading is the better one
        b.held("held")
        short = b.sold()
        b.now = datetime(2026, 10, 1, 4, 5, tzinfo=UTC)  # 00:05 EDT: the midnight fill, provisional
        await b.sweeper(self.pricing(short, 5.0)).sweep()
        b.now = datetime(2026, 10, 2, 0, 30, tzinfo=UTC)  # 20:30 EDT the same market day
        await b.sweeper(self.pricing(short, 4.0)).sweep()
        b.now = datetime(2026, 10, 2, 0, 45, tzinfo=UTC)  # and now settled, so a later mark does not move it
        await b.sweeper(self.pricing(short, 3.0)).sweep()

        assert self.rows(b) == [("2026-10-01", 3, "2026-10-02 00:30:00.000000", 1, 1)]

    async def test_restamps_a_weekends_midnight_fill_in_the_hours_though_nothing_moved(self, b: Book) -> None:
        # nothing trades on a Saturday, so the "only when something differs" check would leave the
        # midnight fill stamped as an overnight mark for ever
        b.held("held")
        short = b.sold()
        b.now = datetime(2026, 10, 3, 4, 5, tzinfo=UTC)  # 00:05 EDT on Saturday 3 October
        await b.sweeper(self.pricing(short, 5.0)).sweep()
        b.now = datetime(2026, 10, 3, 15, 0, tzinfo=UTC)  # 11:00 EDT, the same figures
        await b.sweeper(self.pricing(short, 5.0)).sweep()
        restamped = self.rows(b)
        b.now = datetime(2026, 10, 3, 16, 0, tzinfo=UTC)  # 12:00, still the same: settled, no write
        await b.sweeper(self.pricing(short, 5.0)).sweep()

        assert restamped == [("2026-10-03", 4, "2026-10-03 15:00:00.000000", 1, 1)]
        assert self.rows(b) == restamped

    async def test_leaves_a_row_settled_after_the_close_alone_up_to_midnight(self, b: Book) -> None:
        b.held("held")
        short = b.sold()
        b.now = datetime(2026, 10, 2, 0, 30, tzinfo=UTC)  # 20:30 EDT on 1 October: settled
        await b.sweeper(self.pricing(short, 5.0)).sweep()
        b.now = datetime(2026, 10, 2, 3, 59, 59, tzinfo=UTC)  # 23:59:59 EDT, a moved mark
        await b.sweeper(self.pricing(short, 3.0)).sweep()

        assert self.rows(b) == [("2026-10-01", 4, "2026-10-02 00:30:00.000000", 1, 1)]

    async def test_records_a_position_whose_opened_nobody_has_entered_yet(self, b: Book) -> None:
        # the sample is raw: (DTE, Cost to close) means something without an Opened, and filling the
        # Opened in later makes the history it already collected interpretable
        b.held("unopened")
        await b.sweeper(b.spread(5.0, 1.0)).sweep()
        assert len(b.samples()) == 1
        assert b.column("select opened_at from positions") is None

    async def test_skips_a_position_it_could_not_price_quietly(self, b: Book, caplog: pytest.LogCaptureFixture) -> None:
        # one unpriced leg and the Cost to close is unknown, not zero — the same all-or-nothing rule
        # the dashboard holds to. With nothing else read either there is no row to write (#380 writes
        # one with an empty cost only to keep a reading), and the silence is the half worth asserting.
        b.held("held")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [{"code": c, "name": c, "mid_price": 5.0} for c in codes if c != b.bought()]

        with caplog.at_level(logging.ERROR):
            await b.sweeper(fetch).sweep()
        assert b.samples() == []
        errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert errors == [], f"an unpriced Position should be silent, not logged: {errors}"

    def no_book(self, b: Book, ivs: dict[str, float]) -> FakeProvider:
        """Both legs as moomoo answers them out of hours (#380): bid 0 / ask 0 and so no mid, the vol
        still served."""

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {
                    "code": c,
                    "name": c,
                    "bid_price": 0,
                    "ask_price": 0,
                    "option_implied_volatility": ivs.get(c, 15.0),
                    "option_vega": 2.5,
                    "option_delta": 0.1,
                }
                for c in codes
            ]

        return fetch

    def row(self, b: Book, id_: str) -> dict[str, Any] | None:
        cursor = b.db.execute(
            "select cost_to_close, legs_iv, legs_vega, legs_delta, observed_at from position_samples"
            " where position_id = ?",
            (id_,),
        )
        found = cursor.fetchone()
        return None if found is None else dict(zip([d[0] for d in cursor.description], found, strict=True))

    async def test_fills_a_day_with_an_empty_cost_and_its_vol_when_no_leg_has_a_book(self, b: Book) -> None:
        # out of hours moomoo quotes 0/0, and this row was a Cost to close of 0.00 — a weekend's, or the
        # Opened day of a trade recorded in the evening (#380). The vol chain needs the day; the price was
        # not there to read, so it is left empty rather than invented.
        id_ = b.held("held")
        legs = {b.sold(): 10.5, b.bought(): 22.1}
        quotes = self.no_book(b, legs)
        b.now = datetime(2026, 10, 17, 14, 0, tzinfo=UTC)  # a Saturday, mid-morning in New York
        await b.sweeper(quotes).sweep()
        r = self.row(b, id_)
        assert r is not None
        assert r["cost_to_close"] is None
        assert json.loads(r["legs_iv"]) == legs
        assert r["legs_vega"] is not None
        assert r["legs_delta"] is not None

    async def test_never_replaces_a_stored_cost_with_an_empty_one(self, b: Book) -> None:
        # in the hours a row is rewritten whenever its figures move, and the open quotes one leg before
        # another: a costless reading must not blank the day's price (#380)
        id_ = b.held("held")
        await b.sweeper(b.spread(5.0, 1.0)).sweep()
        before = self.row(b, id_)
        no_book = self.no_book(b, {})
        b.now += timedelta(minutes=1)
        await b.sweeper(no_book).sweep()
        assert self.row(b, id_) == before
        assert before is not None
        assert before["cost_to_close"] == 4
        # and after the close, where an incomplete row would otherwise be "completed"
        b.now = datetime(2026, 10, 2, 1, 30, tzinfo=UTC)  # 21:30 the same New York day
        await b.sweeper(no_book).sweep()
        assert self.row(b, id_) == before

    async def test_gives_a_costless_row_its_cost_when_a_sweep_prices_it(self, b: Book) -> None:
        id_ = b.held("held")
        await b.sweeper(self.no_book(b, {})).sweep()
        assert self.row(b, id_)["cost_to_close"] is None  # type: ignore[index]
        b.now += timedelta(minutes=1)
        await b.sweeper(b.spread(5.0, 1.0)).sweep()
        assert self.row(b, id_)["cost_to_close"] == 4  # type: ignore[index]

    async def test_stops_recording_once_a_position_has_expired(self, b: Book) -> None:
        b.held("gone", strike_date=b.past())
        await b.sweeper(b.spread(5.0, 1.0)).sweep()
        assert b.samples() == []

    async def test_records_nothing_for_a_holding_that_has_been_closed_adr_0022(self, b: Book) -> None:
        id_ = b.held("closed")
        b.db.execute("update positions set closed_on = '2026-08-02', exit = 0.5 where id = ?", (id_,))
        await b.sweeper(b.spread(5.0, 1.0)).sweep()
        assert b.samples() == []

    async def test_records_nothing_for_a_holding_closed_while_the_sweeps_call_was_in_flight(self, b: Book) -> None:
        # The holdings are read before the provider call and written after it. The rules are checked again
        # at that point (a rule muted mid-fetch is not alarmed on); the holdings were not, so a close that
        # landed during the fetch got one more sample, dated after it ended.
        id_ = b.held("closing")
        priced = b.spread(5.0, 1.0)

        def closing_mid_fetch(codes: list[str]) -> list[dict[str, Any]]:
            b.db.execute("update positions set closed_on = '2026-08-02', exit = 0.5 where id = ?", (id_,))
            return priced(codes)

        await b.sweeper(closing_mid_fetch).sweep()
        assert b.samples() == []

    async def test_records_each_legs_iv_beside_the_cost_which_is_what_a_vol_adjustment_needs(self, b: Book) -> None:
        # The √T shape silently assumes IV has not moved: time value scales with σ√T and only √T is
        # used. Fixing that needs a baseline, and nothing recorded one, so this starts.
        id_ = b.held("held")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {
                    "code": c,
                    "name": c,
                    "mid_price": 5.0 if c == b.sold() else 1.0,
                    "option_implied_volatility": 10.5 if c == b.sold() else 22.1,
                }
                for c in codes
            ]

        await b.sweeper(fetch).sweep()

        legs_iv = b.column("select legs_iv from position_samples where position_id = ?", id_)
        assert json.loads(legs_iv) == {b.sold(): 10.5, b.bought(): 22.1}

    async def test_records_a_row_on_a_saturday_which_the_vol_chain_depends_on(self, b: Book) -> None:
        # vol attribution requires consecutive samples to be exactly one calendar day apart, and that
        # is only exact because this writes every day: market_date is the New York CALENDAR date and
        # there is no market-day filter anywhere
        id_ = b.held("held")
        # 2026-10-17 is a Saturday; 14:00 UTC is mid-morning in New York
        saved = b.now
        b.now = datetime(2026, 10, 17, 14, 0, tzinfo=UTC)
        try:
            await b.sweeper(b.spread(5.0, 1.0)).sweep()
        finally:
            b.now = saved

        observed = b.column("select observed_on from position_samples where position_id = ?", id_)
        assert observed == "2026-10-17", "a Saturday row"

    async def test_records_each_legs_vega_beside_its_iv_because_a_weighted_vol_needs_weights(self, b: Book) -> None:
        # The adjustment multiplies the pace reference by one vol ratio, and these legs do not share a
        # vol. Collapsing them into one number needs a weight per leg, and the weight is vega — stored
        # beside the IV rather than derived later, because a vega is only knowable when observed.
        id_ = b.held("held")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {
                    "code": c,
                    "name": c,
                    "mid_price": 5.0 if c == b.sold() else 1.0,
                    "option_implied_volatility": 10.5 if c == b.sold() else 22.1,
                    "option_vega": 1.4 if c == b.sold() else 0.9,
                }
                for c in codes
            ]

        await b.sweeper(fetch).sweep()

        legs_vega = b.column("select legs_vega from position_samples where position_id = ?", id_)
        assert json.loads(legs_vega) == {b.sold(): 1.4, b.bought(): 0.9}

    async def test_records_no_vega_at_all_rather_than_some_of_it(self, b: Book) -> None:
        # same all-or-nothing as the IV map, for the same reason: a weighted mean over half the legs is
        # not a weighted mean of the structure
        id_ = b.held("held")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {
                    "code": c,
                    "name": c,
                    "mid_price": 5.0 if c == b.sold() else 1.0,
                    "option_implied_volatility": 10.5,
                    **({"option_vega": 1.4} if c == b.sold() else {}),
                }
                for c in codes
            ]

        await b.sweeper(fetch).sweep()

        assert b.column("select legs_vega from position_samples where position_id = ?", id_) is None

    async def test_still_records_the_iv_map_when_only_the_vegas_are_missing(self, b: Book) -> None:
        # the two maps are gated independently. A vega the feed withheld does not make the IV reading
        # untrue, and that reading is the one thing that cannot be reconstructed after the day passes
        id_ = b.held("held")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {
                    "code": c,
                    "name": c,
                    "mid_price": 5.0 if c == b.sold() else 1.0,
                    "option_implied_volatility": 10.5 if c == b.sold() else 22.1,
                }
                for c in codes
            ]

        await b.sweeper(fetch).sweep()

        legs_iv, legs_vega = b.db.execute(
            "select legs_iv, legs_vega from position_samples where position_id = ?", (id_,)
        ).fetchone()
        assert legs_vega is None
        assert json.loads(legs_iv) == {b.sold(): 10.5, b.bought(): 22.1}

    async def test_still_records_the_vega_map_when_only_the_ivs_are_missing(self, b: Book) -> None:
        # the other direction of the same independence, which nothing held: making the vega map wait
        # for the IV map passed every test above, because each one that withheld an IV withheld the
        # vegas too. "Per map" and "gated separately" are the rule, and a vega is only knowable when
        # it was observed (ADR 0011), so a feed that withheld the IVs has not made the vegas untrue —
        # dropping them would lose a reading no later sweep can take, to keep a column company.
        id_ = b.held("held")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {
                    "code": c,
                    "name": c,
                    "mid_price": 5.0 if c == b.sold() else 1.0,
                    "option_vega": 1.4 if c == b.sold() else 0.9,
                }
                for c in codes
            ]

        await b.sweeper(fetch).sweep()

        legs_iv, legs_vega = b.db.execute(
            "select legs_iv, legs_vega from position_samples where position_id = ?", (id_,)
        ).fetchone()
        assert legs_iv is None
        assert json.loads(legs_vega) == {b.sold(): 1.4, b.bought(): 0.9}

    async def test_records_no_iv_at_all_rather_than_some_of_it(self, b: Book) -> None:
        # a vol adjustment needs every leg: with one missing you cannot say what the structure's vol
        # did. The cost to close is still recorded — that is a different all-or-nothing, and it has
        # all its mids.
        id_ = b.held("held")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {
                    "code": c,
                    "name": c,
                    "mid_price": 5.0 if c == b.sold() else 1.0,
                    **({"option_implied_volatility": 10.5} if c == b.sold() else {}),
                }
                for c in codes
            ]

        await b.sweeper(fetch).sweep()

        legs_iv, cost = b.db.execute(
            "select legs_iv, cost_to_close from position_samples where position_id = ?", (id_,)
        ).fetchone()
        assert legs_iv is None
        assert cost == 4

    async def test_records_each_legs_delta_which_is_the_risk_the_owner_watches(self, b: Book) -> None:
        # short-leg delta is how this book is managed, and a chart of it over a trade's life needs it
        # recorded on the day: like a vega, a delta is only knowable when it was observed
        id_ = b.held("held")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {
                    "code": c,
                    "name": c,
                    "mid_price": 5.0 if c == b.sold() else 1.0,
                    "option_delta": 0.16 if c == b.sold() else 0.11,
                }
                for c in codes
            ]

        await b.sweeper(fetch).sweep()

        legs_delta = b.column("select legs_delta from position_samples where position_id = ?", id_)
        assert json.loads(legs_delta) == {b.sold(): 0.16, b.bought(): 0.11}

    async def test_records_spx_s_price_derived_from_the_sweep_s_own_batch(self, b: Book) -> None:
        # the index the day's row was observed against (ADR 0024), from the whole batch as /quotes has
        # it, inverted from each leg's premium and last
        id_ = b.held("held")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {
                    "code": c,
                    "name": c,
                    "mid_price": 5.0 if c == b.sold() else 1.0,
                    "last_price": 5.0 if c == b.sold() else 1.0,
                    "option_premium": 15,
                }
                for c in codes
            ]

        await b.sweeper(fetch).sweep()

        spx = b.column("select spx from position_samples where position_id = ?", id_)
        assert spx == round(((8055 + 8076) / 2) / 1.15, 2)

    async def test_records_no_spx_price_where_the_batch_cannot_give_one_and_the_sample_regardless(
        self, b: Book
    ) -> None:
        # a sample is the cost to close first: an index the Provider cannot imply costs it nothing
        id_ = b.held("held")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [{"code": c, "name": c, "mid_price": 1.0, "last_price": 1.0} for c in codes]

        await b.sweeper(fetch).sweep()

        assert b.column("select spx from position_samples where position_id = ?", id_) is None
        assert b.column("select cost_to_close from position_samples where position_id = ?", id_) == 0

    async def test_records_no_delta_at_all_rather_than_some_of_it_and_the_other_maps_regardless(self, b: Book) -> None:
        # the same all-or-nothing per map as the IV and the vega, and gated on its own: a withheld
        # delta makes neither the IV nor the vega reading untrue
        id_ = b.held("held")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {
                    "code": c,
                    "name": c,
                    "mid_price": 5.0 if c == b.sold() else 1.0,
                    "option_implied_volatility": 10.5,
                    "option_vega": 1.0,
                    **({"option_delta": 0.16} if c == b.sold() else {}),
                }
                for c in codes
            ]

        await b.sweeper(fetch).sweep()

        legs_delta, legs_iv, legs_vega = b.db.execute(
            "select legs_delta, legs_iv, legs_vega from position_samples where position_id = ?", (id_,)
        ).fetchone()
        assert legs_delta is None
        assert legs_iv is not None
        assert legs_vega is not None


class TestHowOftenTheSamplerActuallyWrites:
    """It wrote on every sweep — 5,760 times a day at a 15-second interval, to persist ONE row, and
    overnight almost every one of those stored a value identical to what was already there. The live
    file carried a 3.1MB write-ahead log against a 110KB database because of it."""

    @staticmethod
    def quiet(b: Book, mid: float, iv: float, vega: float = 1.0, delta: float = 0.16) -> FakeProvider:
        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {
                    "code": c,
                    "name": c,
                    "mid_price": mid if c == b.sold() else 1.0,
                    "option_implied_volatility": iv,
                    "option_vega": vega,
                    "option_delta": delta,
                }
                for c in codes
            ]

        return fetch

    @pytest.fixture(autouse=True)
    def _in_the_sample_hours(self, b: Book) -> None:
        # inside the sample hours, so each sweep below is one that may write (see the suite above)
        b.now = datetime(2026, 10, 1, 15, 0, tzinfo=UTC)

    async def test_writes_when_only_spx_moves_so_the_day_s_row_keeps_the_index_of_its_close(self, b: Book) -> None:
        # the index moves on a sweep where every mark sits still, and the row should say where it was
        b.held("held")

        def at(premium: float):
            def fetch(codes: list[str]) -> list[dict[str, Any]]:
                return [
                    {
                        "code": c,
                        "name": c,
                        "mid_price": 5.0 if c == b.sold() else 1.0,
                        "option_implied_volatility": 10.5,
                        "option_vega": 1.0,
                        "option_delta": 0.16,
                        "last_price": 1.0,
                        "option_premium": premium,
                    }
                    for c in codes
                ]

            return fetch

        await b.sweeper(at(15)).sweep()
        after = b.writes()
        await b.sweeper(at(14)).sweep()
        assert b.writes() > after

        assert b.column("select spx from position_samples") == round(((8051 + 8076) / 2) / 1.14, 2)

    async def test_writes_when_only_a_delta_moves_which_the_cost_the_iv_and_the_vega_can_all_hide(
        self, b: Book
    ) -> None:
        # spot moving between two strikes changes the deltas while a mid barely does, and the delta is
        # the figure the owner manages by
        b.held("held")
        await b.sweeper(self.quiet(b, 5.0, 10.5, 1.0, 0.16)).sweep()
        after = b.writes()
        await b.sweeper(self.quiet(b, 5.0, 10.5, 1.0, 0.21)).sweep()
        assert b.writes() > after

        assert json.loads(b.column("select legs_delta from position_samples"))[b.sold()] == 0.21

    async def test_writes_nothing_on_a_sweep_that_would_store_the_same_row_again(self, b: Book) -> None:
        b.held("held")
        await b.sweeper(self.quiet(b, 5.0, 10.5)).sweep()
        after = b.writes()

        for _ in range(20):
            await b.sweeper(self.quiet(b, 5.0, 10.5)).sweep()
        assert b.writes() - after == 0, "twenty identical sweeps should cost no writes"

    async def test_writes_when_the_figure_moves_so_the_days_row_still_settles_on_the_close(self, b: Book) -> None:
        b.held("held")
        await b.sweeper(self.quiet(b, 5.0, 10.5)).sweep()
        after = b.writes()
        await b.sweeper(self.quiet(b, 4.0, 10.5)).sweep()
        assert b.writes() > after

        assert b.column("select cost_to_close from position_samples") == 3

    async def test_writes_when_only_the_iv_moves_which_the_cost_alone_would_hide(self, b: Book) -> None:
        # the mid can sit still while vol moves, and the vol is the half being recorded for later
        b.held("held")
        await b.sweeper(self.quiet(b, 5.0, 10.5)).sweep()
        after = b.writes()
        await b.sweeper(self.quiet(b, 5.0, 12.0)).sweep()
        assert b.writes() > after

        assert json.loads(b.column("select legs_iv from position_samples"))[b.sold()] == 12.0

    async def test_writes_when_only_a_vega_moves_which_neither_the_cost_nor_the_iv_would_show(self, b: Book) -> None:
        # vega moves with spot and with time even at a fixed mid and a fixed IV, and it is the weight
        # the stored IVs will be combined with — a row left with a stale weight is weighted wrongly
        # for ever
        b.held("held")
        await b.sweeper(self.quiet(b, 5.0, 10.5, 1.4)).sweep()
        after = b.writes()
        await b.sweeper(self.quiet(b, 5.0, 10.5, 1.1)).sweep()
        assert b.writes() > after

        assert json.loads(b.column("select legs_vega from position_samples"))[b.sold()] == 1.1

    async def test_does_not_stop_the_sweep_if_recording_fails(self, b: Book) -> None:
        # the sweep's job is the alarm. A sample is a nice-to-have and must never be the reason a
        # breach goes unmessaged, so the write is guarded like the telegram send is.
        id_ = b.held("held")
        b.monitor(threshold=0.05)
        b.db.execute("DROP TABLE position_samples")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [{"code": c, "name": c, "option_delta": 0.9, "mid_price": 5.0} for c in codes]

        s = b.sweeper(fetch)
        await s.sweep()

        assert any("⚠️" in x for x in b.sent), "the alarm still went out"
        assert s.health.last_sweep_ok() is True
        assert id_


class TestTheManageByNotice:
    """A deadline is a date, and a date is the one thing the service can act on while nobody is
    looking (ADR 0011). Pace deliberately does NOT notify: being behind fires on every IV spike.
    Monitor thresholds are untouched — this is a notice about a Position, not an Alarm."""

    @staticmethod
    def held(b: Book, name: str, opened_at: str | None, dte_left: int) -> str:
        id_ = name.ljust(32, "0")
        b.db.execute(
            """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                              opened_at, manage_notified_at)
       values (?, ?, null, ?, 1, 6.86, ?, '2026-08-01 00:00:00.000000', ?, null)""",
            (
                id_,
                name,
                b.days_from_now(dte_left),
                to_sqlite_json([{"side": "short", "option_type": "CALL", "strike": 8050}]),
                opened_at,
            ),
        )
        return id_

    @staticmethod
    def notices(b: Book) -> list[str]:
        return [t for t in b.sent if "manage" in t]

    @staticmethod
    def notified_at(b: Book, id_: str) -> str | None:
        return b.column("select manage_notified_at from positions where id = ?", id_)

    def leg(self, b: Book, dte: int) -> str:
        return build_spx_code(b.days_from_now(dte), "CALL", 8050)

    async def test_speaks_when_a_declared_position_reaches_the_deadline(self, b: Book) -> None:
        id_ = self.held(b, "condor", b.days_from_now(-24), 21)  # opened at 45 DTE, now at 21
        await b.sweeper(quoting("mid_price", {self.leg(b, 21): 4.4})).sweep()

        assert len(self.notices(b)) == 1
        assert "condor" in self.notices(b)[0]
        assert "21 DTE" in self.notices(b)[0]
        assert self.notified_at(b, id_)

    async def test_says_it_once_not_once_a_minute(self, b: Book) -> None:
        self.held(b, "condor", b.days_from_now(-24), 21)
        fetch = quoting("mid_price", {self.leg(b, 21): 4.4})
        await b.sweeper(fetch).sweep()
        await b.sweeper(fetch).sweep()
        await b.sweeper(fetch).sweep()
        assert len(self.notices(b)) == 1

    async def test_stays_quiet_on_a_position_whose_opened_nobody_declared_and_logs_nothing(
        self, b: Book, caplog: pytest.LogCaptureFixture
    ) -> None:
        # THE reason `opened_at` is the opt-in. Three of the five Positions in the live book were
        # already inside 21 DTE when this shipped; without the gate the first sweep after deploy would
        # have fired three retroactive notices at once and looked like a fault. The silence is asserted
        # as well as the quiet: "skipped" and "raised and was swallowed" read alike otherwise.
        self.held(b, "undeclared", None, 4)
        with caplog.at_level(logging.ERROR):
            await b.sweeper(quoting("mid_price", {self.leg(b, 4): 0.1})).sweep()
        assert self.notices(b) == []
        errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert errors == [], f"an undeclared Position should be silent: {errors}"

    async def test_stays_quiet_while_the_deadline_is_still_ahead(self, b: Book) -> None:
        self.held(b, "condor", b.days_from_now(-6), 39)  # opened at 45, now at 39: eighteen days to go
        await b.sweeper(quoting("mid_price", {self.leg(b, 39): 6.5})).sweep()
        assert self.notices(b) == []

    async def test_speaks_for_a_position_already_past_the_deadline_when_it_is_declared(self, b: Book) -> None:
        # declaring an Opened on something already inside 21 DTE is not a mistake — it is overdue, and
        # overdue is exactly what the notice is for
        self.held(b, "late", b.days_from_now(-41), 4)
        await b.sweeper(quoting("mid_price", {self.leg(b, 4): 0.1})).sweep()
        assert len(self.notices(b)) == 1

    async def test_carries_the_pace_because_that_is_what_decides_what_to_do_about_it(self, b: Book) -> None:
        self.held(b, "condor", b.days_from_now(-24), 21)
        await b.sweeper(quoting("mid_price", {self.leg(b, 21): 4.4})).sweep()
        # Entry 6.86 opened at 45 DTE, now 21: on-pace 4.69, and 4.40 is ahead of it
        assert "4.69" in self.notices(b)[0]
        assert "ahead" in self.notices(b)[0].lower()

    async def test_tries_again_next_sweep_when_the_notice_could_not_be_delivered(self, b: Book) -> None:
        # ADR 0011: "Manage-by raises exactly one notice." A send that throws must leave the deadline
        # un-stamped, or that one notice is zero notices — for ever, since the stamp is what stops it
        # being raised again.
        id_ = self.held(b, "condor", b.days_from_now(-24), 21)
        fetch = quoting("mid_price", {self.leg(b, 21): 4.4})
        down = True

        def flaky(text: str) -> None:
            if down:
                raise RuntimeError("telegram down")
            b.sent.append(text)

        await b.sweeper(fetch, send=flaky).sweep()
        assert len(self.notices(b)) == 0, "nothing reached the phone"
        assert self.notified_at(b, id_) is None, "so the deadline must still be owed"

        down = False
        await b.sweeper(fetch, send=flaky).sweep()
        assert len(self.notices(b)) == 1, "the next sweep delivers it"
        assert self.notified_at(b, id_)

    async def test_stamps_the_deadline_when_telegram_is_not_configured_rather_than_owing_it_for_ever(
        self, b: Book
    ) -> None:
        # "not configured" is not a failure to retry: there is nowhere to deliver, and a notice held
        # open would be reconsidered every 15 seconds for ever, logging the same line each time
        id_ = self.held(b, "condor", b.days_from_now(-24), 21)
        fetch = quoting("mid_price", {self.leg(b, 21): 4.4})
        await b.sweeper(fetch, telegram_bot_token="", telegram_chat_id="").sweep()
        assert len(self.notices(b)) == 0
        assert self.notified_at(b, id_)

    # #380: the notice goes ONCE, so a sweep with no Cost to close to say holds it rather than sending
    # it without its "now" line for good. A delta still arrives, and the day's row is kept for it with an
    # empty cost — which values nothing.
    def priceless(self, b: Book, dte: int) -> FakeProvider:
        return quoting("option_delta", {self.leg(b, dte): 0.2})

    @staticmethod
    def close_row(b: Book, id_: str, observed_on: str, observed_at: str, cost: float | None, dte: int) -> None:
        b.db.execute(
            """insert into position_samples (position_id, observed_on, dte, cost_to_close, observed_at, contract_size)
       values (?, ?, ?, ?, ?, 100)""",
            (id_, observed_on, dte, cost, observed_at),
        )

    async def test_waits_for_a_cost_a_sweep_that_prices_nothing_sends_nothing_and_stamps_nothing(self, b: Book) -> None:
        id_ = self.held(b, "condor", b.days_from_now(-24), 21)
        await b.sweeper(self.priceless(b, 21)).sweep()
        assert self.notices(b) == [], "no cost to say, and no close to say it from"
        assert self.notified_at(b, id_) is None, "so it is still owed"

        await b.sweeper(quoting("mid_price", {self.leg(b, 21): 4.4})).sweep()
        assert len(self.notices(b)) == 1
        assert "now 4.40" in self.notices(b)[0]
        assert self.notified_at(b, id_)

    async def test_out_of_hours_with_no_price_says_the_latest_close_s_cost_and_day_paced_at_its_dte(
        self, b: Book
    ) -> None:
        # 01:00 New York on Thursday 1 October: yesterday's close, observed at 16:14 (20:14 UTC, EDT)
        id_ = self.held(b, "condor", b.days_from_now(-24), 21)
        self.close_row(b, id_, "2026-09-30", "2026-09-30 20:14:59.000000", 4.4, 22)
        await b.sweeper(self.priceless(b, 21)).sweep()
        assert len(self.notices(b)) == 1
        assert "entry 6.86 · 4.40 at the 2026-09-30 close" in self.notices(b)[0]
        # on-pace at the close's own 22 DTE (opened at 45): 6.86 × √(22/45) = 4.80, and 4.40 is ahead
        assert "on-pace 4.80 — ahead by 0.40" in self.notices(b)[0]
        assert self.notified_at(b, id_)

    async def test_in_the_session_with_no_price_holds_it_whatever_close_is_stored(self, b: Book) -> None:
        b.now = datetime(2026, 10, 1, 15, 0, tzinfo=UTC)  # 11:00 New York, Thursday
        id_ = self.held(b, "condor", b.days_from_now(-24), 21)
        self.close_row(b, id_, "2026-09-30", "2026-09-30 20:14:59.000000", 4.4, 22)
        await b.sweeper(self.priceless(b, 21)).sweep()
        assert self.notices(b) == []
        assert self.notified_at(b, id_) is None

    async def test_does_not_stop_the_sweep_nor_the_alarms_if_the_notice_fails(self, b: Book) -> None:
        self.held(b, "condor", b.days_from_now(-24), 21)
        b.monitor(threshold=0.05, strike_date=b.days_from_now(21))

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [{"code": c, "name": c, "option_delta": 0.9, "mid_price": 4.4} for c in codes]

        # unconfigured: the send is a no-op
        s = b.sweeper(fetch, telegram_bot_token="", telegram_chat_id="")
        await s.sweep()
        assert s.health.last_sweep_ok() is True


class TestWhatOnlyThePythonCanGetWrong:
    async def test_says_the_whole_notice_with_javascripts_numbers(self, b: Book) -> None:
        # `entry ${row.entry}` is String(6.86), and every figure after it is toFixed(2): half away from
        # zero on the exact binary value, two decimals always
        self.held_condor(b)
        await b.sweeper(quoting("mid_price", {build_spx_code(b.days_from_now(21), "CALL", 8050): 4.4})).sweep()
        assert b.sent == ["⏰ condor is at 21 DTE — manage by 21\nentry 6.86 · now 4.40\non-pace 4.69 — ahead by 0.29"]

    async def test_writes_an_entry_with_no_fraction_as_javascript_does(self, b: Book) -> None:
        # a REAL column answers 2.0 in Python, and `String(2)` is "2"
        self.held_condor(b, entry=2.0)
        await b.sweeper(quoting("mid_price", {build_spx_code(b.days_from_now(21), "CALL", 8050): 1.5})).sweep()
        assert b.sent[0].startswith("⏰ condor is at 21 DTE — manage by 21\nentry 2 · now 1.50\non-pace")

    async def test_stores_the_iv_map_as_json_stringify_writes_it(self, b: Book) -> None:
        # the sampler tells a changed row by comparing this TEXT, and the other backend writes the same
        # file: 22.0 must be stored as JSON.stringify's `22`, never Python's `22.0`
        b.now = datetime(2026, 10, 1, 15, 0, tzinfo=UTC)  # inside the sample hours, so it writes
        id_ = b.held("held")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {"code": c, "name": c, "mid_price": 5.0 if c == b.sold() else 1.0, "option_implied_volatility": 22.0}
                for c in codes
            ]

        await b.sweeper(fetch).sweep()
        stored = b.column("select legs_iv from position_samples where position_id = ?", id_)
        assert stored == f'{{"{b.sold()}":22,"{b.bought()}":22}}'

    async def test_logs_a_failed_sample_with_its_stack(self, b: Book, caplog: pytest.LogCaptureFixture) -> None:
        b.now = datetime(2026, 10, 1, 15, 0, tzinfo=UTC)  # inside the sample hours, so it tries
        b.held("held")
        b.db.execute("DROP TABLE position_samples")
        with caplog.at_level(logging.ERROR, logger=LOG):
            await b.sweeper(b.spread(5.0, 1.0)).sweep()
        [record] = [r for r in caplog.records if r.name == LOG]
        assert record.getMessage() == "recording a sample for held failed:"
        assert record.exc_info is not None

    @staticmethod
    def held_condor(b: Book, entry: float = 6.86) -> None:
        b.db.execute(
            """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                              opened_at, manage_notified_at)
       values (?, 'condor', null, ?, 1, ?, ?, '2026-08-01 00:00:00.000000', ?, null)""",
            (
                "condor".ljust(32, "0"),
                b.days_from_now(21),
                entry,
                to_sqlite_json([{"side": "short", "option_type": "CALL", "strike": 8050}]),
                b.days_from_now(-24),
            ),
        )
