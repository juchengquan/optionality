"""The schema migrations: plain `.sql` files in `schema/migrations/`, applied in name order and
recorded in `schema_migrations`, by whichever backend starts first after a change (ADR 0021,
Decision 3). Both backends apply the same files to the one database, so this is the half of the
shared ground the Python owns.

Port of backend/src/db/migrate.test.ts, test for test; what only the Python can get wrong is at the
end.
"""

import json
import sqlite3

import pytest

from optionality_backend.db.migrate import APPLIED_TABLE, DIRECTORY, migrate, pending_migrations, stamp_all
from optionality_backend.db.open import create_database, open_database
from optionality_backend.db.rows import COLUMNS

#: `schema-base.sql`, the database as it stood before migration 0001
BASE = DIRECTORY.parent / "schema-base.sql"


def columns(db, table):
    return [r[0] for r in db.execute("select name from pragma_table_info(?)", (table,))]


def tables(db):
    return [r[0] for r in db.execute("select name from sqlite_master where type='table'")]


def pre_change_database(path):
    """The shape the live database actually had when the mechanism was written. A verbatim
    transcription, and a historical fact rather than a copy of anything that can now change —
    schema.sql carries the NEW shape, so it cannot be used to build the old one."""
    db = open_database(path)
    db.executescript("""
        CREATE TABLE positions (
          id VARCHAR(32) NOT NULL,
          name VARCHAR(100) NOT NULL,
          strategy VARCHAR(50),
          strike_date VARCHAR(10) NOT NULL,
          contracts INTEGER NOT NULL,
          entry FLOAT,
          legs JSON NOT NULL,
          created_at DATETIME NOT NULL,
          PRIMARY KEY (id)
        );
        CREATE UNIQUE INDEX ix_positions_name ON positions (name);
    """)
    return db


HOLDING = """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
             values ('p1', '1120_IC', null, '2026-11-20', 1, 6.86, '[]', '2026-10-06 04:15:51')"""


class TestMigratingADatabaseThatPredatesTheMechanism:
    def test_adds_what_the_exit_schedule_needs_keeping_the_rows_that_were_there(self, tmp_path):
        db = pre_change_database(tmp_path / "old.db")
        db.execute(HOLDING)

        migrate(db)

        assert "opened_at" in columns(db, "positions")
        assert "manage_notified_at" in columns(db, "positions")
        assert "position_samples" in tables(db)
        # the point of a migration rather than a rebuild: the holding survives it
        assert db.execute("select name, entry, opened_at from positions").fetchone() == ("1120_IC", 6.86, None)
        db.close()

    def test_is_a_no_op_the_second_time_and_the_tenth(self, tmp_path):
        db = pre_change_database(tmp_path / "twice.db")
        migrate(db)
        after = columns(db, "positions")
        for _ in range(9):
            migrate(db)
        assert columns(db, "positions") == after
        db.close()


class TestADatabaseBuiltFromSchemaSql:
    def test_is_stamped_so_nothing_is_applied_to_it_twice(self, tmp_path):
        # schema.sql carries the new shape, so re-applying the migration would fail on a duplicate
        # column. Stamping on creation is what alembic does, and what the cutover did by hand.
        db = create_database(tmp_path / "fresh.db")
        assert pending_migrations(db) == []
        migrate(db)
        assert "opened_at" in columns(db, "positions")
        db.close()

    def test_agrees_with_the_migrated_shape_column_for_column(self, tmp_path):
        # the two paths into a database must not diverge: a fresh test database and the live file
        # have to be the same thing, or tests pass against a schema production does not have
        fresh = create_database(tmp_path / "a.db")
        migrated = pre_change_database(tmp_path / "b.db")
        migrate(migrated)

        assert columns(migrated, "positions") == columns(fresh, "positions")
        assert columns(migrated, "position_samples") == columns(fresh, "position_samples")
        fresh.close()
        migrated.close()


