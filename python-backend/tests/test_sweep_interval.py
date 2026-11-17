"""The sweep's interval in force, where it came from, and the knobs it moves (#442, ADR 0025). Port of
backend/src/sweep-interval.test.ts."""

import dataclasses
from datetime import UTC, datetime

import pytest

from optionality_backend.db.open import create_database
from optionality_backend.db.queries import read_sweep_interval
from optionality_backend.env import DEFAULTS, Settings
from optionality_backend.sweep_interval import SweepInterval, at_interval, choose_sweep_interval, sweep_interval

#: `.env` as the live service has it: a 15s sweep, and the counted knobs at their defaults.
ENV = dataclasses.replace(DEFAULTS, monitor_interval_seconds=15)
NOW = datetime(2026, 11, 17, 10, 0, 0, tzinfo=UTC)


@pytest.fixture
def db(tmp_path):
    d = create_database(tmp_path / "t.db")
    yield d
    d.close()  # closing a closed connection is a no-op


def interval(seconds, source, refused=None, default=15):
    return SweepInterval(seconds=seconds, source=source, default_seconds=default, refused=refused)


class TestTheIntervalInForce:
    def test_is_env_s_while_the_page_has_chosen_nothing(self, db):
        assert sweep_interval(db, ENV) == interval(15, "env")

    def test_is_the_page_s_choice_once_it_has_made_one_with_env_s_still_named_as_the_default(self, db):
        choose_sweep_interval(db, ENV, 5, NOW)
        assert sweep_interval(db, ENV) == interval(5, "settings")

    def test_goes_back_to_env_s_when_the_choice_is_cleared_by_deleting_it_rather_than_storing_15(self, db):
        choose_sweep_interval(db, ENV, 60, NOW)
        assert choose_sweep_interval(db, ENV, None, NOW) == interval(15, "env")
        assert read_sweep_interval(db) is None

    def test_stamps_when_the_choice_was_made(self, db):
        choose_sweep_interval(db, ENV, 30, NOW)
        assert read_sweep_interval(db) == {"id": 1, "seconds": 30, "set_at": "2026-11-17 10:00:00.000000"}

    def test_refuses_a_stored_value_that_is_not_a_preset_a_hand_edit_and_sweeps_at_env_s(self, db):
        # the route writes only a preset, so anything else got in by hand: refused when READ, never a
        # crash and never a sweep every 2 seconds
        for stored, said in [(7, "7"), (2, "2"), ("fast", '"fast"'), (5.5, "5.5")]:
            db.execute("insert or replace into sweep_interval values (1, ?, '2026-11-17 10:00:00.000000')", (stored,))
            assert sweep_interval(db, ENV) == interval(15, "env", said), stored

    def test_sweeps_at_env_s_when_the_database_cannot_be_read_at_all_rather_than_throwing(self, db):
        # read at every tick of the loop: a throw there would stop the alarms
        db.close()
        read = sweep_interval(db, ENV)
        assert read.seconds == 15
        assert read.source == "env"
        assert read.refused is not None and read.refused.startswith("unreadable: ")


def counted(s: Settings) -> list[int]:
    return [s.degraded_after_failures, s.flapping_after_failures, s.quarantine_after_silent_sweeps]


class TestTheKnobsCountedInSweepsAtTheIntervalInForce:
    # sized at .env's 15s: degraded 5 sweeps (75s), flapping 5 failures (75s of them), quarantine 10
    # sweeps (150s) — the owner's decision is that each keeps its TIME
    def test_are_env_s_at_env_s_interval(self):
        assert counted(at_interval(ENV, 15)) == [5, 5, 10]

    def test_triple_at_5s_so_a_faster_sweep_checks_more_often_and_judges_no_sooner(self):
        assert counted(at_interval(ENV, 5)) == [15, 15, 30]

    def test_shrink_at_60s_rounded_up_so_none_is_judged_in_less_time_than_it_was_sized_for(self):
        assert counted(at_interval(ENV, 60)) == [2, 2, 3]

    def test_keep_a_knob_that_is_off_off(self):
        off = dataclasses.replace(ENV, quarantine_after_silent_sweeps=0, flapping_after_failures=0)
        assert counted(at_interval(off, 5)) == [15, 0, 0]

    def test_are_sized_at_env_s_interval_whatever_it_is(self):
        assert counted(at_interval(dataclasses.replace(ENV, monitor_interval_seconds=60), 5)) == [60, 60, 120]

    def test_leave_every_knob_that_is_a_time_not_a_count_as_it_was(self):
        at = at_interval(ENV, 5)
        assert (
            dataclasses.replace(
                at, degraded_after_failures=5, flapping_after_failures=5, quarantine_after_silent_sweeps=10
            )
            == ENV
        )
