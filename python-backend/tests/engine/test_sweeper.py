"""The alarm engine. Port of backend/src/engine/sweeper.test.ts.

One test for each of the TypeScript's, under the same describes, driving `MonitorSweeper.sweep()` on
a real database with a fake Provider and a collecting sender — `tests/sweep.py` holds the rows and
the fetcher, shared with `test_positions.py`, which drives this same sweep for what it does to
HOLDINGS. "the watchdog" and "a sweep that never came back" read the health account through
`s.health` after a real sweep; `test_health.py` held them against a sweep it imitated until this
module was ported, and keeps only what no sweep can show.

What only the Python can get wrong is at the end.
"""

import asyncio
import json
import logging
import re
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, ClassVar

import pytest
from harness import FakeProvider, fake_fetcher
from optionality.contract import build_spx_code
from optionality.quote import Batch
from sweep import SINGLE_CODE as CODE
from sweep import SWEEP_SETTINGS as BASE
from sweep import MonitorState, insert_combo, insert_monitor, monitor_state, quoting

from optionality_backend.db.open import create_database
from optionality_backend.db.queries import find_monitor, update_monitor_fields
from optionality_backend.db.time import to_sql_datetime
from optionality_backend.db.values import to_sqlite_json
from optionality_backend.engine.health import STALE_AFTER_SWEEPS
from optionality_backend.engine.sweeper import MonitorSweeper, SweeperDeps
from optionality_backend.env import settings_for
from optionality_backend.monitors import edited_monitor
from optionality_backend.notify import NotifySender
from optionality_backend.ports import AlarmState

LOG = "optionality_backend.engine.sweeper"

#: A contract the Provider cannot price. How it SAYS so is its own business and is tested with the
#: vendor; what reaches the sweep is the code, named in the batch (#168).
POISON = "US.SPXW260918C99999000"

#: The live sweep cadence (`MONITOR_INTERVAL_SECONDS` in .env), in seconds.
#:
#: Tests about a window of TIME sweep at this, rather than jumping the clock once: a window is ~120
#: sweeps wide at the live cadence, and the two that matter below are only ever crossed correctly if
#: nothing a sweep does to the alarm stamp depends on there having been few of them.
CADENCE = 15


class Sweeps:
    """The suite's `beforeEach`: a fresh database, the clock, and what was sent — and the builders
    that close over them, as the TypeScript's module-level helpers do."""

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

    def monitor(self, **over: Any) -> str:
        return insert_monitor(self.db, **{"strike_date": self.future(), **over})

    def combo(self, **over: Any) -> str:
        return insert_combo(self.db, **{"strike_date": self.future(), **over})

    def sweeper(self, fetch: FakeProvider, send: NotifySender | None = None, **over: Any) -> MonitorSweeper:
        """`send` is overridden only where the test is about a send that FAILS, which a collecting
        fake cannot do."""
        return MonitorSweeper(
            SweeperDeps(
                db=self.db,
                settings=settings_for(**{**BASE, **over}),
                fetch_quotes=fake_fetcher(fetch),
                send=send or self.sent.append,
                now=lambda: self.now,
            )
        )

    async def tick(self, s: MonitorSweeper) -> None:
        """One sweep, a cadence later. The clock MOVES between sweeps, as the scheduler makes it."""
        self.now += timedelta(seconds=CADENCE)
        await s.sweep()

    async def sweep_for(self, s: MonitorSweeper, seconds: int) -> None:
        """Sweep at the live cadence for `seconds` of wall clock — the sweeps a window actually holds."""
        for _ in range(0, seconds, CADENCE):
            await self.tick(s)

    def row(self, id_: str) -> MonitorState:
        found = monitor_state(self.db, id_)
        assert found is not None, f"monitor {id_} is gone"
        return found

    def said(self, words: str) -> list[str]:
        return [t for t in self.sent if words in t]


@pytest.fixture
def t(tmp_path: Path):
    world = Sweeps(tmp_path)
    yield world
    world.db.close()


def failing_while(down: Callable[[], bool], message: str = "Client connection failed!") -> FakeProvider:
    """A Provider that rejects the batch while `down()` says so, and otherwise prices every code."""

    def fetch(codes: list[str]) -> list[dict[str, Any]]:
        if down():
            raise RuntimeError(message)
        return [{"code": c, "name": c, "option_delta": 0.1} for c in codes]

    return fetch


def nothing(codes: list[str]) -> list[dict[str, Any]]:
    return []


class TestABreach:
    async def test_fires_once_and_records_the_value(self, t: Sweeps) -> None:
        id_ = t.monitor()
        s = t.sweeper(quoting("option_delta", {CODE: 0.7}))
        await s.sweep()
        await s.sweep()  # still breached: edge-triggered, no second alarm

        assert len(t.sent) == 1
        assert "0.700" in t.sent[0]
        m = t.row(id_)
        assert m["triggered"] == 1
        assert m["last_value"] == 0.7
        assert m["last_checked_at"] is not None

    async def test_compares_magnitude_in_abs_mode_so_a_puts_negative_delta_still_fires(self, t: Sweeps) -> None:
        put = "US.SPXW261218P6425000"
        t.monitor(code=put, option_type="PUT", strike=6425)
        await t.sweeper(quoting("option_delta", {put: -0.7})).sweep()
        assert len(t.sent) == 1

    async def test_clears_and_re_arms_across_the_exact_threshold(self, t: Sweeps) -> None:
        id_ = t.monitor(threshold=0.6)
        values = {CODE: 0.61}
        s = t.sweeper(quoting("option_delta", values))

        await s.sweep()
        assert len(t.sent) == 1

        values[CODE] = 0.59
        await s.sweep()  # back across: bell clears, recovery message
        assert len(t.sent) == 2
        assert "back below" in t.sent[1]
        assert t.row(id_)["triggered"] == 0

        # the threshold EXACTLY, which is what this case is named for: the bell flips truthfully AT
        # it, with no value hysteresis (CLAUDE.md)
        values[CODE] = 0.6
        await s.sweep()  # re-armed, and 0.60 >= 0.60: fires again
        assert len(t.sent) == 3
        assert t.row(id_)["triggered"] == 1
        assert t.row(id_)["last_value"] == 0.6

    async def test_works_downward_too_for_a_profit_target(self, t: Sweeps) -> None:
        t.monitor(direction="below", threshold=30.0, field="mid_price")
        values = {CODE: 26.4}
        s = t.sweeper(quoting("mid_price", values))

        await s.sweep()  # 26.4 <= 30
        assert len(t.sent) == 1
        assert "fell" in t.sent[0]

        values[CODE] = 30.5
        await s.sweep()
        assert len(t.sent) == 2
        assert "back above" in t.sent[1]

        values[CODE] = 26.0
        await s.sweep()
        assert len(t.sent) == 3

    async def test_takes_a_negative_threshold_in_signed_mode_in_the_owners_own_signs(self, t: Sweeps) -> None:
        # a long bear call spread: the value is negative; alert when it falls to <= -4.05
        id_ = t.combo(threshold=-4.05, direction="below", compare="signed")
        a = build_spx_code(t.future(), "CALL", 8100)
        b = build_spx_code(t.future(), "CALL", 8150)
        values = {a: 26.4, b: 30.3}
        s = t.sweeper(quoting("mid_price", values))

        await s.sweep()  # +26.4 - 30.3 = -3.9: above -4.05, no breach
        assert t.sent == []

        values[b] = 30.7
        await s.sweep()  # -4.3 <= -4.05
        assert len(t.sent) == 1
        assert "-4.300" in t.sent[0]

        values[b] = 30.35
        await s.sweep()  # -3.95 back above
        assert len(t.sent) == 2
        assert t.row(id_)["triggered"] == 0