class TestWhenAMigrationFails:
    def test_records_nothing_and_leaves_the_database_as_it_was(self, tmp_path):
        db = pre_change_database(tmp_path / "bad.db")
        bad = tmp_path / "migrations"
        bad.mkdir()
        (bad / "9999-broken.sql").write_text("ALTER TABLE positions ADD COLUMN ok INTEGER;\nTHIS IS NOT SQL;\n")

        with pytest.raises(RuntimeError):
            migrate(db, bad)
        # both halves rolled back: the column it managed to add, and the record of having run
        assert "ok" not in columns(db, "positions")
        assert db.execute(f"select count(*) from {APPLIED_TABLE}").fetchone() == (0,)
        db.close()


class TestWhatIsPending:
    def test_is_every_file_not_yet_recorded_in_name_order(self, tmp_path):
        db = pre_change_database(tmp_path / "order.db")
        d = tmp_path / "m"
        d.mkdir()
        for n in ("0002-b.sql", "0001-a.sql", "0010-c.sql"):
            (d / n).write_text("select 1;")
        assert pending_migrations(db, d) == ["0001-a.sql", "0002-b.sql", "0010-c.sql"]
        migrate(db, d)
        assert pending_migrations(db, d) == []
        db.close()

    def test_stamps_without_running_which_is_how_a_fresh_database_skips_history(self, tmp_path):
        db = pre_change_database(tmp_path / "stamp.db")
        stamp_all(db)
        assert pending_migrations(db) == []
        # stamping did NOT apply it — this database is still the old shape, which is why stamp_all is
        # only ever called on one built from schema.sql
        assert "opened_at" not in columns(db, "positions")
        db.close()


class TestTheSchemaFileItself:
    def test_declares_position_samples_one_row_per_position_per_day(self, tmp_path):
        db = create_database(tmp_path / "pk.db")
        # a sample belongs to a Position and the foreign key says so
        db.execute(HOLDING)
        db.execute(
            "insert into position_samples (position_id, observed_on, dte, cost_to_close) values ('p1', '2026-10-12', 39, 6.50)"
        )
        # a second sweep on the same day replaces rather than accumulates: the sweep runs every 60
        # seconds and a day of samples is a day, not 1,440 of them
        db.execute(
            "insert or replace into position_samples (position_id, observed_on, dte, cost_to_close)"
            " values ('p1', '2026-10-12', 39, 6.55)"
        )
        rows = db.execute("select cost_to_close from position_samples").fetchall()
        assert rows == [(6.55,)]

        # and a sample for a Position that does not exist is refused, so the series cannot outlive
        # the holding it describes
        with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
            db.execute(
                "insert into position_samples (position_id, observed_on, dte, cost_to_close)"
                " values ('nope', '2026-10-12', 39, 1.0)"
            )
        db.close()


class Test0004ALegsSideIsLongOrShort:
    """ADR 0013."""

    NAME = "0004-side-is-long-or-short.sql"

    def behind(self, tmp_path):
        """A database one migration behind: built current, then 0004 un-recorded."""
        db = create_database(tmp_path / "behind.db")
        db.execute(f"delete from {APPLIED_TABLE} where name = ?", (self.NAME,))
        return db

    @staticmethod
    def insert(db, id_, legs):
        db.execute(
            "insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)"
            " values (?, ?, null, '2026-11-20', 1, 6.86, ?, '2026-10-06 04:15:51')",
            (id_, id_, legs),
        )

    @staticmethod
    def legs_of(db, id_):
        return json.loads(db.execute("select legs from positions where id = ?", (id_,)).fetchone()[0])

    def test_renames_every_side_keeping_the_legs_order_and_every_other_field(self, tmp_path):
        db = self.behind(tmp_path)
        self.insert(
            db,
            "ic",
            json.dumps(
                [
                    {"side": "bought", "option_type": "PUT", "strike": 6450},
                    {"side": "sold", "option_type": "PUT", "strike": 6500},
                    {"side": "sold", "option_type": "CALL", "strike": 7100},
                    {"side": "bought", "option_type": "CALL", "strike": 7150},
                ]
            ),
        )
        assert migrate(db) == [self.NAME]
        assert self.legs_of(db, "ic") == [
            {"side": "long", "option_type": "PUT", "strike": 6450},
            {"side": "short", "option_type": "PUT", "strike": 6500},
            {"side": "short", "option_type": "CALL", "strike": 7100},
            {"side": "long", "option_type": "CALL", "strike": 7150},
        ]

    def test_reads_the_json_rather_than_matching_text_so_python_s_spacing_migrates_too(self, tmp_path):
        # rows that came across from the old Python database were written by json.dumps, which puts a
        # space after every colon — a text replace of '"side":"sold"' would leave them untouched
        db = self.behind(tmp_path)
        self.insert(db, "py", '[{"side": "sold", "option_type": "PUT", "strike": 6500.0}]')
        migrate(db)
        assert self.legs_of(db, "py") == [{"side": "short", "option_type": "PUT", "strike": 6500}]

    def test_leaves_a_position_with_no_legs_and_one_already_renamed_as_they_were(self, tmp_path):
        db = self.behind(tmp_path)
        self.insert(db, "empty", "[]")
        self.insert(db, "done", '[{"side":"short","option_type":"CALL","strike":7100}]')
        migrate(db)
        assert self.legs_of(db, "empty") == []
        assert self.legs_of(db, "done") == [{"side": "short", "option_type": "CALL", "strike": 7100}]


