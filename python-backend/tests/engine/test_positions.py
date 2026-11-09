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
from harness import FakeFetch, fake_fetcher
from optionality.contract import build_spx_code
from sweep import SINGLE_CODE as CODE
from sweep import SWEEP_SETTINGS, insert_monitor, quoting

from optionality_backend.db.open import create_database
from optionality_backend.db.values import to_sqlite_json
from optionality_backend.engine import MonitorSweeper, SweeperDeps
from optionality_backend.env import settings_for
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

    def sweeper(self, fetch: FakeFetch, send: NotifySender | None = None, **over: Any) -> MonitorSweeper:
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

    def spread(self, sold: float, bought: float) -> FakeFetch:
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

    async def test_keys_the_day_where_the_option_trades_not_where_utc_is(self, b: Book) -> None:
        # for the hours New York is behind UTC the two dates differ, and `dte` beside it is reckoned
        # from the market date. A sample keyed on the UTC day would pair a New York Wednesday with a
        # Thursday's DTE.
        b.now = datetime(2026, 10, 1, 2, 0, tzinfo=UTC)  # 22:00 on 2026-09-30 in New York
        b.held("held")
        await b.sweeper(b.spread(5.0, 1.0)).sweep()

        assert b.samples()[0]["observed_on"] == "2026-09-30"
        assert b.now.date().isoformat() == "2026-10-01"  # and the UTC day is not that

    async def test_records_a_position_whose_opened_nobody_has_entered_yet(self, b: Book) -> None:
        # the sample is raw: (DTE, Cost to close) means something without an Opened, and filling the
        # Opened in later makes the history it already collected interpretable
        b.held("unopened")
        await b.sweeper(b.spread(5.0, 1.0)).sweep()
        assert len(b.samples()) == 1
        assert b.column("select opened_at from positions") is None

    async def test_skips_a_position_it_could_not_price_quietly(self, b: Book, caplog: pytest.LogCaptureFixture) -> None:
        # one unpriced leg and the Cost to close is unknown, not zero — the same all-or-nothing rule
        # the dashboard holds to. The silence is the half worth asserting: the column is NOT NULL and
        # the write is guarded, so dropping the guard still records nothing — it just logs a failure
        # for every unpriced Position on every sweep, for ever.
        b.held("held")

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [{"code": c, "name": c, "mid_price": 5.0} for c in codes if c != b.bought()]

        with caplog.at_level(logging.ERROR):
            await b.sweeper(fetch).sweep()
        assert b.samples() == []
        errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert errors == [], f"an unpriced Position should be silent, not logged: {errors}"

    async def test_stops_recording_once_a_position_has_expired(self, b: Book) -> None:
        b.held("gone", strike_date=b.past())
        await b.sweeper(b.spread(5.0, 1.0)).sweep()
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


class TestHowOftenTheSamplerActuallyWrites:
    """It wrote on every sweep — 5,760 times a day at a 15-second interval, to persist ONE row, and
    overnight almost every one of those stored a value identical to what was already there. The live
    file carried a 3.1MB write-ahead log against a 110KB database because of it."""

    @staticmethod
    def quiet(b: Book, mid: float, iv: float, vega: float = 1.0) -> FakeFetch:
        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {
                    "code": c,
                    "name": c,
                    "mid_price": mid if c == b.sold() else 1.0,
                    "option_implied_volatility": iv,
                    "option_vega": vega,
                }
                for c in codes
            ]

        return fetch

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