class TestAnEditedRule:
    """#292."""

    async def test_says_it_crossed_when_a_ringing_rule_is_edited_onto_a_figure_already_past_the_new_threshold(
        self, t: Sweeps
    ) -> None:
        # ringing on its delta, then edited to watch its mid >= 4 while the mid is 5: a new rule,
        # breached from its first sweep, so the owner is told — the old rule's bell must not swallow it
        id_ = t.monitor()
        await t.sweeper(quoting("option_delta", {CODE: 0.7})).sweep()
        assert len(t.sent) == 1
        row = find_monitor(t.db, id_)
        assert row is not None
        update_monitor_fields(t.db, id_, edited_monitor(row, {"field": "mid_price", "threshold": 4}))
        await t.tick(t.sweeper(quoting("mid_price", {CODE: 5})))
        assert len(t.sent) == 2
        assert "crossed ≥" in t.sent[1]

    async def test_says_nothing_when_a_ringing_rule_is_edited_onto_a_rule_that_never_breached(self, t: Sweeps) -> None:
        id_ = t.monitor()
        await t.sweeper(quoting("option_delta", {CODE: 0.7})).sweep()
        row = find_monitor(t.db, id_)
        assert row is not None
        update_monitor_fields(t.db, id_, edited_monitor(row, {"field": "mid_price", "threshold": 30}))
        await t.tick(t.sweeper(quoting("mid_price", {CODE: 5})))
        # not "back below 30" about a rule that was never above it
        assert len(t.sent) == 1


class TestHowOftenItSpeaks:
    async def test_keeps_the_bell_truthful_while_the_cooldown_holds_the_message(self, t: Sweeps) -> None:
        id_ = t.monitor(threshold=0.6)
        values = {CODE: 0.61}
        s = t.sweeper(quoting("option_delta", values), alarm_cooldown_seconds=120, monitor_interval_seconds=CADENCE)

        await s.sweep()
        assert len(t.sent) == 1

        values[CODE] = 0.59
        await t.tick(s)  # bell clears, recovery suppressed by the cooldown
        assert t.row(id_)["triggered"] == 0  # the display stays truthful
        assert len(t.sent) == 1

        values[CODE] = 0.61
        await t.tick(s)  # re-breach inside the cooldown: bell on, still silent
        assert t.row(id_)["triggered"] == 1
        assert len(t.sent) == 1

        # and the cooldown is counted from the last MESSAGE, not from the last sweep. The sweeps in
        # between are what makes that visible: they say nothing, so they must not move the stamp
        # either (mutation sweep, 2026-11-09).
        await t.sweep_for(s, 75)  # steady above the threshold: nothing to say
        assert len(t.sent) == 1

        values[CODE] = 0.55
        await t.tick(s)  # 120s since the alarm, to the second: the cooldown is up
        assert len(t.sent) == 2
        assert "back below" in t.sent[1]

    async def test_re_reminds_while_a_breach_persists_on_a_fixed_cadence(self, t: Sweeps) -> None:
        # AT THE LIVE CADENCE, and that is the point of the test rather than a detail of it. A
        # half-hour window holds about 120 sweeps, and the reminder is due only because none of them
        # touched `last_alarm_at` — the stamp is the record of having SPOKEN (mutation sweep,
        # 2026-11-09).
        t.monitor(threshold=0.6)
        values = {CODE: 0.7}
        s = t.sweeper(quoting("option_delta", values), alarm_repeat_seconds=1800, monitor_interval_seconds=CADENCE)

        await s.sweep()
        assert len(t.sent) == 1  # the edge alarm

        await t.sweep_for(s, 1500)  # 100 sweeps, all inside the repeat window: silent
        assert len(t.sent) == 1

        await t.sweep_for(s, 360)  # the window is up somewhere in here
        assert len(t.sent) == 2
        assert "still" in t.sent[1]
        assert "reminder" in t.sent[1]

        await t.sweep_for(s, 1500)  # the reminder reset the window, and these do not
        assert len(t.sent) == 2

        values[CODE] = 0.5
        await t.tick(s)
        assert len(t.sent) == 3
        assert "back below" in t.sent[2]

    async def test_sends_no_reminders_at_all_when_the_cadence_is_zero(self, t: Sweeps) -> None:
        t.monitor(threshold=0.6)
        s = t.sweeper(quoting("option_delta", {CODE: 0.7}), alarm_repeat_seconds=0)
        await s.sweep()
        t.now += timedelta(days=1)
        await s.sweep()
        assert len(t.sent) == 1  # the edge alarm only

    async def test_reads_the_stored_last_alarm_at_not_an_in_memory_copy(self, t: Sweeps) -> None:
        # the cooldown has to survive a restart: the figure lives in the row, and a sweeper that kept
        # it in memory would speak again on every deploy
        id_ = t.monitor(threshold=0.6)
        s = t.sweeper(quoting("option_delta", {CODE: 0.7}), alarm_cooldown_seconds=120)
        t.db.execute(
            "update monitors set last_alarm_at = ? where id = ?",
            (to_sql_datetime(t.now - timedelta(seconds=10)), id_),
        )
        await s.sweep()
        assert t.sent == []  # 10 seconds ago, inside the 120-second cooldown
        assert t.row(id_)["triggered"] == 1

    async def test_says_nothing_at_all_when_telegram_is_not_configured(self, t: Sweeps) -> None:
        id_ = t.monitor()
        s = t.sweeper(quoting("option_delta", {CODE: 0.9}), telegram_bot_token="", telegram_chat_id="")
        await s.sweep()
        assert t.sent == []
        assert t.row(id_)["triggered"] == 1  # the state is still tracked

    async def test_survives_a_sender_that_throws(self, t: Sweeps) -> None:
        # a broken notifier must not stop the alarm engine recording what it saw
        def send(text: str) -> None:
            raise RuntimeError("telegram is down")

        id_ = t.monitor()
        s = t.sweeper(quoting("option_delta", {CODE: 0.9}), send=send)
        await s.sweep()
        assert t.row(id_)["triggered"] == 1
        assert s.health.last_sweep_ok() is True


