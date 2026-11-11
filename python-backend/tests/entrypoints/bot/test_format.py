"""How the bot writes things, asserted character for character (ADR 0009, phase 7). Port of
backend/src/entrypoints/bot/format.test.ts. `standing_note` has no test there: `bot.test.ts`'s
`/holdings` tests hold it, and so do their ports in `test_bot.py`.

`in` is not enough here, and a mutation sweep proved it: the bot's own tests passed with the column
padding removed, with one space between columns instead of two, with the HTML escaping applied in the
wrong order, and with a delta printed to four places. Every one of those is a table that reads wrongly
on a phone, and none of them changes whether a substring appears.

So these are whole strings. Where a figure's precision is the point, the exact digits are the
assertion.

What only the Python can get wrong is at the end.
"""

import math
import re
from typing import Any

from optionality_backend.entrypoints.bot.format import (
    BOT_COMMANDS,
    HELP_TEXT,
    escape_html,
    fixed,
    fmt_value,
    has_format,
    js_text,
    py_number,
    rule_text,
    standing_note,
    table,
    threshold_error,
)
from optionality_backend.holdings import HoldingValue


class TestEscapeHtml:
    def test_escapes_what_python_s_html_escape_does_quotes_included(self):
        assert escape_html("a&b") == "a&amp;b"
        assert escape_html("a<b>c") == "a&lt;b&gt;c"
        assert escape_html('say "hi"') == "say &quot;hi&quot;"
        assert escape_html("it's") == "it&#x27;s"
        assert escape_html("plain") == "plain"

    def test_escapes_the_ampersand_first_or_every_entity_gets_escaped_twice(self):
        # with < handled before &, "a<b" becomes "a&lt;b" and then "a&amp;lt;b"
        assert escape_html("a<b") == "a&lt;b"
        assert escape_html("&lt;") == "&amp;lt;"

    def test_leaves_the_characters_the_tables_are_actually_made_of_alone(self):
        assert escape_html("261030 C8100 ≥0.6 🔔 —") == "261030 C8100 ≥0.6 🔔 —"


class TestTable:
    def test_pads_every_column_to_its_widest_cell_and_separates_them_with_two_spaces(self):
        assert table(["contract", "mid"], [["261030 C8100", "4.5"], ["261101 P7100", "12.25"]]) == (
            "<pre>contract      mid\n261030 C8100  4.5\n261101 P7100  12.25</pre>"
        )

    def test_strips_the_trailing_space_a_short_last_cell_would_leave(self):
        # a line ending in spaces inside <pre> is a ragged right edge on the phone
        assert table(["a", "b"], [["x", "yy"], ["x", "z"]]) == "<pre>a  b\nx  yy\nx  z</pre>"

    def test_measures_the_header_too_so_a_wide_heading_widens_its_column(self):
        assert table(["contract", "f"], [["x", "y"]]) == "<pre>contract  f\nx         y</pre>"

    def test_escapes_the_cells_and_measures_the_escaped_text_as_the_python_does(self):
        # arguably wrong — &amp; is five characters of width for one of content — but it is what the
        # Python ships, and no contract code contains an escapable character, so the rows it could
        # misalign do not occur
        assert table(["a"], [["x&y"]]) == "<pre>a\nx&amp;y</pre>"

    def test_is_a_pre_block_which_is_what_makes_telegram_render_it_monospaced(self):
        out = table(["a"], [["b"]])
        assert out.startswith("<pre>")
        assert out.endswith("</pre>")

    def test_renders_a_header_only_table(self):
        assert table(["a", "b"], []) == "<pre>a  b</pre>"

    def test_keeps_the_widest_real_row_to_its_ratified_budget(self):
        # ~40 monospace characters a row and four columns at most (CLAUDE.md). The widest real row is a
        # watchlist line, and it is 45 — asserted exactly rather than loosely, so adding a column or
        # widening a heading shows up here instead of as a wrapped table on the phone.
        row = (
            table(["contract", "field", "last", "thr", "state"], [["261030 C8100", "delta", "0.046", "≥0.6", "armed"]])
            .replace("<pre>", "")
            .replace("</pre>", "")
            .split("\n")[1]
        )
        assert row == "261030 C8100  delta  0.046  ≥0.6  armed"
        assert len(row) == 39


