"""What the API accepts for a monitor.

backend/src/schemas/monitor.ts has no test of its own: its callers' suites rely on it. So this holds
what they rely on — `entrypoints/http/routes/monitors.test.ts` on a compact date stored dashed, a date
that is neither form refused, what is wrong with a body said in zod's words "whichever of the two
shapes it is", a body carrying legs read as a combo, an option type and a direction outside their
enums, a combo needing two legs, a PATCH dropping the legs it carries, and the two wordings of a
threshold the rule refuses; and the door scenarios for POST /monitors' refusals. The routes apply
the defaults, so those are only held to their values here.
"""

import pytest

from optionality_backend.schemas.monitor import (
    DEFAULT_COMBO_FIELD,
    DEFAULT_COMPARE,
    DEFAULT_DIRECTION,
    DEFAULT_ENABLED,
    DEFAULT_SINGLE_FIELD,
    DISABLED_REASONS,
    ComboMonitorIn,
    MonitorIn,
    MonitorPatch,
    TotalEntryIn,
    is_combo,
    monitor_create_member,
    patch_threshold_error,
    threshold_error,
)
from optionality_backend.schemas.zod import ZodError, parse, prettify_error

COMBO_LEGS = [{"sign": 1, "option_type": "CALL", "strike": 8100}, {"sign": -1, "option_type": "CALL", "strike": 8150}]


def single(**over):
    return {"strike_date": "2026-11-01", "option_type": "CALL", "strike": 6500, "threshold": 0.6, **over}


def combo(**over):
    return {
        "name": "sep-condor",
        "legs": COMBO_LEGS,
        "threshold": 10,
        "direction": "below",
        "strike_date": "2026-11-01",
        **over,
    }


def create(body):
    """What POST /monitors does with a body: the member its shape names, and that member alone."""
    return parse(monitor_create_member(body), body)


def detail(body) -> str:
    with pytest.raises(ZodError) as err:
        create(body)
    return prettify_error(err.value)


class TestDatesAndShapes:
    def test_normalises_a_compact_date_to_the_dashed_form(self):
        assert create(single(strike_date="20261101")).strike_date == "2026-11-01"
        assert create(combo(strike_date="20261101")).strike_date == "2026-11-01"

    def test_rejects_a_date_that_is_not_one_of_the_two_forms_and_an_impossible_one(self):
        for bad in ["18-12-2026", "2026-13-45", "2026-02-30", "nope"]:
            with pytest.raises(ZodError):
                create(single(strike_date=bad))

    def test_says_what_is_wrong_with_a_body_whichever_of_the_two_shapes_it_is(self):
        date = "✖ invalid strike_date '18 Dec': use YYYY-MM-DD or YYYYMMDD\n  → at strike_date"
        assert detail(single(strike_date="18 Dec")) == date
        assert detail(combo(strike_date="18 Dec")) == date, "and a combo's"
        no_threshold = single()
        del no_threshold["threshold"]
        assert detail(no_threshold) == "✖ Invalid input: expected number, received undefined\n  → at threshold"
        assert detail(combo(legs=[{**COMBO_LEGS[0], "sign": 2}, COMBO_LEGS[1]])) == (
            "✖ Invalid option: expected one of 1|-1\n  → at legs[0].sign"
        )

    def test_reads_a_body_that_carries_legs_as_a_combo_and_refuses_it_as_one(self):
        # the union took this as a single-leg rule and dropped the legs without a word
        assert detail(single(legs=COMBO_LEGS)) == "✖ Invalid input: expected string, received undefined\n  → at name"

    def test_rejects_an_option_type_that_is_not_call_or_put_and_a_direction_that_is_neither(self):
        assert detail(single(option_type="FOO")) == '✖ Invalid option: expected one of "CALL"|"PUT"\n  → at option_type'
        assert detail(single(direction="sideways")) == (
            '✖ Invalid option: expected one of "above"|"below"\n  → at direction'
        )

    def test_takes_what_it_was_given_and_leaves_the_rest_absent_for_the_route_to_default(self):
        given = create(single(direction="below"))
        assert isinstance(given, MonitorIn)
        assert (given.direction, given.field, given.compare, given.enabled) == ("below", None, None, None)
        assert given.model_fields_set == {"strike_date", "option_type", "strike", "threshold", "direction"}


class TestCombos:
    def test_reads_a_combo_with_its_legs_signed(self):
        given = create(combo())
        assert is_combo(given)
        assert isinstance(given, ComboMonitorIn)
        assert [(leg.sign, leg.strike) for leg in given.legs] == [(1, 8100.0), (-1, 8150.0)]
        assert not is_combo(create(single()))

    def test_needs_at_least_two_legs_to_be_a_combo_at_all(self):
        assert (
            detail(combo(name="x", legs=COMBO_LEGS[:1])) == "✖ Too small: expected array to have >=2 items\n  → at legs"
        )

    def test_keeps_its_legs_through_an_edit_that_tries_to_carry_new_ones(self):
        # MonitorPatch has no `legs`, so the key is dropped silently, not rejected, and the rest of
        # the patch still applies
        given = parse(MonitorPatch, {"threshold": 25, "legs": COMBO_LEGS})
        assert given.model_dump(exclude_unset=True) == {"threshold": 25}

    def test_a_body_that_is_not_an_object_is_a_single_leg_body(self):
        # `"legs" in body` is false of anything that is not an object, so the single-leg member says
        # what is wrong with it
        assert monitor_create_member(["legs"]) is MonitorIn
        assert monitor_create_member("legs") is MonitorIn
        assert monitor_create_member(None) is MonitorIn
        assert monitor_create_member({"legs": None}) is ComboMonitorIn


class TestThresholds:
    def test_says_which_rule_the_threshold_broke_not_merely_that_it_broke_one(self):
        assert threshold_error("abs", 0) == (
            "threshold must be positive when compare='abs' (values are compared as absolutes)"
        )
        assert threshold_error("abs", -4.05) == threshold_error("abs", 0)
        assert (
            threshold_error("signed", 0) == "signed threshold cannot be 0 (zero-width hysteresis band); use e.g. ±0.01"
        )
        assert threshold_error("signed", -4.05) is None
        assert threshold_error("abs", 0.3) is None

    def test_and_patch_keeps_its_own_shorter_wording_for_the_same_two_faults(self):
        assert patch_threshold_error("abs", -1) == "threshold must be positive when compare='abs'"
        assert patch_threshold_error("signed", 0) == "signed threshold cannot be 0; use e.g. ±0.01"
        assert patch_threshold_error("signed", -5) is None


class TestTheRest:
    def test_a_total_entry_is_a_number(self):
        assert parse(TotalEntryIn, {"entry": 3.21}).entry == 3.21
        with pytest.raises(ZodError) as err:
            parse(TotalEntryIn, {})
        assert prettify_error(err.value) == "✖ Invalid input: expected number, received undefined\n  → at entry"

    def test_the_defaults_are_declared_once_with_their_values(self):
        assert (DEFAULT_SINGLE_FIELD, DEFAULT_COMBO_FIELD, DEFAULT_DIRECTION, DEFAULT_COMPARE, DEFAULT_ENABLED) == (
            "option_delta",
            "mid_price",
            "above",
            "abs",
            True,
        )

    def test_names_every_reason_the_service_disables_a_rule_for(self):
        # the dashboard groups its muted tables by these; a reason with no group hides its row
        assert DISABLED_REASONS == ("unknown-contract", "no-figure", "unreadable", "expired", "manual")