class TestAValueItCannotRead:
    async def test_skips_a_monitor_whose_field_is_absent_rather_than_crashing(self, t: Sweeps) -> None:
        id_ = t.monitor(field="option_vega")
        await t.sweeper(quoting("option_delta", {CODE: 0.9})).sweep()
        assert t.sent == []
        assert t.row(id_)["last_value"] is None

    async def test_skips_a_combo_with_any_leg_missing_no_partial_sums_ever(self, t: Sweeps) -> None:
        id_ = t.combo()
        a = build_spx_code(t.future(), "CALL", 8100)
        await t.sweeper(quoting("mid_price", {a: 26.4})).sweep()
        assert t.sent == []
        m = t.row(id_)
        assert m["last_value"] is None
        assert m["triggered"] == 0

    async def test_evaluates_a_combo_as_a_signed_sum_with_both_legs_in_one_call(self, t: Sweeps) -> None:
        id_ = t.combo()
        a = build_spx_code(t.future(), "CALL", 8100)
        b = build_spx_code(t.future(), "CALL", 8150)
        calls: list[list[str]] = []

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            calls.append(sorted(codes))
            return [{"code": a, "mid_price": 26.4}, {"code": b, "mid_price": 19.25}]

        await t.sweeper(fetch).sweep()

        assert len(calls) == 1
        assert calls[0] == sorted([a, b])
        assert len(t.sent) == 1  # 26.4 - 19.25 = 7.15 <= 10
        assert "sep-condor" in t.sent[0]
        assert "7.150" in t.sent[0]
        m = t.row(id_)
        assert m["triggered"] == 1
        # vitest's toBeCloseTo(7.15, 10): within half of 1e-10
        assert m["last_value"] == pytest.approx(7.15, abs=0.5e-10)


def no_book(codes: list[str]) -> list[dict[str, Any]]:
    """What moomoo answers for every option out of hours (#380): bid 0 / ask 0, so the mapping derives
    no mid (`quote.mid_price`), and the greeks regardless."""
    return [{"code": c, "name": c, "bid_price": 0, "ask_price": 0, "option_delta": 0.1} for c in codes]


class TestAPriceWithNoBook:
    @staticmethod
    def ringing(t: Sweeps, id_: str, value: float) -> None:
        update_monitor_fields(
            t.db,
            id_,
            {
                "triggered": 1,
                "last_value": value,
                "last_checked_at": "2026-09-30 20:14:59.000000",
                "last_alarm_at": "2026-09-30 19:00:00.000000",
            },
        )

    async def test_neither_clears_a_ringing_above_rule_nor_says_anything_and_keeps_its_figure(self, t: Sweeps) -> None:
        # a 0 is never above anything: read as a price, every evening said "back below"
        id_ = t.combo(direction="above", threshold=5)
        self.ringing(t, id_, 6.2)
        before = t.row(id_)
        await t.sweeper(no_book, alarm_repeat_seconds=60).sweep()
        assert t.sent == []
        assert t.row(id_) == before

    async def test_neither_rings_a_below_rule_nor_reminds_one_already_ringing(self, t: Sweeps) -> None:
        # a 0 is below everything: read as a price, a profit target rang every evening
        quiet = t.combo(code="quiet", direction="below", threshold=3)
        loud = t.combo(
            code="loud",
            direction="below",
            threshold=3,
            legs=[
                {"sign": 1, "option_type": "CALL", "strike": 8200},
                {"sign": -1, "option_type": "CALL", "strike": 8250},
            ],
        )
        self.ringing(t, loud, 2.5)
        q, l_ = t.row(quiet), t.row(loud)
        await t.sweeper(no_book, alarm_repeat_seconds=1).sweep()
        assert t.sent == []
        assert t.row(quiet) == q
        assert t.row(loud) == l_

    async def test_is_not_evaluated_with_one_leg_quoted_and_the_other_not_as_at_the_open(self, t: Sweeps) -> None:
        # the sum of a real mid and a 0 read as one leg's whole price, and rang an above rule
        id_ = t.combo(direction="above", threshold=5)
        a = build_spx_code(t.future(), "CALL", 8100)

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {"code": c, "bid_price": 26.2, "ask_price": 26.6, "mid_price": 26.4}
                if c == a
                else {"code": c, "bid_price": 0, "ask_price": 0}
                for c in codes
            ]

        await t.sweeper(fetch).sweep()
        assert t.sent == []
        assert t.row(id_)["triggered"] == 0
        assert t.row(id_)["last_value"] is None

    async def test_is_held_not_counted_toward_quarantine_however_long_the_book_stays_empty(self, t: Sweeps) -> None:
        id_ = t.combo()
        s = t.sweeper(no_book, quarantine_after_silent_sweeps=1)
        await s.sweep()
        await t.tick(s)
        assert t.row(id_)["enabled"] == 1
        assert t.sent == []
        assert id_ not in s.silent_sweeps, "a held rule has no run of silence"

    async def test_ends_a_run_of_silence_a_held_sweep_between_two_silent_ones_starts_the_count_again(
        self, t: Sweeps
    ) -> None:
        # the run counts CONSECUTIVE sweeps with no figure, and a held sweep is an answer: kept from
        # before the hold, the count would reach the limit here and quarantine the rule
        id_ = t.combo()
        a = build_spx_code(t.future(), "CALL", 8100)
        state = {"held": False}

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [{"code": c, "name": c, "bid_price": 0, "ask_price": 0} for c in codes if state["held"] or c == a]

        s = t.sweeper(fetch, quarantine_after_silent_sweeps=3)
        await s.sweep()
        await t.tick(s)  # two silent sweeps: one short of the limit
        assert s.silent_sweeps.get(id_) == 2
        state["held"] = True
        await t.tick(s)  # every leg back, one with no book: held
        state["held"] = False
        await t.tick(s)  # the leg missing again: the first of a new run
        assert t.row(id_)["enabled"] == 1
        assert s.silent_sweeps.get(id_) == 1
        assert t.sent == []

    async def test_still_counts_a_leg_the_provider_did_not_return_at_all(self, t: Sweeps) -> None:
        id_ = t.combo()
        a = build_spx_code(t.future(), "CALL", 8100)

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            return [{"code": c, "bid_price": 0, "ask_price": 0} for c in codes if c == a]

        await t.sweeper(fetch, quarantine_after_silent_sweeps=1).sweep()
        assert t.row(id_)["enabled"] == 0
        assert t.row(id_)["disabled_reason"] == "no-figure"

    async def test_still_counts_a_missing_figure_on_any_other_field(self, t: Sweeps) -> None:
        id_ = t.monitor(field="option_vega")
        await t.sweeper(no_book, quarantine_after_silent_sweeps=1).sweep()
        assert t.row(id_)["enabled"] == 0


