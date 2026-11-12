"""zod's refusals, in zod's words: `schemas/zod.py`, which has no TypeScript counterpart.

It stands in for the `zod` library, so what it is held to is zod itself. Every expected string here is
what zod 4.6 answered for the same JSON body against the TypeScript's own schema — the request
schemas are what the checks are exercised through, because those are the only shapes the words have
to be right for. The per-schema suites beside this one hold what the routes' tests rely on; this one
holds the machinery, and what zod does by being zod.
"""

from typing import Annotated

import pytest

from optionality_backend.schemas.monitor import ComboMonitorIn, MonitorCreateIn, MonitorIn, MonitorPatch
from optionality_backend.schemas.position import PayoffIn, PositionIn, PositionPatch
from optionality_backend.schemas.reference import ReferenceIn
from optionality_backend.schemas.spread import SpreadIn, SpreadsIn
from optionality_backend.schemas.zod import Number, Shape, ZodError, parse, prettify_error, prettify_issues

LEG = {"side": "short", "option_type": "CALL", "strike": 8100}
CLEG = {"sign": 1, "option_type": "CALL", "strike": 8100}


def refusal(schema, value) -> str:
    with pytest.raises(ZodError) as err:
        parse(schema, value)
    return prettify_error(err.value)


def held(**over):
    return {"name": "dec-condor", "strike_date": "2026-12-18", "legs": [LEG], **over}


def wing(**over):
    return {
        "name": "dec-wing",
        "strike_date": "20261218",
        "legs": [CLEG, {**CLEG, "sign": -1}],
        "threshold": 10,
        **over,
    }


class TestTheText:
    def test_puts_each_issue_on_a_cross_with_where_it_is_beneath_shallowest_first(self):
        # sorted by depth, stably: issues at one depth keep the order zod found them in
        assert prettify_issues([(("legs", 0, "a"), "deep"), (("b",), "first"), ((), "root"), (("c",), "second")]) == (
            "✖ root\n✖ first\n  → at b\n✖ second\n  → at c\n✖ deep\n  → at legs[0].a"
        )

    def test_writes_a_key_that_is_not_a_javascript_word_in_brackets_and_quotes(self):
        assert prettify_issues([(("1",), "m"), (("a-b", 0), "n")]) == '✖ m\n  → at 1\n✖ n\n  → at ["a-b"][0]'

    def test_says_every_key_a_body_lacks_in_the_order_the_shape_declares_them(self):
        assert refusal(PositionIn, {}) == (
            "✖ Invalid input: expected string, received undefined\n  → at name\n"
            "✖ Invalid input: expected string, received undefined\n  → at strike_date\n"
            "✖ Invalid input: expected array, received undefined\n  → at legs"
        )

    def test_names_what_a_body_that_is_not_an_object_is_with_no_path(self):
        assert refusal(PositionIn, None) == "✖ Invalid input: expected object, received null"
        assert refusal(PositionIn, []) == "✖ Invalid input: expected object, received array"
        assert refusal(PositionIn, "x") == "✖ Invalid input: expected object, received string"


