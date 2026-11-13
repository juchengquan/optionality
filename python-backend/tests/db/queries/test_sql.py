"""The three things every query was writing out by hand, now written once.

Port of backend/src/db/queries/sql.test.ts, test for test. Only the behaviour that is EASY TO GET
WRONG in a generic version is tested here; each query built on these is exercised by the suites of
its callers. What only the Python can get wrong is at the end.
"""

import pytest

from optionality_backend.db.open import create_database
from optionality_backend.db.queries.sql import database_responds, insert_row, row, rows, update_fields

ID = "p".ljust(32, "1")


@pytest.fixture
def db(tmp_path):
    d = create_database(tmp_path / "t.db")
    yield d
    d.close()  # a test may have closed it on purpose; closing twice is allowed


def holding(**over):
    """A holding with every column set, so a missing one in a generic insert is visible."""
    return {
        "id": ID,
        "name": "condor",
        "strategy": "iron_condor",
        "strike_date": "2026-12-18",
        "contracts": 2,
        "entry": 4.5,
        "legs": "[]",
        "created_at": "2026-11-08 00:00:00.000000",
        "opened_at": "2026-11-01",
        "manage_notified_at": None,
        "closed_on": None,
        "exit": None,
        "qty_corrected_at": None,
        **over,
    }


class TestInsertingARow:
    def test_writes_every_column_the_schema_declares_in_its_order(self, db):
        insert_row(db, "positions", holding())
        stored = row(db, "select * from positions where id = ?", ID)
        assert stored["opened_at"] == "2026-11-01"
        assert stored["entry"] == 4.5

    def test_refuses_a_row_with_a_column_missing_rather_than_storing_defaults_for_it(self, db):
        # This is the whole difference between naming `COLUMNS[table]` and naming the value's own keys:
        # with the keys of the value, a half-built row inserts cleanly and the absent columns take the
        # database's defaults — silently. With the schema's columns, the missing one cannot be bound.
        # node:sqlite says "cannot be bound"; here it is a KeyError naming the column.
        partial = {k: v for k, v in holding().items() if k not in ("entry", "opened_at")}
        with pytest.raises(KeyError, match="entry"):
            insert_row(db, "positions", partial)
        assert rows(db, "select * from positions") == [], "and nothing was written"

    def test_stores_a_null_as_a_null_rather_than_dropping_the_column(self, db):
        insert_row(db, "positions", holding(entry=None, strategy=None))
        stored = row(db, "select * from positions limit 1")
        assert stored["entry"] is None
        assert stored["strategy"] is None


class TestUpdatingNamedColumns:
    def test_writes_only_what_it_was_given_and_says_it_wrote(self, db):
        insert_row(db, "positions", holding())
        assert update_fields(db, "positions", ID, {"entry": 9}) is True
        stored = row(db, "select * from positions limit 1")
        assert stored["entry"] == 9
        assert stored["name"] == "condor", "an absent key means leave it, never set it to null"

    def test_writes_nothing_for_an_empty_change_set_rather_than_running_a_statement(self, db):
        # `update positions set where id = ?` is a syntax error, so a generic update MUST answer this
        # before building one
        insert_row(db, "positions", holding())
        assert update_fields(db, "positions", ID, {}) is False
        assert row(db, "select * from positions limit 1")["entry"] == 4.5


class TestReading:
    def test_answers_an_empty_list_and_none_rather_than_throwing_on_no_match(self, db):
        assert rows(db, "select * from positions") == []
        assert row(db, "select * from positions where id = ?", "nobody") is None


class TestWhetherTheDatabaseAnswers:
    def test_is_true_while_it_is_open_and_false_once_it_is_gone(self, db):
        # /health reports this rather than raising: an endpoint that 500s when the database is gone
        # tells you less than one that says `db: false`
        assert database_responds(db) is True
        db.close()
        assert database_responds(db) is False


class TestWhatOnlyThePythonCanGetWrong:
    def test_a_row_is_a_dict_keyed_by_column_in_the_schema_s_order(self, db):
        # node:sqlite answers objects; sqlite3 answers tuples unless asked, and whatever row factory
        # the connection was opened with must not decide the shape a query returns
        insert_row(db, "positions", holding())
        stored = row(db, "select * from positions")
        assert type(stored) is dict
        assert list(stored) == list(holding())