class TestTheExpiryLifecycle:
    async def test_mutes_an_expired_monitor_with_a_notice_and_stops_fetching_it(self, t: Sweeps) -> None:
        id_ = t.monitor(strike_date=t.past())
        calls: list[list[str]] = []

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            calls.append(codes)
            return []

        s = t.sweeper(fetch)
        await s.sweep()

        assert calls == []  # nothing active -> no API call at all
        m = t.row(id_)
        assert m["enabled"] == 0
        # a vanished contract and a monitor you muted on purpose are otherwise identical rows
        assert m["disabled_reason"] == "expired"
        assert any("expired" in x and "muted" in x for x in t.sent)
        # and a sweep with nothing to fetch is a sweep that SUCCEEDED. Everything expiring on one
        # Friday is this sweep, so without the success an empty watchlist never clears the
        # consecutive-failure count, never sends the recovered notice, and leaves /health reading
        # "starting" for ever (mutation sweep, 2026-11-09).
        assert s.health.last_sweep_ok() is True
        assert s.health.alarm_state() == AlarmState(label="active", bad=False)

    async def test_is_still_watching_on_the_expiry_day_itself_and_still_fetches_it(self, t: Sweeps) -> None:
        # WHICH date the sweep reckons expiry against. `expiry_verdict`'s own boundary is
        # golden-cased, but nothing pinned the `today` the sweep hands it: a one-day drift in
        # `_utc_date` muted a monitor on its own expiry day — the day its figures matter most
        # (mutation sweep, 2026-11-09).
        id_ = t.monitor(strike_date=t.days_from_now(0))
        calls: list[list[str]] = []

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            calls.append(codes)
            return [{"code": c, "name": c, "option_delta": 0.1} for c in codes]

        await t.sweeper(fetch).sweep()

        assert calls == [[CODE]]
        m = t.row(id_)
        assert m["enabled"] == 1
        assert m["disabled_reason"] is None
        assert t.sent == []  # nothing expired, so nothing to say

    async def test_says_it_once_not_on_every_sweep_inside_the_grace_period(self, t: Sweeps) -> None:
        id_ = t.monitor(strike_date=t.past())
        s = t.sweeper(nothing)
        await s.sweep()
        await s.sweep()
        assert len(t.said("expired")) == 1
        assert monitor_state(t.db, id_)

    async def test_deletes_it_quietly_once_it_is_past_the_grace_period(self, t: Sweeps) -> None:
        fresh = t.monitor(strike_date=t.past())
        ancient = t.monitor(code="US.SPXW250101C5000000", strike_date=t.days_from_now(-10))
        await t.sweeper(nothing).sweep()
        assert monitor_state(t.db, ancient) is None  # beyond the 7-day grace
        assert monitor_state(t.db, fresh)  # yesterday's is still within it

    async def test_deletes_immediately_when_the_retention_window_is_zero_with_a_notice(self, t: Sweeps) -> None:
        id_ = t.monitor(strike_date=t.past())
        await t.sweeper(nothing, expired_retention_days=0).sweep()
        assert monitor_state(t.db, id_) is None
        # the retention=0 path never gets the muted notice, so it says "removed" instead
        assert any("expired" in x and "removed" in x for x in t.sent)

    async def test_takes_the_position_links_with_it_and_leaves_the_position(self, t: Sweeps) -> None:
        # deleting a linked monitor raises FOREIGN KEY constraint failed — inside the sweep, every
        # minute, so the alarm engine stops altogether. The Python had this fault until writing the
        # TypeScript port found it (#81). Every monitor in the live database is linked.
        pid = "p" * 32
        t.db.execute(
            """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values (?, 'held', 'credit_spread', ?, 1, 2.0, ?, '2026-08-01 00:00:00.000000')""",
            (pid, t.days_from_now(-30), to_sqlite_json([{"side": "short", "option_type": "CALL", "strike": 8050}])),
        )
        id_ = t.monitor(strike_date=t.days_from_now(-30), scope="all", enabled=0, disabled_reason="expired")
        t.db.execute("insert into monitor_positions values (?, ?)", (id_, pid))

        await t.sweeper(nothing).sweep()

        assert monitor_state(t.db, id_) is None
        assert t.db.execute("select count(*) from monitor_positions").fetchone()[0] == 0
        # the Position stays: it is a holding, and it exists whether or not anything watches it
        assert t.db.execute("select name from positions where id = ?", (pid,)).fetchone()[0] == "held"


class TestAnUnknownContract:
    @staticmethod
    def poisonable(good_value: float = 0.7) -> FakeProvider:
        """Reports the poison as unknown rather than rejecting the batch: the drop-and-retry that read
        moomoo's sentence is inside the moomoo client, and the sweep is handed the answer (#168)."""

        def fetch(codes: list[str]) -> Batch:
            return Batch(
                records=[{"code": c, "name": c, "option_delta": good_value} for c in codes if c != POISON],
                unknown=[c for c in codes if c == POISON],
            )

        return fetch

    async def test_is_quarantined_not_deleted_and_the_rest_of_the_sweep_still_alarms(self, t: Sweeps) -> None:
        good = t.monitor(threshold=0.6)
        poison = t.monitor(code=POISON, strike=99999)
        s = t.sweeper(self.poisonable())
        await s.sweep()

        assert t.row(poison)["enabled"] == 0
        # a vanished contract and a monitor you muted on purpose are otherwise identical rows
        assert t.row(poison)["disabled_reason"] == "unknown-contract"
        assert t.row(good)["triggered"] == 1  # evaluated in the same sweep
        assert len(t.said("disabled")) == 1
        assert POISON in t.said("disabled")[0]
        assert len(t.said("crossed")) == 1
        # containment: this is not a sweep failure
        assert s.health.last_sweep_ok() is True


