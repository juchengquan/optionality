"""Reading the knobs. `.env` is the deployment, so these names and the way they parse are part of
it rather than implementation detail — a renamed variable silently reverts a setting the owner has
made, and a parse that rejects a legal value stops the service at boot.

Port of backend/src/env.test.ts, test for test; what only the Python can get wrong is at the end.
"""

import dataclasses
import os
import re

import pytest

from optionality_backend.env import DEFAULTS, FROM_ENV, Settings, settings_for, settings_from_env


class TestWhichDatabase:
    def test_defaults_to_the_typescript_database_never_the_frozen_rollback(self):
        # `data/optionality.db` is the Python's, "frozen at the cutover minute and never opened by the
        # new service" (CLAUDE.md) — it is the rollback. It was the DEFAULT there, and `main.ts` opens
        # and MIGRATES whatever it is given, at import time. The schemas diverged at ADR 0011, so one
        # run with OPTIONALITY_DB_PATH unset would have ALTERed the rollback.
        assert DEFAULTS.db_path == "data/optionality-ts.db"
        assert settings_from_env({}).db_path == "data/optionality-ts.db", "with nothing set at all"
        assert DEFAULTS.db_path != "data/optionality.db", "the rollback is never the default"

    def test_still_takes_the_path_the_deployment_gives_it(self):
        assert settings_from_env({"OPTIONALITY_DB_PATH": "data/elsewhere.db"}).db_path == "data/elsewhere.db"


class TestNumbers:
    def test_keeps_rejecting_a_fractional_count_which_is_always_a_typo(self):
        # int() in the old Python, which raised rather than silently using the default: a mistyped
        # interval should stop the service, not quietly sweep every 60 seconds
        with pytest.raises(ValueError, match="MONITOR_INTERVAL_SECONDS"):
            settings_from_env({"MONITOR_INTERVAL_SECONDS": "1.5"})
        with pytest.raises(ValueError, match="EXPIRED_RETENTION_DAYS is not an integer"):
            settings_from_env({"EXPIRED_RETENTION_DAYS": "7.5"})
        with pytest.raises(ValueError, match="EXIT_MANAGE_BY_DTE is not an integer"):  # a DTE is a whole day
            settings_from_env({"EXIT_MANAGE_BY_DTE": "21.5"})

    def test_accepts_a_fractional_fraction_which_the_integer_rule_would_have_killed_at_boot(self):
        # EXIT_TAKE_FRACTION=0.5 is the value `.env.example` shows, and before this it threw — the
        # default survived only because defaults never go through the parser, so the feature worked
        # until the owner set the knob it documents
        assert settings_from_env({"EXIT_TAKE_FRACTION": "0.5"}).exit_take_fraction == 0.5
        assert settings_from_env({"EXIT_TAKE_FRACTION": "0.35"}).exit_take_fraction == 0.35
        assert settings_from_env({"EXIT_STOP_MULTIPLE": "2.5"}).exit_stop_multiple == 2.5
        # and a whole number is still fine for them
        assert settings_from_env({"EXIT_STOP_MULTIPLE": "2"}).exit_stop_multiple == 2

    def test_rejects_what_is_not_a_number_at_all_fractional_or_not(self):
        with pytest.raises(ValueError, match="EXIT_TAKE_FRACTION"):
            settings_from_env({"EXIT_TAKE_FRACTION": "half"})
        # a variable set to nothing is its own message: an empty string is not "not a number", it
        # is a knob somebody meant to set and left blank
        with pytest.raises(ValueError, match="EXIT_STOP_MULTIPLE is set to nothing"):
            settings_from_env({"EXIT_STOP_MULTIPLE": ""})

    def test_leaves_a_knob_alone_when_the_variable_is_absent(self):
        s = settings_from_env({})
        assert s.exit_take_fraction == DEFAULTS.exit_take_fraction
        assert s.exit_manage_by_dte == DEFAULTS.exit_manage_by_dte


