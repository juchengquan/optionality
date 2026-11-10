"""Stored rows into the shapes the domain works in, and REFUSED when they are not one. Port of
backend/src/hydrate.test.ts.

Refused rather than cast (#266): the TypeScript's cast handed a leg with no sign to the maths, which
swept it with a NaN where the sign should be, while this port's models refused the same row and
quarantined it. Both now refuse what the domain's types say no to, naming the row and the field in
the same words — `/positions/values` answers with them, so a difference would be a different reply.

What only the Python can get wrong is at the end.
"""

import pytest
from optionality.monitor import Monitor, MonitorLeg, monitor_leg_codes
from optionality.position import Leg, Position

from optionality_backend.hydrate import to_monitor, to_position

COMBO_LEGS = '[{"sign":1,"option_type":"CALL","strike":8100},{"sign":-1,"option_type":"CALL","strike":8150}]'
HELD_LEGS = '[{"side":"short","option_type":"CALL","strike":8100},{"side":"long","option_type":"CALL","strike":8150}]'
BLOB = bytes([1, 2])


def stored_monitor(**over):
    return {
        "id": "mon-1",
        "code": "dec-wing",
        "strike_date": "2026-12-18",
        "option_type": "CMB",
        "strike": 0,
        "field": "mid_price",
        "threshold": 9.5,
        "direction": "below",
        "compare": "signed",
        "legs": COMBO_LEGS,
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
        "id": "pos-1",
        "name": "dec-condor",
        "strategy": "iron_condor",
        "strike_date": "2026-12-18",
        "contracts": 2,
        "entry": 6.4,
        "legs": HELD_LEGS,
        "created_at": "2026-11-08 00:00:00.000000",
        "opened_at": "2026-10-12",
        "manage_notified_at": None,
        "closed_on": None,
        "exit": None,
        **over,
    }


def refusal(call, why):
    with pytest.raises(ValueError) as caught:
        call()
    assert str(caught.value) == why
    return caught.value


class TestAMonitor:
    def test_reaches_the_domain_with_its_legs_parsed_and_nothing_the_domain_does_not_hold(self):
        legs = '[{"sign":1,"option_type":"CALL","strike":8100,"note":"mine"},{"sign":-1,"option_type":"CALL","strike":8150}]'
        assert to_monitor(stored_monitor(legs=legs)) == Monitor(
            id="mon-1",
            code="dec-wing",
            strike_date="2026-12-18",
            option_type="CMB",
            strike=0,
            field="mid_price",
            threshold=9.5,
            direction="below",
            compare="signed",
            legs=(
                MonitorLeg(sign=1, option_type="CALL", strike=8100),
                MonitorLeg(sign=-1, option_type="CALL", strike=8150),
            ),
        )

    def test_with_no_legs_stored_or_an_empty_list_is_a_single_leg_rule(self):
        single = to_monitor(stored_monitor(code="US.SPXW261218C8100000", option_type="CALL", strike=8100, legs=None))
        assert single.legs is None
        assert monitor_leg_codes(single) == ["US.SPXW261218C8100000"]
        assert to_monitor(stored_monitor(legs="null")).legs is None
        assert to_monitor(stored_monitor(legs="[]")).legs == ()

    def test_reads_a_sign_written_as_1_0_as_the_1_it_is(self):
        legs = '[{"sign":1.0,"option_type":"CALL","strike":8100},{"sign":-1.0,"option_type":"PUT","strike":6400.5}]'
        assert to_monitor(stored_monitor(legs=legs)).legs == (
            MonitorLeg(sign=1, option_type="CALL", strike=8100),
            MonitorLeg(sign=-1, option_type="PUT", strike=6400.5),
        )

    def test_whose_legs_are_not_json_cannot_be_read_in_words_of_its_own_and_with_the_parser_s_as_the_cause(self):
        err = refusal(
            lambda: to_monitor(stored_monitor(legs="{not json")), "monitor dec-wing cannot be read: legs must be JSON"
        )
        assert isinstance(err.__cause__, ValueError)

    @pytest.mark.parametrize(
        ("over", "why"),
        [
            pytest.param({"legs": ""}, "legs must be JSON", id="legs that are empty text"),
            pytest.param(
                {"legs": '[{"sign":1,"option_type":"CALL","strike":NaN}]'}, "legs must be JSON", id="legs with a NaN"
            ),
            # the column's affinity is NUMERIC, so a number is what SQLite hands back for legs of '5'
            pytest.param({"legs": 5}, "legs must be a list", id="legs stored as a number"),
            pytest.param({"legs": float("inf")}, "legs must be JSON", id="legs stored as an infinite number"),
            pytest.param({"legs": BLOB}, "legs must be JSON", id="legs stored as bytes"),
            pytest.param({"legs": bytes([5])}, "legs must be JSON", id="legs stored as one byte"),
            # which Python's json would read, where JSON.parse reads only `String(bytes)`
            pytest.param({"legs": b"[]"}, "legs must be JSON", id="legs stored as bytes that are JSON"),
            pytest.param(
                {"legs": '[{"option_type":"CALL","strike":8100}]'},
                "legs[0].sign must be 1 or -1",
                id="a leg with no sign",
            ),
            pytest.param(
                {
                    "legs": '[{"sign":1,"option_type":"CALL","strike":8100},'
                    + '{"sign":"-1","option_type":"CALL","strike":8150}]'
                },
                "legs[1].sign must be 1 or -1",
                id="a sign in quotes",
            ),
            pytest.param(
                {"legs": '[{"sign":true,"option_type":"CALL","strike":8100}]'},
                "legs[0].sign must be 1 or -1",
                id="a sign of true",
            ),
            pytest.param(
                {"legs": '[{"sign":2,"option_type":"CALL","strike":8100}]'},
                "legs[0].sign must be 1 or -1",
                id="a sign of 2",
            ),
            pytest.param(
                {"legs": '[{"sign":1,"option_type":"call","strike":8100}]'},
                'legs[0].option_type must be "CALL" or "PUT"',
                id="a lower-case type",
            ),
            pytest.param(
                {"legs": '[{"sign":1,"option_type":"CALL","strike":"8100"}]'},
                "legs[0].strike must be a number",
                id="a strike in quotes",
            ),
            pytest.param({"legs": "[null]"}, "legs[0] must be an object", id="a leg that is no object"),
            pytest.param({"legs": '[[1,"CALL",8100]]'}, "legs[0] must be an object", id="a leg that is a list"),
            pytest.param({"legs": '{"sign":1}'}, "legs must be a list", id="legs that are no list"),
            pytest.param({"legs": "5"}, "legs must be a list", id="legs that are a number"),
            pytest.param({"strike": "abc"}, "strike must be a number", id="a strike that is text"),
            pytest.param({"threshold": None}, "threshold must be a number", id="a threshold that is missing"),
            pytest.param({"direction": BLOB}, "direction must be text", id="a direction that is bytes"),
        ],
    )
    def test_refuses_naming_the_rule_and_the_field(self, over, why):
        refusal(lambda: to_monitor(stored_monitor(**over)), f"monitor dec-wing cannot be read: {why}")

    @pytest.mark.parametrize("legs", ['[{"option_type":"CALL","strike":8100}]', "{not json"])
    def test_refuses_the_first_fault_in_field_order_so_both_backends_name_the_same_one(self, legs):
        refusal(
            lambda: to_monitor(stored_monitor(strike="abc", legs=legs)),
            "monitor dec-wing cannot be read: strike must be a number",
        )

    def test_refuses_a_code_that_is_not_text_without_naming_the_rule_by_it(self):
        refusal(lambda: to_monitor(stored_monitor(code=BLOB)), "a monitor cannot be read: code must be text")