class TestTheWatchdog:
    async def test_reports_degraded_once_at_the_threshold_and_recovers(self, t: Sweeps) -> None:
        t.monitor()
        failing = True
        s = t.sweeper(failing_while(lambda: failing))
        limit = settings_for(**BASE).degraded_after_failures

        for _ in range(limit + 1):
            await s.sweep()
        # edge-triggered, not once per failure
        assert len(t.said("degraded")) == 1
        assert s.health.consecutive_failures() == limit + 1
        assert s.health.last_sweep_ok() is False

        failing = False
        await s.sweep()
        assert t.said("recovered")
        assert s.health.consecutive_failures() == 0
        assert s.health.last_sweep_ok() is True

    async def test_keeps_saying_so_while_it_is_still_broken_and_says_how_long(self, t: Sweeps) -> None:
        # The gap this closes, measured: on 2026-11-08 OpenD exited and 646 sweeps failed over 2h42m,
        # and the owner got ONE message, in the first minute. The notice was right; the silence after
        # it meant the engine knew something the owner no longer did.
        t.monitor()
        failing = True
        s = t.sweeper(failing_while(lambda: failing))
        limit = settings_for(**BASE).degraded_after_failures
        started = t.now

        for _ in range(limit):
            await s.sweep()
        assert len(t.said("degraded")) == 1
        assert "⚠️ monitoring degraded:" in t.sent[0]

        # half an hour of failing sweeps: the reminder is due by the CLOCK, so time has to move
        t.now = started + timedelta(milliseconds=1_799_000)
        await s.sweep()
        assert len(t.said("degraded")) == 1

        t.now = started + timedelta(milliseconds=1_801_000)
        await s.sweep()
        reminders = t.said("still degraded")
        assert len(reminders) == 1
        assert "over 30m" in reminders[0]

        # and not again until the next interval
        t.now = started + timedelta(milliseconds=1_900_000)
        await s.sweep()
        assert len(t.said("still degraded")) == 1

        failing = False
        t.now = started + timedelta(milliseconds=9_720_000)
        await s.sweep()
        assert t.said("recovered")[0] == "✅ monitoring recovered after 2h42m"

    async def test_starts_a_new_outage_cleanly_rather_than_reporting_the_last_ones_age(self, t: Sweeps) -> None:
        # the stamps are cleared on recovery, so a second outage an hour later does not claim to have
        # been broken since the first one
        t.monitor()
        failing = True
        s = t.sweeper(failing_while(lambda: failing, "down"))
        limit = settings_for(**BASE).degraded_after_failures
        started = t.now

        for _ in range(limit):
            await s.sweep()
        failing = False
        await s.sweep()

        failing = True
        t.now = started + timedelta(milliseconds=3_600_000)
        for _ in range(limit):
            await s.sweep()
        t.now = started + timedelta(milliseconds=3_600_000 + 1_801_000)
        await s.sweep()
        reminders = t.said("still degraded")
        assert len(reminders) == 1
        # 30m into the SECOND outage, not 1h30m since the first
        assert "over 30m" in reminders[0]

    async def test_notices_a_provider_that_keeps_dropping_and_recovering_which_the_run_cannot(self, t: Sweeps) -> None:
        # The outage of 2026-11-08 that the service missed entirely: a launchd agent was killing OpenD
        # 27s after every start and restarting it a minute later, so the sweep failed roughly a third
        # of the time for an hour. Every success reset the consecutive counter below its threshold, so
        # "monitoring degraded" never fired. The owner found it by looking at the dashboard.
        t.monitor()
        failing = True
        s = t.sweeper(failing_while(lambda: failing))
        started = t.now

        # fail, succeed, fail, succeed… five failures inside the window, never two in a row
        for i in range(10):
            t.now = started + timedelta(milliseconds=i * 90_000)
            failing = i % 2 == 0
            await s.sweep()

        # the run never reached the threshold, so the sustained notice stayed silent — correctly
        assert t.said("monitoring degraded") == []
        assert s.health.consecutive_failures() == 0
        # and the RATE spoke instead
        said = t.said("unreliable")
        assert len(said) == 1
        assert "failed sweeps in the last 15m" in said[0]

    @staticmethod
    def flapping_bouts(t: Sweeps, **over: Any):
        """A bout of flapping: `sweeps` sweeps 90s apart from `start` seconds after `started`, every
        other one failing — five failures inside the 15m window by the ninth sweep, never two in a
        row. Answers how many times the owner has been called unreliable so far."""
        t.monitor()
        failing = True
        s = t.sweeper(failing_while(lambda: failing), **over)
        started = t.now

        async def bout(start: int, sweeps: int) -> int:
            nonlocal failing
            for i in range(sweeps):
                t.now = started + timedelta(seconds=start + i * 90)
                failing = i % 2 == 0
                await s.sweep()
            return len(t.said("unreliable"))

        return bout

    async def test_says_a_provider_is_unreliable_again_on_flapping_repeat_seconds_from_the_last_notice(
        self, t: Sweeps
    ) -> None:
        # first said at the fifth failure, 720s in; the failures after it are 180s apart, so the first
        # one 600s on is at 1440s — and at the default 1800 nothing more is said in 1710s
        bout = self.flapping_bouts(t, flapping_repeat_seconds=600)
        assert await bout(0, 20) == 2
        assert t.said("monitoring degraded") == [], "never five in a row"

    async def test_with_flapping_repeat_seconds_0_says_it_once_and_not_for_a_later_bout_either(self, t: Sweeps) -> None:
        # Nothing marks the end of a bout — a success is what flapping looks like — so nothing clears
        # the stamp, and 0 means one notice until the service restarts. At the default the second
        # bout, an hour on, is announced as the first was.
        once = self.flapping_bouts(t, flapping_repeat_seconds=0)
        assert await once(0, 20) == 1
        assert await once(3600, 10) == 1, "an hour later, flapping again"

    async def test_announces_a_later_bout_at_the_default_interval_as_it_did_before_there_was_a_knob(
        self, t: Sweeps
    ) -> None:
        bout = self.flapping_bouts(t)
        assert await bout(0, 20) == 1
        assert await bout(3600, 10) == 2

    async def test_does_not_call_a_single_blip_unreliable(self, t: Sweeps) -> None:
        t.monitor()
        failing = True
        s = t.sweeper(failing_while(lambda: failing, "down"))
        await s.sweep()
        failing = False
        await s.sweep()
        assert t.said("unreliable") == []

    async def test_says_one_thing_or_the_other_about_a_sustained_outage_never_both(self, t: Sweeps) -> None:
        # a long enough outage trips the run AND fills the window, and two notices about one
        # unavailable provider is the noise that teaches someone to stop reading the channel
        t.monitor()
        s = t.sweeper(failing_while(lambda: True))
        started = t.now
        for i in range(10):
            t.now = started + timedelta(milliseconds=i * 30_000)
            await s.sweep()
        assert len(t.said("monitoring degraded")) == 1
        assert t.said("unreliable") == []

    async def test_does_not_announce_a_recovery_it_was_never_degraded_from(self, t: Sweeps) -> None:
        t.monitor()
        failing = True
        s = t.sweeper(failing_while(lambda: failing, "down"))
        await s.sweep()  # one failure, well short of the threshold
        failing = False
        await s.sweep()
        assert t.said("recovered") == []

    async def test_labels_its_own_health(self, t: Sweeps) -> None:
        s = t.sweeper(nothing)
        assert s.health.alarm_state() == AlarmState(label="starting", bad=False)
        s.health.sweep_ok = True
        assert s.health.alarm_state() == AlarmState(label="active", bad=False)
        s.health.sweep_ok = False
        s.health.consecutive_failures_count = 1
        assert s.health.alarm_state() == AlarmState(label="STALLED (1 failed sweep)", bad=True)
        s.health.consecutive_failures_count = 3
        assert s.health.alarm_state() == AlarmState(label="STALLED (3 failed sweeps)", bad=True)