class TestWhatZodDoesByBeingZod:
    def test_an_absent_enum_is_an_invalid_option_not_an_undefined(self):
        assert refusal(ReferenceIn, {"code": "US.SPY"}) == (
            '✖ Invalid option: expected one of "moomoo"|"ibkr"|"yahoo"\n  → at source'
        )

    def test_a_length_is_checked_even_on_a_value_whose_type_was_refused(self):
        assert refusal(ComboMonitorIn, wing(legs="x")) == (
            "✖ Invalid input: expected array, received string\n  → at legs\n"
            "✖ Too small: expected string to have >=2 characters\n  → at legs"
        )
        assert refusal(ReferenceIn, {"code": [], "source": "moomoo"}) == (
            "✖ Invalid input: expected string, received array\n  → at code\n"
            "✖ Too small: expected array to have >=1 items\n  → at code"
        )
        # an object with a "length" has one, as far as JavaScript is concerned
        assert refusal(ReferenceIn, {"code": {"length": 0}, "source": "moomoo"}) == (
            "✖ Invalid input: expected string, received object\n  → at code\n"
            "✖ Too small: expected unknown to be >=1\n  → at code"
        )

    def test_an_array_too_short_is_said_with_whatever_is_wrong_inside_it(self):
        # pydantic reports the elements of a list that is also too short, and stops there
        assert refusal(ComboMonitorIn, wing(legs=[{**CLEG, "sign": 2}])) == (
            "✖ Too small: expected array to have >=2 items\n  → at legs\n"
            "✖ Invalid option: expected one of 1|-1\n  → at legs[0].sign"
        )

    def test_an_array_too_long_is_said_as_zod_says_it_measured_against_zod_itself(self):
        # `.max(n)`, `.min(n)`'s mirror, with what zod 4.6 answered for each of these (#293)
        spread = {"name": "w", "legs": [], "held": False, "monitors": []}
        leg = {"side": "short", "option_type": "PUT", "strike": 1}
        assert refusal(SpreadsIn, {"strike_date": "2026-12-18", "spreads": [spread] * 9}).startswith(
            "✖ Too big: expected array to have <=8 items\n  → at spreads\n"
        )
        assert refusal(SpreadIn, {**spread, "legs": [leg] * 5}) == (
            "✖ Too big: expected array to have <=4 items\n  → at legs"
        )
        # guarded like `.min`: run on a value whose type was refused, and on an object with a "length"
        assert refusal(SpreadIn, {**spread, "legs": "xxxxx"}) == (
            "✖ Invalid input: expected array, received string\n  → at legs\n"
            "✖ Too big: expected string to have <=4 characters\n  → at legs"
        )
        assert refusal(SpreadIn, {**spread, "legs": {"length": 5}}) == (
            "✖ Invalid input: expected array, received object\n  → at legs\n"
            "✖ Too big: expected unknown to be <=4\n  → at legs"
        )

    def test_a_json_number_is_a_javascript_number(self):
        # 2.0 IS 2 in JavaScript, and 1.0 is 1: an int, and a sign
        assert parse(PositionIn, held(contracts=2.0)).contracts == 2
        assert parse(ComboMonitorIn, wing(legs=[{**CLEG, "sign": 1.0}, {**CLEG, "sign": -1.0}])).legs[1].sign == -1
        # and a number too big for a double is Infinity, which zod names
        assert refusal(PositionIn, held(entry=float("inf"))) == (
            "✖ Invalid input: expected number, received Infinity\n  → at entry"
        )
        assert refusal(PositionIn, held(entry=-(10**400))) == (
            "✖ Invalid input: expected number, received -Infinity\n  → at entry"
        )

    def test_true_is_not_one(self):
        # pydantic's strict Literal[1, -1] takes it; zod's Set does not
        assert refusal(ComboMonitorIn, wing(legs=[{**CLEG, "sign": True}, CLEG])) == (
            "✖ Invalid option: expected one of 1|-1\n  → at legs[0].sign"
        )
        assert (
            refusal(MonitorPatch, {"enabled": 1})
            == "✖ Invalid input: expected boolean, received number\n  → at enabled"
        )

    def test_an_int_is_a_number_then_an_integer_then_a_safe_one_then_its_minimum(self):
        assert refusal(PositionIn, held(contracts="2")) == (
            "✖ Invalid input: expected number, received string\n  → at contracts"
        )
        assert (
            refusal(PositionIn, held(contracts=1.5))
            == "✖ Invalid input: expected int, received number\n  → at contracts"
        )
        assert refusal(PositionIn, held(contracts=2**60)) == (
            "✖ Too big: expected int to be <=9007199254740991\n  → at contracts"
        )
        assert refusal(PositionIn, held(contracts=-(2**60))) == (
            "✖ Too small: expected int to be >=-9007199254740991\n  → at contracts\n"
            "✖ Too small: expected number to be >=1\n  → at contracts"
        )

    def test_a_positive_number_is_a_number_then_above_zero(self):
        # `z.number().positive()`, which PayoffIn's strike is: zod 4.6's words for both refusals
        leg = {"side": "short", "option_type": "PUT"}
        assert refusal(PayoffIn, {"legs": [{**leg, "strike": 0}], "entry": 1}) == (
            "✖ Too small: expected number to be >0\n  → at legs[0].strike"
        )
        assert refusal(PayoffIn, {"legs": [{**leg, "strike": "7100"}], "entry": 1}) == (
            "✖ Invalid input: expected number, received string\n  → at legs[0].strike"
        )
        assert parse(PayoffIn, {"legs": [{**leg, "strike": 0.5}], "entry": 1}).legs[0].strike == 0.5

    def test_an_optional_key_may_be_absent_but_not_null_and_a_nullish_one_may_be_either(self):
        assert (
            refusal(PositionPatch, {"entry": None}) == "✖ Invalid input: expected number, received null\n  → at entry"
        )
        assert parse(PositionIn, held(entry=None)).entry is None
        assert parse(PositionPatch, {}).model_fields_set == set()

    def test_trims_as_javascript_trims(self):
        # a byte-order mark and a no-break space are whitespace to JavaScript; \x1c is not, though
        # Python's own strip() would take it
        assert parse(ReferenceIn, {"code": "\ufeffus.qqq\xa0", "source": "moomoo"}).code == "US.QQQ"
        assert parse(ReferenceIn, {"code": "\x1c", "source": "moomoo"}).code == "\x1c"

    def test_a_union_that_every_member_refuses_says_only_that(self):
        # why the route picks the member by the body's shape instead (monitor_create_member)
        assert refusal(MonitorCreateIn, {}) == "✖ Invalid input"
        assert isinstance(parse(MonitorCreateIn, wing()), ComboMonitorIn)
        assert isinstance(
            parse(
                MonitorCreateIn, {"strike_date": "2026-12-18", "option_type": "PUT", "strike": 7000, "threshold": 0.3}
            ),
            MonitorIn,
        )

    def test_drops_a_key_the_shape_does_not_declare(self):
        assert parse(MonitorPatch, {"threshold": 25, "legs": [CLEG]}).model_dump(exclude_unset=True) == {
            "threshold": 25
        }


class TestWhatOnlyThePythonCanGetWrong:
    def test_a_shape_with_a_field_no_check_here_covers_is_refused_when_it_is_declared(self):
        # it would be refused in pydantic's words, which the dashboard would then print
        with pytest.raises(TypeError, match="no zod schema"):

            class Bare(Shape):
                n: int

    def test_a_shape_whose_every_field_is_covered_is_accepted(self):
        class Covered(Shape):
            n: Annotated[float, Number()]

        assert parse(Covered, {"n": 1}).n == 1.0

    def test_text_that_looks_like_a_template_is_not_one(self):
        # pydantic formats a custom error's message from a template; a refused value with braces in
        # it must come back as it was typed
        assert refusal(MonitorIn, {"strike_date": "{x} '{y}'", "option_type": "CALL", "strike": 1, "threshold": 1}) == (
            "✖ invalid strike_date '{x} '{y}'': use YYYY-MM-DD or YYYYMMDD\n  → at strike_date"
        )