class TestAPosition:
    def test_reaches_the_domain_with_its_legs_parsed_and_its_opened(self):
        legs = '[{"side":"short","option_type":"CALL","strike":8100,"filled_at":6.45},{"side":"long","option_type":"CALL","strike":8150}]'
        assert to_position(stored_position(legs=legs)) == Position(
            id="pos-1",
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

    def test_with_null_legs_holds_nothing_rather_than_failing(self):
        # `?? []`: the column is NOT NULL, so only a hand edit gets here
        assert to_position(stored_position(legs=None)).legs == ()
        assert to_position(stored_position(legs="null")).legs == ()

    def test_whose_legs_are_not_json_cannot_be_read(self):
        refusal(
            lambda: to_position(stored_position(legs="{not json")),
            "position dec-condor cannot be read: legs must be JSON",
        )

    @pytest.mark.parametrize(
        ("over", "why"),
        [
            pytest.param(
                {"legs": '[{"side":"sold","option_type":"CALL","strike":8100}]'},
                'legs[0].side must be "short" or "long"',
                id="a side of sold",
            ),
            pytest.param(
                {
                    "legs": '[{"side":"short","option_type":"CALL","strike":8100},'
                    + '{"side":"long","option_type":"PUT"}]'
                },
                "legs[1].strike must be a number",
                id="a leg with no strike",
            ),
            pytest.param(
                {"legs": '[{"side":"long","strike":8100}]'},
                'legs[0].option_type must be "CALL" or "PUT"',
                id="a leg with no type",
            ),
            pytest.param({"legs": '"short"'}, "legs must be a list", id="legs that are no list"),
            pytest.param({"contracts": 2.5}, "contracts must be a whole number", id="half a contract"),
            pytest.param({"contracts": "2"}, "contracts must be a whole number", id="contracts as text"),
            pytest.param({"entry": "6.4"}, "entry must be a number or null", id="an entry as text"),
            pytest.param({"strategy": BLOB}, "strategy must be text or null", id="a strategy that is bytes"),
            pytest.param({"opened_at": 20261012}, "opened_at must be text or null", id="an opened that is a number"),
            pytest.param({"strike_date": None}, "strike_date must be text", id="a strike date that is missing"),
        ],
    )
    def test_refuses_naming_the_holding_and_the_field(self, over, why):
        refusal(lambda: to_position(stored_position(**over)), f"position dec-condor cannot be read: {why}")

    def test_refuses_a_name_that_is_not_text_without_naming_the_holding_by_it(self):
        refusal(lambda: to_position(stored_position(name=BLOB)), "a position cannot be read: name must be text")


class TestWhatOnlyThePythonCanGetWrong:
    def test_a_bool_is_never_a_number(self):
        # True is an int to Python and never a number to JavaScript
        refusal(
            lambda: to_monitor(stored_monitor(strike=True)), "monitor dec-wing cannot be read: strike must be a number"
        )
        refusal(
            lambda: to_position(stored_position(contracts=True)),
            "position dec-condor cannot be read: contracts must be a whole number",
        )

    def test_a_whole_float_is_a_whole_number_as_number_is_integer_says(self):
        assert to_position(stored_position(contracts=2.0)).contracts == 2

    def test_what_pydantic_would_coerce_is_refused_before_it_can(self):
        # the library's models are lax: a strike of "8100" and a sign of "1" would pass them
        refusal(
            lambda: to_monitor(stored_monitor(legs='[{"sign":"1","option_type":"CALL","strike":8100}]')),
            "monitor dec-wing cannot be read: legs[0].sign must be 1 or -1",
        )
        refusal(
            lambda: to_position(stored_position(legs='[{"side":"short","option_type":"CALL","strike":"8100"}]')),
            "position dec-condor cannot be read: legs[0].strike must be a number",
        )