class TestFmtValue:
    def test_gives_a_delta_and_an_iv_three_places(self):
        assert fmt_value("option_delta", 0.512345) == "0.512"
        assert fmt_value("option_delta", 0.5) == "0.500"
        assert fmt_value("option_implied_volatility", 21.45678) == "21.457"
        assert has_format("option_delta") is True
        assert has_format("option_implied_volatility") is True

    def test_gives_everything_else_python_s_str(self):
        assert has_format("mid_price") is False
        assert fmt_value("mid_price", 4.5) == "4.5"
        assert fmt_value("mid_price", 5) == "5.0"
        assert fmt_value("bid_price", 1) == "1.0"
        assert fmt_value("anything", "N/A") == "N/A"


class TestPyNumber:
    def test_keeps_the_point_on_an_integral_value_as_python_s_str_does(self):
        assert py_number(0) == "0.0"
        assert py_number(1) == "1.0"
        assert py_number(100) == "100.0"
        assert py_number(-1) == "-1.0"
        assert py_number(123456789) == "123456789.0"

    def test_writes_the_shortest_round_trip_form_in_between(self):
        assert py_number(0.5) == "0.5"
        assert py_number(26.4) == "26.4"
        assert py_number(0.045548793) == "0.045548793"
        assert py_number(1 / 3) == "0.3333333333333333"

    def test_goes_exponential_exactly_where_python_does(self):
        # below 1e-4, and at 1e16. JavaScript's own String waits until 1e21, so these are the two
        # boundaries that had to be implemented rather than inherited.
        assert py_number(0.0001) == "0.0001"
        assert py_number(0.000015) == "1.5e-05"
        assert py_number(1e-7) == "1e-07"
        assert py_number(1e15) == "1000000000000000.0"
        assert py_number(1e16) == "1e+16"
        assert py_number(1e21) == "1e+21"

    def test_pads_the_exponent_to_two_digits_and_always_signs_it(self):
        assert py_number(1e-5) == "1e-05"
        assert py_number(1e-100) == "1e-100"

    def test_names_the_values_that_are_not_numbers_as_python_does(self):
        assert py_number(math.nan) == "nan"
        assert py_number(math.inf) == "inf"
        assert py_number(-math.inf) == "-inf"
        assert py_number(-0.0) == "-0.0"


class TestThresholdError:
    def test_says_what_to_add_rather_than_only_that_it_is_wrong(self):
        assert threshold_error("abs", -0.5) == (
            "Threshold must be positive — abs monitors compare magnitudes. Add 'signed' to compare raw values."
        )
        assert re.match(r"^Threshold must be positive", threshold_error("abs", 0) or "")
        assert threshold_error("signed", 0) == (
            "Signed threshold cannot be 0 (zero-width hysteresis band); use e.g. ±0.01."
        )

    def test_allows_what_should_be_allowed(self):
        assert threshold_error("abs", 0.6) is None
        assert threshold_error("signed", -4.05) is None
        assert threshold_error("signed", 0.01) is None


class TestRuleText:
    def test_says_the_rule_back_in_full_so_a_mistyped_direction_is_visible_at_once(self):
        assert (
            rule_text("Watching US.X", "option_delta", 0.6, "above", "abs")
            == "Watching US.X: alarm when abs(option_delta) ≥ 0.6"
        )
        assert rule_text("US.X", "mid_price", 30, "below", "abs") == "US.X: alarm when abs(mid_price) ≤ 30"
        # signed drops the abs(), because the sign is the point
        assert rule_text("bear-cs", "mid_price", -4.05, "below", "signed") == "bear-cs: alarm when mid_price ≤ -4.05"


