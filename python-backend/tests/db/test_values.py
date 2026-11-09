"""Converting between what SQLite stores and what Python works in.

backend/src/db/values.ts has no test of its own: its callers' tests rely on it — `db/open.test.ts`
binds its booleans, the watchlist, monitor, bot and sweep suites write their legs with it, and
`create-monitor.ts` mints ids with it. So this holds what those rely on, and — because both
backends write one file — that the JSON it stores is JSON.stringify's to the byte, wherever Python's
own rules would part from JavaScript's.
"""

import json
import math
import re
import sqlite3

import pytest

from optionality_backend.db.values import (
    from_sqlite_bool,
    from_sqlite_json,
    new_id,
    to_sqlite_bool,
    to_sqlite_json,
)

LEGS = [{"sign": -1, "option_type": "CALL", "strike": 8050.0}, {"sign": 1, "option_type": "CALL", "strike": 8100.0}]


class TestNewId:
    def test_is_32_hex_characters_with_no_dashes_which_every_id_column_is_sized_for(self):
        assert re.fullmatch(r"[0-9a-f]{32}", new_id())

    def test_is_a_new_one_every_time(self):
        assert len({new_id() for _ in range(100)}) == 100


class TestBooleans:
    def test_go_in_as_0_and_1(self):
        assert to_sqlite_bool(True) == 1
        assert to_sqlite_bool(False) == 0
        # 0 and 1, not True and False: a bool IS an int in Python, but a row compared with a
        # scenario's `1` must not be a `True` that happens to equal it
        assert type(to_sqlite_bool(True)) is int

    def test_come_out_true_for_anything_non_zero_which_is_what_sqlalchemy_does(self):
        assert from_sqlite_bool(0) is False
        assert from_sqlite_bool(1) is True
        assert from_sqlite_bool(2) is True
        assert from_sqlite_bool(-1) is True

    def test_round_trip_through_the_column_the_python_writes_0_and_1_into(self):
        db = sqlite3.connect(":memory:")
        db.execute("create table monitors (enabled BOOLEAN NOT NULL)")
        db.execute("insert into monitors values (?)", (to_sqlite_bool(False),))
        (enabled,) = db.execute("select enabled from monitors").fetchone()
        assert enabled == 0
        assert from_sqlite_bool(enabled) is False


class TestJson:
    def test_round_trips_legs_as_the_same_value(self):
        assert from_sqlite_json(to_sqlite_json(LEGS)) == LEGS

    def test_reads_null_as_none(self):
        assert from_sqlite_json(None) is None

    def test_refuses_stored_text_json_parse_refuses(self):
        # Python's json reads NaN and Infinity; JSON.parse throws. A row the TypeScript cannot
        # hydrate must not hydrate here either, or the two backends quarantine different rules
        for bad in ["[NaN]", '{"iv": Infinity}', "[-Infinity]"]:
            with pytest.raises(ValueError):
                from_sqlite_json(bad)


#: What `JSON.stringify` writes, to the byte. Every expected string here was produced by Node 26
#: running `JSON.stringify(value)` on the same value, once, on 2026-11-09 — not reasoned out. Both
#: backends write the one database file (ADR 0021, Decision 3), so a column the Python writes must
#: be the column the TypeScript would have written: the scenarios compare these columns as values,
#: which two spellings of one value would pass, while the file filled with both.
STRINGIFY = [
    # the legs as both backends write them: no spaces, and a whole float with no `.0`
    (
        "integral floats",
        LEGS,
        '[{"sign":-1,"option_type":"CALL","strike":8050},{"sign":1,"option_type":"CALL","strike":8100}]',
    ),
    ("a sum that is not a tenth", [0.1 + 0.2], "[0.30000000000000004]"),
    # Python's repr writes 1e-05 and 1e-07; JavaScript turns to an exponent later and pads none
    ("small", [0.00001, 0.000001, 1e-7], "[0.00001,0.000001,1e-7]"),
    ("large", [1e21, 1e20, 2.0**60], "[1e+21,100000000000000000000,1152921504606847000]"),
    ("negative zero", [-0.0], "[0]"),
    # NaN is not JSON: Python would write the bare token, and JSON.parse would refuse the row
    ("not finite", {"legs_iv": [0.21, math.nan, math.inf, -math.inf]}, '{"legs_iv":[0.21,null,null,null]}'),
    (
        "nested",
        {"a": [1.0, {"b": [2.5, None, True, False]}], "c": {}, "d": []},
        '{"a":[1,{"b":[2.5,null,true,false]}],"c":{},"d":[]}',
    ),
    # kept as it is, not \u-escaped; U+2028 too, which JSON.stringify writes raw since ES2019
    (
        "unicode",
        {"name": "日本 – café ✓ 😀", "q": 'say "hi" \\ /  '},
        '{"name":"日本 – café ✓ 😀","q":"say \\"hi\\" \\\\ /  "}',
    ),
    (
        "control characters",
        ["tab\there\nnew\u0001\u001f\u007f\b\f\r"],
        '["tab\\there\\nnew\\u0001\\u001f\u007f\\b\\f\\r"]',
    ),
    # a lone surrogate is escaped (well-formed JSON.stringify, ES2019); Python would write it raw,
    # and SQLite could not then store the text at all
    ("lone surrogates", ["\ud800x\udfff"], '["\\ud800x\\udfff"]'),
    # a JavaScript object lists its array-index keys first, ascending, whatever order they were
    # written in; 4294967294 is the largest index, so 4294967295 and "01" are ordinary keys
    (
        "key order",
        {"b": 1, "2": 2, "a": 3, "1": 4, "01": 5, "4294967295": 6, "4294967294": 7},
        '{"1":4,"2":2,"4294967294":7,"b":1,"a":3,"01":5,"4294967295":6}',
    ),
]


@pytest.mark.parametrize(("value", "expected"), [c[1:] for c in STRINGIFY], ids=[c[0] for c in STRINGIFY])
def test_writes_what_json_stringify_writes(value, expected):
    assert to_sqlite_json(value) == expected


def test_reads_back_the_value_it_wrote():
    for _, value, expected in STRINGIFY:
        assert json.loads(to_sqlite_json(value)) == json.loads(expected)


def test_refuses_what_json_cannot_hold():
    # JSON.stringify of a Date or a class instance calls toJSON or lists own properties; a port
    # handing this a datetime or a model has a bug, so it raises as Python's json would
    for bad in [{"at": object()}, {1: "a key that is not a string"}]:
        with pytest.raises(TypeError):
            to_sqlite_json(bad)