class Test0005TheRunPipelinesTablesGoWithIt:
    """Phase 10, ADR 0014."""

    NAME = "0005-drop-the-run-pipeline.sql"
    GONE = ("configs", "schedules", "runs", "reports", "alembic_version")

    def test_drops_exactly_the_run_pipeline_s_tables_and_alembic_s_and_keeps_every_other_row(self, tmp_path):
        db = create_database(tmp_path / "behind.db")
        db.execute(f"delete from {APPLIED_TABLE} where name = ?", (self.NAME,))
        # what 0005 removes has to exist first for the test to mean anything; a database one
        # migration behind is built current, so the tables are put back the way they last were
        db.executescript("""
            CREATE TABLE IF NOT EXISTS configs (id INTEGER PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS runs (id VARCHAR(32) PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) PRIMARY KEY);
        """)
        db.execute(HOLDING)

        assert migrate(db) == [self.NAME]
        assert [t for t in tables(db) if t in self.GONE] == []
        assert {"monitors", "positions", "monitor_positions", "position_samples", APPLIED_TABLE} <= set(tables(db))
        assert db.execute("select count(*) from positions").fetchone() == (1,)

    def test_is_what_schema_sql_describes_so_a_fresh_database_has_none_of_them_either(self, tmp_path):
        db = create_database(tmp_path / "fresh.db")
        assert [t for t in tables(db) if t in self.GONE] == []