class TestASweepThatNeverCameBack:
    """The failure mode of 2026-10-16: not a sweep that failed, but a sweep that never came back.

    Every field /health reads was green throughout — `sweep_at` is stamped when a sweep BEGINS, the
    failure counters only move when a fetch returns, and `opend` was a TCP probe answered by a gateway
    that would not log in. Three fields, no new information between them, and eight minutes of a dead
    alarm engine reported as "active".
    """

    INTERVAL = settings_for(**BASE).monitor_interval_seconds

    def stale(self, t: Sweeps) -> datetime:
        return t.now - timedelta(milliseconds=self.INTERVAL * STALE_AFTER_SWEEPS * 1000 + 1000)

    def test_calls_itself_stalled_when_no_sweep_has_begun_for_several_intervals(self, t: Sweeps) -> None:
        s = t.sweeper(nothing)
        s.health.sweep_ok = True  # the last one that finished was fine
        s.health.sweep_at = self.stale(t)
        assert s.health.last_sweep_ok() is False
        state = s.health.alarm_state()
        assert state.bad is True
        assert re.search(r"no sweep for \d+s", state.label)

    def test_is_not_stalled_merely_because_one_sweep_is_in_flight(self, t: Sweeps) -> None:
        # a sweep takes real time and may straddle a tick; that is overrun, not death
        s = t.sweeper(nothing)
        s.health.sweep_ok = True
        s.health.sweep_at = t.now - timedelta(seconds=self.INTERVAL)
        assert s.health.last_sweep_ok() is True
        assert s.health.alarm_state() == AlarmState(label="active", bad=False)

    def test_calls_a_first_sweep_that_never_came_back_stalled_not_starting(self, t: Sweeps) -> None:
        # the two halves of /health must not contradict each other. With the "starting" branch above
        # the staleness check, a service whose very first sweep hangs reads `alarms: "starting", bad:
        # false` for ever while `last_sweep_ok` is already false (mutation sweep, 2026-11-09).
        s = t.sweeper(nothing)
        s.health.sweep_at = self.stale(t)
        assert s.health.sweep_ok is None  # it has not come back even once
        assert s.health.last_sweep_ok() is False
        state = s.health.alarm_state()
        assert state.bad is True
        assert re.search(r"no sweep for \d+s", state.label)

    def test_is_starting_not_stalled_before_the_first_sweep(self, t: Sweeps) -> None:
        # launchd restarts after every merge, and a service that has not swept yet must not cry stall
        s = t.sweeper(nothing)
        assert s.health.last_sweep_ok() is True
        assert s.health.alarm_state() == AlarmState(label="starting", bad=False)

    async def test_counts_an_abandoned_sweep_as_a_failure_and_says_so_at_the_threshold(self, t: Sweeps) -> None:
        # what the scheduler's watchdog calls. Without this a stall is cleared by the next tick and
        # leaves no trace at all.
        s = t.sweeper(nothing)
        limit = settings_for(**BASE).degraded_after_failures
        for _ in range(limit):
            await s.health.record_stall(90)
        assert s.health.consecutive_failures() == limit
        assert s.health.last_sweep_ok() is False
        assert len(t.said("degraded")) == 1
        assert "90" in "\n".join(t.sent)

    async def test_reports_what_the_last_fetch_did_which_is_not_what_a_port_probe_can_tell_you(self, t: Sweeps) -> None:
        t.monitor()
        failing = True
        s = t.sweeper(failing_while(lambda: failing))
        assert s.health.last_fetch_ok() is None  # nothing asked yet, nothing to claim
        await s.sweep()
        assert s.health.last_fetch_ok() is False
        failing = False
        await s.sweep()
        assert s.health.last_fetch_ok() is True

    async def test_re_stamps_the_freshness_of_every_batch_which_is_the_only_thing_it_is_read_for(
        self, t: Sweeps
    ) -> None:
        # `fetched_at` is freshness (CLAUDE.md), and a freshness stamp written once and then kept is
        # worse than no stamp at all: /health goes on reporting the first batch's instant while the
        # market moves (mutation sweep, 2026-11-09).
        t.monitor()
        s = t.sweeper(quoting("option_delta", {CODE: 0.1}), monitor_interval_seconds=CADENCE)
        await s.sweep()
        first = s.health.last_fetch_at()
        assert first == t.now

        await t.tick(s)
        assert s.health.last_fetch_at() == t.now
        assert s.health.last_fetch_at() > first

    async def test_re_stamps_when_each_sweep_began_which_is_what_staleness_is_measured_from(self, t: Sweeps) -> None:
        # The sibling hole, found by the same sweep: every case about staleness above sets `sweep_at`
        # by hand to state an age, so keeping the first stamp passed all of them — and the service it
        # describes is one whose `last_sweep_at` freezes at the first sweep of the process and then
        # reports itself STALLED for ever while sweeping every 15 seconds.
        t.monitor()
        s = t.sweeper(quoting("option_delta", {CODE: 0.1}), monitor_interval_seconds=CADENCE)
        await s.sweep()
        first = s.health.last_sweep_at()
        assert first == t.now

        await t.sweep_for(s, CADENCE * STALE_AFTER_SWEEPS * 2)
        assert s.health.last_sweep_at() == t.now
        assert s.health.last_sweep_at() > first
        # and the engine therefore still calls itself active, which is the half /health reports
        assert s.health.alarm_state() == AlarmState(label="active", bad=False)


class TestAFigureThatNeverArrives:
    """The quietest bug in the system until #167: `monitor_value` comes back None, the sweep writes a
    log line and moves on, and the rule is never evaluated again. No notice, no marker, no disable —
    an alarm that cannot fire looks exactly like one that is not breached."""

    LIMIT = 3
    FEW: ClassVar[dict[str, int]] = {"quarantine_after_silent_sweeps": LIMIT}

    @staticmethod
    def silent(codes: list[str]) -> list[dict[str, Any]]:
        # the contract is priced, the watched figure simply is not in the record
        return [{"code": c, "name": c, "mid_price": 4.2} for c in codes]

    async def test_is_quarantined_at_the_limit_and_not_before_with_a_notice_naming_the_field(self, t: Sweeps) -> None:
        id_ = t.monitor()
        s = t.sweeper(self.silent, **self.FEW)

        for i in range(1, self.LIMIT):
            await s.sweep()
            assert t.row(id_)["enabled"] == 1, f"sweep {i}"
            assert t.sent == []
        await s.sweep()

        assert t.row(id_)["enabled"] == 0
        assert t.row(id_)["disabled_reason"] == "no-figure"
        assert len(t.sent) == 1
        assert "option_delta" in t.sent[0]
        assert str(self.LIMIT) in t.sent[0]
        # FORGOTTEN, not held at the limit, which is what `silence_verdict` answers with a None count
        # (ADR 0017): unmuting the rule has to give it its full run again
        assert id_ not in s.silent_sweeps, "the run is forgotten once it has been acted on"

    async def test_counts_consecutive_sweeps_so_a_figure_that_comes_back_is_not_a_quarantine(self, t: Sweeps) -> None:
        id_ = t.monitor()
        values: dict[str, float] = {}

        def flaky(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {"code": c, "name": c, "option_delta": values[c]} if c in values else {"code": c, "name": c}
                for c in codes
            ]

        s = t.sweeper(flaky, **self.FEW)

        await s.sweep()
        await s.sweep()
        values[CODE] = 0.1  # it arrived: the run of silence is over
        await s.sweep()
        del values[CODE]
        for _ in range(1, self.LIMIT):
            await s.sweep()

        # without the reset this is the fifth silent sweep of six and the rule is long gone
        assert t.row(id_)["enabled"] == 1
        assert t.sent == []

    async def test_says_which_leg_went_unpriced_rather_than_blaming_the_field(self, t: Sweeps) -> None:
        # a combo is None when ANY leg is missing (no partial sums), which is a different fault from
        # a provider that does not send the figure at all — and the notice is the only place it shows
        id_ = t.combo()
        leg = build_spx_code(t.future(), "CALL", 8150)

        def one_leg(codes: list[str]) -> list[dict[str, Any]]:
            return [{"code": c, "name": c, "mid_price": 4.2} for c in codes if c != leg]

        s = t.sweeper(one_leg, **self.FEW)

        for _ in range(self.LIMIT):
            await s.sweep()

        assert t.row(id_)["disabled_reason"] == "no-figure"
        assert leg in t.sent[0]
        assert "mid_price" not in t.sent[0]

    async def test_says_it_once_the_rule_is_disabled_so_the_next_sweep_has_nothing_to_say(self, t: Sweeps) -> None:
        t.monitor()
        s = t.sweeper(self.silent, **self.FEW)
        for _ in range(self.LIMIT + 3):
            await s.sweep()
        assert len(t.sent) == 1

    async def test_evaluates_every_other_rule_in_the_same_sweep_and_is_not_a_sweep_failure(self, t: Sweeps) -> None:
        other = build_spx_code(t.future(), "PUT", 6425)
        quiet = t.monitor()
        loud = t.monitor(code=other, option_type="PUT", strike=6425, threshold=0.6)

        def half(codes: list[str]) -> list[dict[str, Any]]:
            return [
                {"code": c, "name": c, "option_delta": 0.7} if c == other else {"code": c, "name": c} for c in codes
            ]

        s = t.sweeper(half, **self.FEW)

        for _ in range(self.LIMIT):
            await s.sweep()

        assert t.row(quiet)["enabled"] == 0
        assert t.row(loud)["triggered"] == 1
        assert len(t.said("crossed")) == 1
        # containment: a rule that cannot be evaluated is not an engine that is failing
        assert s.health.last_sweep_ok() is True

    async def test_gives_an_unmuted_rule_its_full_count_again(self, t: Sweeps) -> None:
        id_ = t.monitor()
        s = t.sweeper(self.silent, **self.FEW)
        for _ in range(self.LIMIT):
            await s.sweep()
        assert t.row(id_)["enabled"] == 0

        t.db.execute("update monitors set enabled = 1, disabled_reason = null where id = ?", (id_,))
        await s.sweep()

        # not re-quarantined on the first silent sweep by a count the engine still remembered
        assert t.row(id_)["enabled"] == 1
        assert len(t.sent) == 1

    async def test_forgets_a_rule_that_is_no_longer_being_swept(self, t: Sweeps) -> None:
        id_ = t.monitor()
        s = t.sweeper(self.silent, **self.FEW)
        await s.sweep()
        assert len(s.silent_sweeps) == 1

        t.db.execute("delete from monitors where id = ?", (id_,))
        await s.sweep()

        # left behind, the count grows for ever and a rule unmuted later resumes mid-count
        assert len(s.silent_sweeps) == 0

    async def test_can_be_turned_off_and_then_only_warns_which_is_what_it_did_before(self, t: Sweeps) -> None:
        id_ = t.monitor()
        s = t.sweeper(self.silent, quarantine_after_silent_sweeps=0)
        for _ in range(12):
            await s.sweep()
        assert t.row(id_)["enabled"] == 1
        assert t.sent == []