class TestTheHelpAndTheMenu:
    def test_documents_every_command_the_menu_publishes_and_no_others(self):
        published = [c.command for c in BOT_COMMANDS]
        documented = [m.group(1) for line in HELP_TEXT.split("\n") if (m := re.match(r"^/([a-z]+)", line))]
        assert sorted(documented) == sorted(published)

    def test_must_never_be_html_parsed_which_is_why_it_is_allowed_to_contain_angle_brackets(self):
        # the usage lines are full of <date> and <CALL|PUT> placeholders. Those are the reason the reply
        # goes out as plain text: parsed as HTML, "/watch <date>" would arrive as "/watch" and the owner
        # would be told nothing at all. The parse_mode rule is asserted in test_bot.py; this is why.
        assert "<date>" in HELP_TEXT
        assert not HELP_TEXT.startswith("<pre>")

    def test_gives_every_menu_entry_a_description_which_telegram_requires(self):
        assert all(len(c.description) > 0 for c in BOT_COMMANDS)
        assert all(re.fullmatch(r"[a-z]+", c.command, re.ASCII) for c in BOT_COMMANDS)


class TestWhatOnlyThePythonCanGetWrong:
    def test_measures_a_cell_in_utf16_code_units_as_javascript_s_length_does(self):
        # the bell is ONE code point and TWO UTF-16 code units. `padEnd` and `.length` count units, so
        # the TypeScript's column is a space wider than `len` would make it — and /quotes puts the bell
        # in the FIRST column, where the width reaches every row below it. Measured against the
        # TypeScript's `table` on 2026-11-09.
        out = table(["contract", "mid"], [["261101 C6500 🔔", "1.5"], ["261101 C6500", "2.0"]])
        assert out == "<pre>contract         mid\n261101 C6500 🔔  1.5\n261101 C6500     2.0</pre>"

    def test_strips_only_what_javascript_calls_whitespace_from_a_line_s_end(self):
        # `/\s+$/`: the BOM is whitespace to JavaScript and not to Python; \x1c is the reverse
        assert table(["a", "b"], [["x", "y﻿"]]) == "<pre>a  b\nx  y</pre>"
        assert table(["a", "b"], [["x", "y\x1c"]]) == "<pre>a  b\nx  y\x1c</pre>"

    def test_fixed_is_javascript_s_to_fixed_rounding_and_text(self):
        # half away from zero on the EXACT binary value, where Python's format rounds half to even
        assert fixed(0.03125, 4) == "0.0313"
        assert fixed(2.5, 0) == "3"
        assert fixed(-1.117809, 2) == "-1.12"
        # -0 has no sign in `toFixed`, a negative that rounds to zero keeps one, and a value too large
        # for fixed notation is written as `String` writes it
        assert fixed(-0.0, 2) == "0.00"
        assert fixed(-0.001, 2) == "-0.00"
        assert fixed(1e21, 2) == "1e+21"
        assert fixed(math.nan, 2) == "NaN"

    def test_writes_a_value_that_is_not_a_number_as_javascript_s_string_does(self):
        assert js_text("N/A") == "N/A"
        assert js_text(None) == "null"
        assert js_text(True) == "true"
        assert js_text(42) == "42"
        assert js_text(4.0) == "4"
        assert js_text([1, None, "a"]) == "1,,a"
        assert js_text({"a": 1}) == "[object Object]"
        # a number goes through `py_number` in `fmt_value`, and anything else through `String` — a
        # boolean included, which Python counts as an int and `typeof` does not count as a number
        assert fmt_value("anything", True) == "true"
        assert fmt_value("option_delta", "0.5") == "0.5"

    def test_says_a_pace_gap_to_javascript_s_two_places(self):
        # 0.125 is an exact tie, which `toFixed` takes away from zero and Python's format takes to even
        assert standing(pace_gap=0.125) == "behind 0.13"
        assert standing(pace_gap=-0.125) == "ahead 0.13"


def standing(**schedule: Any) -> str:
    """`standing_note` of a holding whose schedule says this, which is all of the holding it reads."""
    full = {
        "dte_at_open": 45,
        "on_pace": None,
        "pace_gap": None,
        "target": None,
        "stop": None,
        "target_dte": None,
        "manage_by_dte": 21,
        "reached": None,
        "manage_by_due": False,
    }
    value = HoldingValue(row=None, position=None, cost=None, pnl=None, captured=None, schedule=full | schedule, dte=30)  # type: ignore[arg-type]
    return standing_note(value)
