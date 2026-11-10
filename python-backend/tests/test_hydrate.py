"""Stored rows into the shapes the domain works in.

backend/src/hydrate.ts has no test of its own: its callers' suites rely on it. So this holds what they
rely on — `engine/sweeper.test.ts` on a combo's legs reaching the domain parsed, a single-leg rule's
NULL legs reading as no legs, and a row whose JSON is corrupt RAISING, which is what quarantines it as
unreadable ("a row the engine cannot read"); `holdings.test.ts` and `routes/positions.test.ts` on a
holding hydrated with its legs and its Opened for valuation and vol; and `monitors.test.ts` on
adoption reading the orphans and the holdings back.

What only the Python can get wrong is at the end.
"""

import pydantic
import pytest
from optionality.monitor import Monitor, MonitorLeg, monitor_leg_codes
from optionality.position import Leg, Position

from optionality_backend.hydrate import to_monitor, to_position


def stored_monitor(**over):
    return {
        "id": "m".ljust(32, "1"),
        "code": "dec-wing",
        "strike_date": "2026-12-18",
        "option_type": "CMB",
        "strike": 0.0,
        "field": "mid_price",
        "threshold": 9.5,
        "direction": "below",
        "compare": "signed",
        "legs": '[{"sign":1,"option_type":"CALL","strike":8100},{"sign":-1,"option_type":"CALL","strike":8150}]',
        "scope": "all",
        "enabled": 1,
        "disabled_reason": None,
        "triggered": 0,
        "last_value": None,
        "last_checked_at": None,
        "last_alarm_at": None,
        "created_at": "2026-11-08 00:00:00.000000",
        **over,
    }


def stored_position(**over):
    return {
        "id": "p".ljust(32, "1"),
        "name": "dec-condor",
        "strategy": "iron_condor",
        "strike_date": "2026-12-18",
        "contracts": 2,
        "entry": 6.4,
        "legs": '[{"side":"short","option_type":"CALL","strike":8100},{"side":"long","option_type":"CALL","strike":8150}]',
        "created_at": "2026-11-08 00:00:00.000000",
        "opened_at": "2026-10-12",
        "manage_notified_at": None,
        "closed_on": None,
        "exit": None,
        **over,
    }


class TestAMonitor:
    def test_reaches_the_domain_with_its_legs_parsed_and_nothing_the_domain_does_not_hold(self):
        assert to_monitor(stored_monitor()) == Monitor(
            id="m".ljust(32, "1"),
            code="dec-wing",
            strike_date="2026-12-18",
            option_type="CMB",
            strike=0.0,
            field="mid_price",
            threshold=9.5,
            direction="below",
            compare="signed",
            legs=(
                MonitorLeg(sign=1, option_type="CALL", strike=8100),
                MonitorLeg(sign=-1, option_type="CALL", strike=8150),
            ),
        )

    def test_with_no_legs_stored_is_a_single_leg_rule(self):
        single = to_monitor(stored_monitor(code="US.SPXW261218C8100000", option_type="CALL", strike=8100.0, legs=None))
        assert single.legs is None
        assert monitor_leg_codes(single) == ["US.SPXW261218C8100000"]

    def test_whose_legs_are_not_json_cannot_be_read(self):
        # the sweep's guard turns this into a quarantine of one rule, not a failed sweep
        with pytest.raises(ValueError):
            to_monitor(stored_monitor(legs="{not json"))


class TestAPosition:
    def test_reaches_the_domain_with_its_legs_parsed_and_its_opened(self):
        assert to_position(stored_position()) == Position(
            id="p".ljust(32, "1"),
            name="dec-condor",
            strategy="iron_condor",
            opened_at="2026-10-12",
            strike_date="2026-12-18",
            contracts=2,
            entry=6.4,
            legs=(
                Leg(side="short", option_type="CALL", strike=8100),
                Leg(side="long", option_type="CALL", strike=8150),
            ),
        )

    def test_keeps_an_unknown_entry_and_strategy_and_opened_unknown(self):
        p = to_position(stored_position(entry=None, strategy=None, opened_at=None))
        assert (p.entry, p.strategy, p.opened_at) == (None, None, None)

    def test_whose_legs_are_not_json_cannot_be_read(self):
        with pytest.raises(ValueError):
            to_position(stored_position(legs="{not json"))


class TestWhatOnlyThePythonCanGetWrong:
    def test_a_position_with_null_legs_holds_none_rather_than_failing(self):
        # `?? []`: the column is NOT NULL, so only a hand edit gets here, and the TypeScript reads it
        # as a holding of nothing — a None reaching the domain's tuple would refuse it instead
        assert to_position(stored_position(legs=None)).legs == ()

    def test_json_that_javascript_refuses_is_refused_here_too(self):
        # Python's json reads a bare NaN, which JSON.parse refuses: a row the TypeScript quarantines
        # must not be one the Python sweeps (db/values.py)
        with pytest.raises(ValueError):
            to_monitor(stored_monitor(legs='[{"sign":1,"option_type":"CALL","strike":NaN}]'))

    def test_legs_that_parse_but_are_not_legs_are_refused_here_rather_than_at_their_first_use(self):
        # the TypeScript's cast lets these through, to fail (or not) wherever they are first used; the
        # library's models validate, so the Python refuses them at once — which, inside the sweep's
        # guard, is the same quarantine as unreadable JSON
        with pytest.raises(pydantic.ValidationError):
            to_monitor(stored_monitor(legs='[{"option_type":"CALL","strike":8100}]'))
        with pytest.raises(pydantic.ValidationError):
            to_position(stored_position(legs='[{"side":"sold","option_type":"CALL","strike":8100}]'))