class TestTheTwoRoadsIntoADatabase:
    """The two roads into a database must arrive at the same place.

    A test database is BUILT from schema.sql and stamped; the live file is MIGRATED. Two changes once
    passed every other check and broke the live database: a column added to schema.sql, COLUMNS,
    NULLABLE and the row type with NO migration file; and a migration writing NOT NULL DEFAULT '' for
    a column schema.sql leaves nullable. This is what notices, from a baseline that predates the first
    migration: `schema/schema-base.sql`. It matters twice over now that two backends apply the same
    migrations to one file (ADR 0021)."""

    @staticmethod
    def base_database(path):
        """The database as it stood before migration 0001, with no schema_migrations table — so every
        migration is pending, exactly as it was on the live file."""
        db = open_database(path)
        db.executescript(BASE.read_text(encoding="utf-8"))
        return db

    @staticmethod
    def shape(db, table):
        """Everything the code can depend on about a column: its name, its position, whether it may
        be null, its default and whether it is the key."""
        return db.execute('select name, type, "notnull", dflt_value, pk from pragma_table_info(?)', (table,)).fetchall()

    def test_ends_at_the_same_shape_for_every_table_the_code_reads(self, tmp_path):
        migrated = self.base_database(tmp_path / "base.db")
        migrate(migrated)
        fresh = create_database(tmp_path / "fresh.db")
        # COLUMNS is the list of tables the code reads, so iterating it covers the schema rather than a
        # chosen corner of it
        for table in COLUMNS:
            assert self.shape(migrated, table) == self.shape(fresh, table), f"{table} differs between the two roads"
        migrated.close()
        fresh.close()

    @staticmethod
    def indexes(db):
        """The indexes as SQLite records them, `sqlite_autoindex_…` included: that is how a
        table-level UNIQUE shows up, so filtering them would hide a dropped `UNIQUE (code)`."""
        return db.execute("select name, tbl_name, sql from sqlite_master where type='index' order by name").fetchall()

    @staticmethod
    def foreign_keys(db, table):
        return db.execute(
            'select "table", "from", "to", on_update, on_delete from pragma_foreign_key_list(?) order by "table", "from"',
            (table,),
        ).fetchall()

    def test_ends_with_the_same_indexes_and_the_same_foreign_keys(self, tmp_path):
        # columns are three quarters of a schema: a constraint, an index and a foreign key are all
        # invisible to pragma_table_info
        migrated = self.base_database(tmp_path / "base-constraints.db")
        migrate(migrated)
        fresh = create_database(tmp_path / "fresh-constraints.db")

        assert self.indexes(migrated) == self.indexes(fresh)
        for table in COLUMNS:
            assert self.foreign_keys(migrated, table) == self.foreign_keys(fresh, table), (
                f"{table}'s foreign keys differ between the two roads"
            )
        migrated.close()
        fresh.close()

    def test_leaves_no_table_behind_on_either_road(self, tmp_path):
        # a table created by schema.sql and by no migration is missing from the live file, and one the
        # migrations fail to drop outlives the code that read it
        migrated = self.base_database(tmp_path / "base2.db")
        migrate(migrated)
        fresh = create_database(tmp_path / "fresh2.db")
        assert sorted(tables(migrated)) == sorted(tables(fresh))
        migrated.close()
        fresh.close()

    def test_knows_the_baseline_is_older_than_every_migration(self, tmp_path):
        # a baseline quietly brought up to date would make both tests above pass by agreeing with
        # nothing. It is only a baseline while every migration still has work to do on it.
        db = self.base_database(tmp_path / "base3.db")
        assert pending_migrations(db) == sorted(p.name for p in DIRECTORY.glob("*.sql"))
        db.close()


class TestWhatOnlyThePythonCanGetWrong:
    def test_records_a_migration_s_time_as_the_typescript_writes_it(self, tmp_path):
        # `toISOString().replace("T", " ").slice(0, 23)`: milliseconds, no zone. Either backend may be
        # the one that records a migration, and both write the one table
        db = pre_change_database(tmp_path / "t.db")
        migrate(db)
        stamped = [r[0] for r in db.execute(f"select applied_at from {APPLIED_TABLE}")]
        assert stamped and all(len(a) == 23 and a[10] == " " and a[19] == "." for a in stamped), stamped
        db.close()

    def test_creates_the_bookkeeping_table_character_for_character(self, tmp_path):
        # SQLite keeps DDL verbatim in sqlite_master, and the TypeScript's spelling is what a database
        # it created holds: spelled any other way, the two backends' files differ in one cell
        db = create_database(tmp_path / "t.db")
        (sql,) = db.execute("select sql from sqlite_master where name = ?", (APPLIED_TABLE,)).fetchone()
        assert sql == (
            f"CREATE TABLE {APPLIED_TABLE} (\n"
            "       name VARCHAR(100) NOT NULL PRIMARY KEY,\n"
            "       applied_at DATETIME NOT NULL\n"
            "     )"
        )
        db.close()

    def test_a_failure_names_the_migration_and_keeps_the_cause(self, tmp_path):
        db = pre_change_database(tmp_path / "bad.db")
        bad = tmp_path / "migrations"
        bad.mkdir()
        (bad / "9999-broken.sql").write_text("THIS IS NOT SQL;\n")
        with pytest.raises(RuntimeError, match=r"^migration 9999-broken\.sql failed: ") as caught:
            migrate(db, bad)
        assert caught.value.__cause__ is not None
        assert db.in_transaction is False
        db.close()
