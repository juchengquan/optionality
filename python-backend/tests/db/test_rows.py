"""The link between schema.sql and the Python that reads it (ADR 0009, phase 4).

There are three statements of the same truth — the DDL, the COLUMNS/NULLABLE constants, and the row
types — and this is what stops them drifting. Port of backend/src/db/rows.test.ts, which ties the
constants to the database that actually gets created; the TypeScript's COMPILER ties the constants
to the row interfaces (`SchemaChecks`), and Python has no compiler in the gate, so the class at the
end does that half here.
"""

import sqlite3
import typing

import pytest

from optionality_backend.db.open import create_database
from optionality_backend.db.rows import COLUMNS, NULLABLE, ROW_TYPES


@pytest.fixture(scope="module")
def db(tmp_path_factory):
    d = create_database(tmp_path_factory.mktemp("rows") / "test.db")
    yield d
    d.close()


def info(db, table):
    return db.execute('select name, "notnull" from pragma_table_info(?)', (table,)).fetchall()


TABLES = list(COLUMNS)


class TestColumnsMatchesTheDatabase:
    def test_covers_every_table_the_schema_creates_and_no_others(self, db):
        created = [r[0] for r in db.execute("select name from sqlite_master where type='table' order by name")]
        assert sorted(TABLES) == created

    @pytest.mark.parametrize("table", TABLES)
    def test_names_the_table_s_columns_in_the_order_the_ddl_declares_them(self, db, table):
        # order matters because an insert built from COLUMNS pairs names with placeholders
        assert [c[0] for c in info(db, table)] == list(COLUMNS[table])


class TestNullableMatchesTheDatabase:
    @pytest.mark.parametrize("table", TABLES)
    def test_marks_exactly_the_table_s_nullable_columns(self, db, table):
        nullable = sorted(c[0] for c in info(db, table) if c[1] == 0)
        assert nullable == sorted(NULLABLE[table])

    def test_agrees_that_a_not_null_column_really_rejects_null(self, db):
        # the pragma is read here, so this proves the pragma means what the test assumes
        with pytest.raises(sqlite3.IntegrityError, match="NOT NULL"):
            db.execute(
                "insert into positions (id, name, strike_date, contracts, legs, created_at) values (?, ?, ?, ?, ?, ?)",
                ("a" * 32, "n", "2026-10-16", 1, None, "2026-10-16 00:00:00.000000"),
            )

    def test_agrees_that_a_nullable_column_really_accepts_null(self, db):
        db.execute(
            "insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)"
            " values (?, ?, ?, ?, ?, ?, ?, ?)",
            ("b" * 32, "n2", None, "2026-10-16", 1, None, "[]", "2026-10-16 00:00:00.000000"),
        )


class TestTheRelationships:
    def test_declares_every_foreign_key_both_ends_of_every_link(self, db):
        # Asserted structurally because the behavioural test is easy to get wrong: a row whose monitor
        # AND position are both missing is rejected by either constraint alone, so dropping one of the
        # two went unnoticed until this list existed.
        def keys(table):
            rows = db.execute(
                'select "table", "from", "to" from pragma_foreign_key_list(?)',
                (table,),
            ).fetchall()
            return sorted(f"{child} -> {parent}.{target}" for parent, child, target in rows)

        assert keys("monitor_positions") == ["monitor_id -> monitors.id", "position_id -> positions.id"]
        # nothing else has one, and a stray reference would change what a delete is allowed to do
        for t in ("monitors", "positions"):
            assert keys(t) == [], t


def _nullable(hint) -> bool:
    # `str | None` is a union whose arguments include NoneType; a plain `str` has no arguments
    return type(None) in typing.get_args(hint)


class TestTheRowTypesMatchTheConstants:
    """`SchemaChecks`, which the TypeScript's compiler evaluates and Python cannot: every row type names
    exactly the columns COLUMNS does, and marks nullable exactly the columns NULLABLE does. Add a column
    to one place and not the other and this names the column and the side it is missing from."""

    def test_every_table_has_a_row_type(self):
        assert set(ROW_TYPES) == set(COLUMNS)

    @pytest.mark.parametrize("table", TABLES)
    def test_the_row_type_names_exactly_the_table_s_columns(self, table):
        hints = typing.get_type_hints(ROW_TYPES[table])
        assert set(hints) - set(COLUMNS[table]) == set(), "in the row type, not in COLUMNS"
        assert set(COLUMNS[table]) - set(hints) == set(), "in COLUMNS, not in the row type"

    @pytest.mark.parametrize("table", TABLES)
    def test_the_row_type_marks_exactly_the_nullable_columns(self, table):
        hints = typing.get_type_hints(ROW_TYPES[table])
        assert sorted(c for c, h in hints.items() if _nullable(h)) == sorted(NULLABLE[table])