class TestASweepThatCannotFinish:
    """A sweep that does not finish the work it was started for.

    Everything below asserts the same thing from three directions: the engine's account of itself must
    not say "active" for a sweep that evaluated nothing, or evaluated only part of the watchlist. A
    throw after the batch reached `scheduler`, which logs and returns, so `/health` went on reporting
    `last_sweep_ok: true` and `alarms: "active"` with no alarm being evaluated at all.

    The failure is injected with a TRIGGER rather than a mock: it makes a real write fail inside the
    real transaction, which is the shape the live fault has (a corrupt row, a disk error), and it
    cannot drift from the code the way a stubbed method can.
    """

    @staticmethod
    def refuse_updates(t: Sweeps, where: str = "") -> None:
        t.db.execute(
            f"""create trigger no_update before update on monitors {where}
             begin select raise(abort, 'refused'); end"""
        )

    async def test_is_not_a_success_when_the_work_after_the_batch_throws(self, t: Sweeps) -> None:
        t.monitor()
        s = t.sweeper(quoting("option_delta", {CODE: 0.7}))
        self.refuse_updates(t)

        await s.sweep()  # resolves: the loop must never be killed by one bad sweep

        assert s.health.last_sweep_ok() is False, "a sweep that evaluated nothing reported success"
        assert s.health.consecutive_failures() == 1
        assert len(t.said("crossed")) == 0

    async def test_says_so_loudly_when_the_engine_cannot_even_read_the_only_rule_there_is(self, t: Sweeps) -> None:
        # A combo's leg codes are BUILT from its strike date, in the code assembly BEFORE the batch is
        # asked for. #182 made this a FAILED sweep; it is not silent now: the row is quarantined and
        # the owner is told, which is work, and the rest of the watchlist is swept instead of being
        # sacrificed to signal one bad row (review 2026-11-01).
        id_ = t.combo(strike_date="the first of never")
        s = t.sweeper(quoting("option_delta", {CODE: 0.7}))

        await s.sweep()

        assert any("could not be read" in x for x in t.sent), "it must not pass in silence"
        assert t.row(id_)["enabled"] == 0, "and the rule it cannot read is quarantined"
        assert t.row(id_)["disabled_reason"] == "unreadable"

    async def test_evaluates_the_rest_of_the_watchlist_when_one_row_refuses(self, t: Sweeps) -> None:
        # containment, and the reason the isolation is per row: a single poison row used to abort the
        # whole transaction, so one unwritable monitor silenced every alarm beside it
        bad = t.monitor()
        good = t.monitor(code=build_spx_code(t.future(), "CALL", 6600), strike=6600)
        s = t.sweeper(quoting("option_delta", {CODE: 0.7, build_spx_code(t.future(), "CALL", 6600): 0.8}))
        self.refuse_updates(t, f"when new.id = '{bad}'")

        await s.sweep()

        assert t.row(good)["triggered"] == 1, "the good rule was taken down with the bad one"
        assert len(t.said("crossed")) == 1
        # and still not a clean sweep: one rule was not evaluated, which the engine must own up to
        assert s.health.last_sweep_ok() is False
        assert t.row(bad)["triggered"] == 0


class TestARowTheEngineCannotRead:
    """A row the engine cannot read costs ONE rule, not the sweep.

    The watchlist was hydrated eagerly, before the fetch, outside any try — so a corrupt row took the
    whole sweep down, every minute, with the healthy rules beside it never evaluated and no alarm ever
    sent. #81's failure mode through a different door, found by review on 2026-11-01.
    """

    async def test_is_quarantined_and_the_healthy_rule_beside_it_is_still_swept(self, t: Sweeps) -> None:
        good = t.monitor()
        # a combo whose strike_date the domain refuses: monitor_leg_codes builds each leg's code from it
        bad = t.monitor(
            code="cmb-bad",
            option_type="CMB",
            strike=0,
            field="mid_price",
            strike_date="not-a-date",
            legs=[{"sign": 1, "option_type": "CALL", "strike": 8100}],
        )
        s = t.sweeper(quoting("option_delta", {CODE: 0.9}))

        await s.sweep()

        assert s.health.last_sweep_ok() is True, "the sweep must not fail over one row"
        assert t.row(good)["last_checked_at"] is not None, "the healthy rule was evaluated"
        assert t.row(good)["triggered"] == 1
        assert t.row(bad)["enabled"] == 0, "the unreadable rule is quarantined"
        assert t.row(bad)["disabled_reason"] == "unreadable"
        assert any("cmb-bad" in x and "could not be read" in x for x in t.sent)

    async def test_says_so_once_not_every_sweep(self, t: Sweeps) -> None:
        t.monitor(code="cmb-bad2", option_type="CMB", strike=0, legs="{not json")
        s = t.sweeper(quoting("option_delta", {CODE: 0.9}))

        await s.sweep()
        after = len(t.sent)
        await s.sweep()

        # quarantined on the first pass, so the second does not see it among the active rows
        assert len(t.sent) == after, "a quarantined row is not re-announced"

    async def test_keeps_sweeping_when_a_position_is_the_unreadable_one(self, t: Sweeps) -> None:
        good = t.monitor()
        t.db.execute(
            """insert into positions (id, name, strategy, strike_date, contracts, entry, legs,
      created_at) values ('pbad', 'broken', 'x', '2026-12-18', 1, 1.0, '{not json',
      '2026-08-01 00:00:00.000000')"""
        )
        s = t.sweeper(quoting("option_delta", {CODE: 0.9}))

        await s.sweep()

        # a holding cannot be quarantined — it is not a rule — so it is skipped and the sweep goes on.
        # The dashboard surfaces it: the panel has no figures for a row it cannot parse.
        assert s.health.last_sweep_ok() is True
        assert t.row(good)["last_checked_at"] is not None


