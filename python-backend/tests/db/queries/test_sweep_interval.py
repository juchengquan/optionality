"""`sweep_interval`: one row or none (#442, ADR 0025). Port of backend/src/db/queries/sweep-interval.test.ts."""

import sqlite3

import pytest

from optionality_backend.db.open import create_database
from optionality_backend.db.queries.sweep_interval import (
    clear_sweep_interval,
    read_sweep_interval,
    write_sweep_interval,
)


@pytest.fixture
def db(tmp_path):
    d = create_database(tmp_path / "t.db")
    yield d
    d.close()


class TestTheSweepIntervalsRow:
    def test_is_absent_on_a_new_database_which_is_env_s_interval(self, db):
        assert read_sweep_interval(db) is None

    def test_holds_the_page_s_choice_and_a_second_choice_replaces_the_first_rather_than_adding_a_row(self, db):
        write_sweep_interval(db, 5, "2026-11-17 10:00:00.000000")
        write_sweep_interval(db, 30, "2026-11-17 10:05:00.000000")
        assert read_sweep_interval(db) == {"id": 1, "seconds": 30, "set_at": "2026-11-17 10:05:00.000000"}
        assert db.execute("select count(*) from sweep_interval").fetchone()[0] == 1

    def test_goes_back_to_env_s_by_having_no_row_at_all(self, db):
        write_sweep_interval(db, 5, "2026-11-17 10:00:00.000000")
        clear_sweep_interval(db)
        assert read_sweep_interval(db) is None
        clear_sweep_interval(db)  # and clearing nothing is not an error

    def test_refuses_a_second_row_at_the_schema_whatever_writes_it(self, db):
        # one row at most is the table's own rule (migration 0016), not this module's discipline
        with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
            db.execute("insert into sweep_interval values (2, 5, 'x')")