class TestTheKnobsAServiceMustNotStartOn:
    """The guard that was only ever on the test path.

    `checkSettings` refused these values from the day it was written, and `settingsFor` — how every
    TEST builds Settings — called it. `settingsFromEnv`, how the SERVICE builds them, did not, so the
    live process accepted exactly the values documented as fatal (measured 2026-11-08). These tests go
    through the SERVICE's door."""

    def test_refuses_a_count_that_cannot_mean_anything(self):
        with pytest.raises(ValueError, match="ALARM_COOLDOWN_SECONDS cannot be negative"):
            settings_from_env({"ALARM_COOLDOWN_SECONDS": "-1"})

    def test_refuses_degraded_after_failures_0_which_announced_recovery_for_ever(self):
        # 0 made `consecutive_failures >= threshold` true on a HEALTHY sweep: "✅ monitoring
        # recovered" every minute, while the degraded alert it arms never fired at all (env.py)
        with pytest.raises(ValueError, match="DEGRADED_AFTER_FAILURES must be at least 1"):
            settings_from_env({"DEGRADED_AFTER_FAILURES": "0"})

    def test_refuses_monitor_interval_seconds_0_which_stalls_the_engine_permanently(self):
        # an interval of 0 with a stall threshold of 0: /health reads stalled for ever and every tick
        # records a failed sweep
        with pytest.raises(ValueError, match="MONITOR_INTERVAL_SECONDS must be at least 1"):
            settings_from_env({"MONITOR_INTERVAL_SECONDS": "0"})

    def test_still_allows_0_where_0_genuinely_means_off(self):
        # the three AT_LEAST_ONE deliberately leaves out, which is why that list is explicit
        assert settings_from_env({"ALARM_REPEAT_SECONDS": "0"}).alarm_repeat_seconds == 0
        assert settings_from_env({"QUARANTINE_AFTER_SILENT_SWEEPS": "0"}).quarantine_after_silent_sweeps == 0
        assert settings_from_env({"EXPIRED_RETENTION_DAYS": "0"}).expired_retention_days == 0
        # and the two flapping knobs, where 0 failures is the off switch (domain/flapping.ts)
        assert settings_from_env({"FLAPPING_AFTER_FAILURES": "0"}).flapping_after_failures == 0
        # and its reminder, where 0 says it once
        assert settings_from_env({"FLAPPING_REPEAT_SECONDS": "0"}).flapping_repeat_seconds == 0

    def test_reads_the_flapping_notice_s_repeat_interval_which_had_no_variable_at_all(self):
        # The policy said "0 off" about a cadence nothing could set: the reader defaulted it to
        # 1800 itself, and no line in `.env` reached it.
        assert settings_from_env({}).flapping_repeat_seconds == 1800
        assert settings_from_env({"FLAPPING_REPEAT_SECONDS": "600"}).flapping_repeat_seconds == 600
        with pytest.raises(ValueError, match="FLAPPING_REPEAT_SECONDS cannot be negative"):
            settings_from_env({"FLAPPING_REPEAT_SECONDS": "-1"})
        with pytest.raises(ValueError, match="FLAPPING_REPEAT_SECONDS is not an integer"):
            settings_from_env({"FLAPPING_REPEAT_SECONDS": "1.5"})
        with pytest.raises(ValueError, match="FLAPPING_REPEAT_SECONDS is not a number"):
            settings_from_env({"FLAPPING_REPEAT_SECONDS": "half an hour"})
        with pytest.raises(ValueError, match="FLAPPING_REPEAT_SECONDS is set to nothing"):
            settings_from_env({"FLAPPING_REPEAT_SECONDS": ""})

    def test_checks_the_defaults_themselves_so_a_bad_default_cannot_ship(self):
        settings_from_env({})


