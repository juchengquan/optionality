"""What the API accepts for a position.

backend/src/schemas/position.ts has no test of its own: its callers' suites rely on it. So this holds
what they rely on — `entrypoints/http/routes/positions.test.ts` on a single held option being a
position, no legs being refused, a side that is neither short nor long (the old "sold" included)
being refused, a compact date normalised and an impossible one refused, contracts defaulting where
the route applies it and zero refused, an Opened that is not a date refused, and a PATCH carrying only
what it was given; `app.test.ts` on a body with a name that is not a string being refused; and the
door scenario "post-positions-refuses-a-holding-with-no-legs".
"""

import pytest

from optionality_backend.schemas.position import DEFAULT_CONTRACTS, PositionIn, PositionPatch
from optionality_backend.schemas.zod import ZodError, parse, prettify_error

LEG = {"side": "short", "option_type": "CALL", "strike": 8050}


def condor(**over):
    return {
        "name": "dec-condor",
        "strike_date": "2026-12-18",
        "legs": [LEG, {**LEG, "side": "long", "strike": 8075}],
        **over,
    }


def detail(schema, body) -> str:
    with pytest.raises(ZodError) as err:
        parse(schema, body)
    return prettify_error(err.value)


class TestCreating:
    def test_accepts_a_single_held_option_as_a_position(self):
        given = parse(PositionIn, condor(legs=[LEG]))
        assert [(leg.side, leg.option_type, leg.strike) for leg in given.legs] == [("short", "CALL", 8050.0)]

    def test_refuses_a_position_with_no_legs_at_all(self):
        assert detail(PositionIn, condor(legs=[])) == "✖ Too small: expected array to have >=1 items\n  → at legs"

    def test_refuses_a_side_that_is_neither_long_nor_short_including_the_old_sold_and_bought(self):
        for side in ["sold", "bought", "buy"]:
            assert detail(PositionIn, condor(legs=[{**LEG, "side": side}])) == (
                '✖ Invalid option: expected one of "short"|"long"\n  → at legs[0].side'
            )

    def test_normalises_a_compact_date_and_refuses_an_impossible_one(self):
        assert parse(PositionIn, condor(strike_date="20261218")).strike_date == "2026-12-18"
        assert detail(PositionIn, condor(strike_date="2026-02-30")) == (
            "✖ invalid strike_date '2026-02-30': use YYYY-MM-DD or YYYYMMDD\n  → at strike_date"
        )

    def test_leaves_contracts_for_the_route_to_default_to_one_and_refuses_zero(self):
        given = parse(PositionIn, condor())
        assert (given.contracts, given.entry, given.strategy, given.opened_at) == (None, None, None, None)
        assert DEFAULT_CONTRACTS == 1
        assert detail(PositionIn, condor(contracts=0)) == "✖ Too small: expected number to be >=1\n  → at contracts"

    def test_takes_an_unknown_entry_strategy_and_opened_as_null(self):
        given = parse(PositionIn, condor(entry=None, strategy=None, opened_at=None))
        assert (given.entry, given.strategy, given.opened_at) == (None, None, None)

    def test_normalises_an_opened_and_refuses_one_that_is_not_a_date(self):
        assert parse(PositionIn, condor(opened_at="20261012")).opened_at == "2026-10-12"
        assert detail(PositionIn, condor(opened_at="last tuesday")) == (
            "✖ invalid strike_date 'last tuesday': use YYYY-MM-DD or YYYYMMDD\n  → at opened_at"
        )

    def test_refuses_a_name_that_is_not_a_string(self):
        assert detail(PositionIn, condor(name=1)) == "✖ Invalid input: expected string, received number\n  → at name"


class TestPatching:
    def test_carries_only_what_it_was_given(self):
        given = parse(PositionPatch, {"entry": 3.0, "opened_at": "20261012"})
        assert given.model_dump(exclude_unset=True) == {"entry": 3.0, "opened_at": "2026-10-12"}

    def test_never_carries_legs(self):
        # a different structure is a different holding: the key is dropped
        assert parse(PositionPatch, {"legs": [LEG]}).model_fields_set == set()

    def test_refuses_a_null_where_the_typescript_only_lets_a_key_be_absent(self):
        assert (
            detail(PositionPatch, {"strategy": None})
            == "✖ Invalid input: expected string, received null\n  → at strategy"
        )