class TestARuleMutedWhileTheSweepIsOut:
    """A rule changed DURING the sweep's fetch.

    The sweep awaits a live Provider batch, which takes real time, and the re-read after it exists
    because "a request may have changed the row in the meantime". It harvested `triggered` and
    `last_alarm_at` and never looked at `enabled` — so muting a flapping rule while a sweep was out got
    you the message anyway, with the flag left on so the eventual unmute re-fired it (review
    2026-11-01).
    """

    async def test_is_not_alarmed_and_its_flag_is_left_alone(self, t: Sweeps) -> None:
        id_ = t.monitor()

        # mutes the row from inside the fetch, exactly as a concurrent PATCH would
        def racing(codes: list[str]) -> list[dict[str, Any]]:
            t.db.execute("update monitors set enabled = 0, disabled_reason = 'manual' where id = ?", (id_,))
            return [{"code": c, "name": c, "option_delta": 0.9} for c in codes]

        s = t.sweeper(racing)

        await s.sweep()

        assert len(t.said("crossed")) == 0, "it alarmed on a muted rule"
        assert t.row(id_)["triggered"] == 0, "and latched the flag on a disabled row"


class TestARuleRedefinedWhileTheSweepIsOut:
    """A rule REDEFINED while the sweep is out (#359's review): a held 1×3 corrected to a 1×2 takes its value
    rule with it, and a PATCH to /monitors may change a rule's field (#292). The batch was valued against the
    row read BEFORE the fetch, so an answer to the old definition must not be written onto, or alarmed for,
    the new one: the next sweep reads the rule as it now is."""

    @staticmethod
    def ratio(qty: int) -> list[dict[str, Any]]:
        return [
            {"sign": 1, "option_type": "CALL", "strike": 8100},
            {"sign": -1, "option_type": "CALL", "strike": 8150, "qty": qty},
        ]

    @staticmethod
    def mids(codes: list[str]) -> list[dict[str, Any]]:
        """the 8100 at 2.00 and the 8150 at 1.00: the 1×3 is worth −1, the 1×2 nothing"""
        return [{"code": c, "name": c, "mid_price": 2 if c.endswith("C8100000") else 1} for c in codes]

    async def test_is_not_alarmed_on_the_old_definitions_figure_when_its_legs_change(self, t: Sweeps) -> None:
        id_ = t.combo(code="ratio", threshold=0.8, direction="above", compare="abs", legs=self.ratio(3))

        def racing(codes: list[str]) -> list[dict[str, Any]]:
            t.db.execute("update monitors set legs = ? where id = ?", (json.dumps(self.ratio(2)), id_))
            return self.mids(codes)

        await t.sweeper(racing).sweep()
        assert t.sent == [], "it alarmed a 1×2 on the 1×3's value"
        assert (t.row(id_)["triggered"], t.row(id_)["last_value"]) == (0, None)

        # the next sweep values the rule as it now is: 0, inside 0.8
        await t.sweeper(self.mids).sweep()
        assert t.sent == []
        assert t.row(id_)["last_value"] == 0

    async def test_is_not_alarmed_on_the_old_fields_figure_when_its_field_changes(self, t: Sweeps) -> None:
        id_ = t.monitor(threshold=0.6)

        def racing(codes: list[str]) -> list[dict[str, Any]]:
            t.db.execute("update monitors set field = 'mid_price' where id = ?", (id_,))
            return [{"code": c, "name": c, "option_delta": 0.9, "mid_price": 0.1} for c in codes]

        await t.sweeper(racing).sweep()
        assert len(t.said("crossed")) == 0
        assert (t.row(id_)["triggered"], t.row(id_)["last_value"]) == (0, None)


class TestWhatOnlyThePythonCanGetWrong:
    async def test_asks_for_the_batch_in_javascripts_sort_order(self, t: Sweeps) -> None:
        # `Array.prototype.sort` compares UTF-16 code units, Python's `sorted` code points, and the two
        # disagree past the Basic Multilingual Plane: U+FF5E sorts AFTER U+1F600 in JavaScript
        asked: list[list[str]] = []

        def fetch(codes: list[str]) -> list[dict[str, Any]]:
            asked.append(list(codes))
            return []

        t.monitor(code="X\U0001f600")
        t.monitor(code="X～", field="mid_price")
        await t.sweeper(fetch).sweep()
        assert asked == [["X\U0001f600", "X～"]]

    async def test_names_the_rule_by_the_providers_name_as_javascript_would_print_it(self, t: Sweeps) -> None:
        # the record's `name` is whatever the Provider sent; a number is interpolated as `String` does
        t.monitor(threshold=0.6)
        await t.sweeper(lambda codes: [{"code": CODE, "name": 8050.0, "option_delta": 0.7}]).sweep()
        assert t.sent == ["⚠️ 8050: option_delta 0.700 crossed ≥ 0.6"]

    async def test_takes_back_a_refused_rows_messages_and_logs_it_with_its_stack(
        self, t: Sweeps, caplog: pytest.LogCaptureFixture
    ) -> None:
        bad = t.monitor()
        TestASweepThatCannotFinish.refuse_updates(t, f"when new.id = '{bad}'")
        with caplog.at_level(logging.ERROR, logger=LOG):
            await t.sweeper(quoting("option_delta", {CODE: 0.7})).sweep()
        assert t.sent == []
        [record] = [r for r in caplog.records if r.name == LOG and r.levelno == logging.ERROR]
        assert record.getMessage() == f"monitor {CODE} could not be evaluated:"
        assert record.exc_info is not None

    async def test_does_not_swallow_the_task_being_cancelled(self, t: Sweeps) -> None:
        # `catch (err)` is `except Exception`: CancelledError is the loop stopping the sweep on the way
        # out of the process, which must end it rather than count as a failed sweep
        t.monitor()

        async def fetch_quotes(codes: list[str]) -> Batch:
            raise asyncio.CancelledError

        s = MonitorSweeper(
            SweeperDeps(
                db=t.db,
                settings=settings_for(**BASE),
                fetch_quotes=fetch_quotes,
                send=t.sent.append,
                now=lambda: t.now,
            )
        )
        with pytest.raises(asyncio.CancelledError):
            await s.sweep()
        assert s.health.consecutive_failures() == 0