class TestWhatOnlyThePythonCanGetWrong:
    """What the TypeScript's compiler or its `Number` gives it for nothing, and a Python port has to
    do on purpose."""

    def test_every_setting_has_exactly_one_variable(self):
        # `satisfies Record<keyof Settings, string>` in the TypeScript: a setting with no variable is
        # a knob nobody can turn, and a variable with no setting is one read into nothing
        assert set(FROM_ENV) == {f.name for f in dataclasses.fields(Settings)}
        assert len(set(FROM_ENV.values())) == len(FROM_ENV)

    def test_the_variables_are_the_typescript_s_by_name(self):
        # renaming one silently reverts a knob the owner has set, in whichever backend reads it
        assert all(re.fullmatch(r"[A-Z][A-Z_]*", v) for v in FROM_ENV.values())
        assert FROM_ENV["monitor_interval_seconds"] == "MONITOR_INTERVAL_SECONDS"
        assert FROM_ENV["db_path"] == "OPTIONALITY_DB_PATH"
        assert FROM_ENV["display_tz"] == "DISPLAY_TZ"

    def test_parses_a_number_as_javascript_s_number_does(self):
        # `Number`, not `float`: wider in one direction (hex), narrower in the other (Python's
        # `float` takes `1_000` and Unicode digits, which JavaScript calls not a number)
        assert settings_from_env({"MONITOR_INTERVAL_SECONDS": "0x10"}).monitor_interval_seconds == 16
        assert settings_from_env({"MONITOR_INTERVAL_SECONDS": " 1e2 "}).monitor_interval_seconds == 100
        for raw in ("1_000", "١٢٣", "Infinity", "NaN"):
            with pytest.raises(ValueError, match="MONITOR_INTERVAL_SECONDS is not a number"):
                settings_from_env({"MONITOR_INTERVAL_SECONDS": raw})

    def test_set_to_nothing_is_javascript_s_trim_not_python_s_strip(self):
        # JavaScript trims a byte-order mark and leaves the ASCII separators \x1c-\x1f alone; Python's
        # `strip()` does the opposite on both
        with pytest.raises(ValueError, match="ALARM_REPEAT_SECONDS is set to nothing"):
            settings_from_env({"ALARM_REPEAT_SECONDS": "﻿ 　"})
        with pytest.raises(ValueError, match="ALARM_REPEAT_SECONDS is not a number"):
            settings_from_env({"ALARM_REPEAT_SECONDS": "\x1c"})

    def test_a_count_is_an_int_and_a_fraction_a_float(self):
        s = settings_from_env({"MONITOR_INTERVAL_SECONDS": "1e2", "EXIT_STOP_MULTIPLE": "2"})
        assert type(s.monitor_interval_seconds) is int
        assert type(s.exit_stop_multiple) is float
        assert type(DEFAULTS.exit_stop_multiple) is float

    def test_a_refused_value_is_written_as_javascript_writes_it(self):
        with pytest.raises(ValueError, match=r"^ALARM_COOLDOWN_SECONDS cannot be negative: -1$"):
            settings_from_env({"ALARM_COOLDOWN_SECONDS": "-1"})
        with pytest.raises(ValueError, match=r"^EXIT_TAKE_FRACTION cannot be negative: -0\.5$"):
            settings_from_env({"EXIT_TAKE_FRACTION": "-0.5"})

    def test_settings_for_is_checked_too(self):
        # `settingsFor` is how every test builds Settings, so a knob the service would refuse must not
        # be constructible in a test either
        assert settings_for(api_token="tok").api_token == "tok"
        with pytest.raises(ValueError, match="DEGRADED_AFTER_FAILURES must be at least 1"):
            settings_for(degraded_after_failures=0)

    def test_reads_the_process_environment_when_given_none(self, monkeypatch):
        # `process.env` is the TypeScript's default; replaced whole here, so a knob in the shell that
        # runs the suite cannot decide the answer
        monkeypatch.setattr(os, "environ", {"DISPLAY_TZ": "Asia/Singapore"})
        assert settings_from_env().display_tz == "Asia/Singapore"
