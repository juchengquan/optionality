"""Converting between what SQLite stores and what Python works in.

backend/src/db/values.ts has no test of its own: its callers' tests rely on it — `db/open.test.ts`
binds its booleans, the watchlist, monitor, bot and sweep suites write their legs with it, and
`create-monitor.ts` mints ids with it. So this holds what those rely on, and the two places the
JSON rules of the two languages part.
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

    def test_reads_what_the_typescript_wrote_as_the_same_value_as_what_this_writes(self):
        # JSON.stringify writes 8050 and no spaces; Python writes 8050.0 and spaces, as the service
        # before the cutover did. Different bytes, the same value — and the scenarios compare these
        # columns as values for exactly this reason (testdata/scenarios/README.md).
        typescript = '[{"sign":-1,"option_type":"CALL","strike":8050},{"sign":1,"option_type":"CALL","strike":8100}]'
        assert from_sqlite_json(typescript) == from_sqlite_json(to_sqlite_json(LEGS))

    def test_writes_pythons_bytes_which_every_row_copied_from_the_old_service_has(self):
        assert to_sqlite_json([{"sign": -1, "strike": 8050.0}]) == '[{"sign": -1, "strike": 8050.0}]'

    def test_writes_a_number_that_is_not_finite_as_null_as_json_stringify_does(self):
        # Python would write the bare token NaN, which is not JSON: the TypeScript's JSON.parse
        # refuses the whole row, and a row that cannot be hydrated is quarantined
        text = to_sqlite_json({"legs_iv": [0.21, math.nan, math.inf, -math.inf]})
        assert json.loads(text, parse_constant=pytest.fail) == {"legs_iv": [0.21, None, None, None]}

    def test_writes_negative_zero_as_zero_as_json_stringify_does(self):
        assert math.copysign(1.0, from_sqlite_json(to_sqlite_json([-0.0]))[0]) == 1.0

    def test_refuses_stored_text_json_parse_refuses(self):
        # Python's json reads NaN and Infinity; JSON.parse throws. A row the TypeScript cannot
        # hydrate must not hydrate here either, or the two backends quarantine different rules
        for bad in ["[NaN]", '{"iv": Infinity}', "[-Infinity]"]:
            with pytest.raises(ValueError):
                from_sqlite_json(bad)
