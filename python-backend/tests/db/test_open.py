"""The database as it is created and opened: the schema, the pragmas, and the transaction the delete
paths depend on (ADR 0009, phase 4).

Port of backend/src/db/open.test.ts, test for test. One TypeScript test does not cross over as
written — node:sqlite REFUSES a JavaScript boolean, and Python's sqlite3 binds one as 1 — so its
Python counterpart says what Python does instead. What only the Python can get wrong is at the end.
"""

import asyncio
import sqlite3
import threading
from datetime import UTC, datetime

import pytest

from optionality_backend.db.open import atomic, create_database, open_database
from optionality_backend.db.time import to_sql_datetime
from optionality_backend.db.values import from_sqlite_bool, to_sqlite_bool

NOW = to_sql_datetime(datetime(2026, 9, 1, 15, 39, 11, 940000, tzinfo=UTC))


@pytest.fixture
def db(tmp_path):
    d = create_database(tmp_path / "test.db")
    yield d
    d.close()


def monitor(db, id_, code="US.SPXW261016C8050000", field="option_delta"):
    db.execute(
        """insert into monitors
           (id, code, strike_date, option_type, strike, field, threshold, direction, compare,
            enabled, triggered, created_at)
           values (?, ?, '2026-10-16', 'CALL', 8050, ?, 0.5, 'above', 'abs', 1, 0, ?)""",
        (id_, code, field, NOW),
    )


def position(db, id_, name):
    db.execute(
        "insert into positions (id, name, strike_date, contracts, legs, created_at) values (?, ?, '2026-10-16', 1, '[]', ?)",
        (id_, name, NOW),
    )


def reference(db, id_, code, label=None):
    db.execute(
        "insert into reference_securities (id, code, label, source, created_at) values (?, ?, ?, 'opend', ?)",
        (id_, code, label, NOW),
    )


def names(db, kind):
    return [r[0] for r in db.execute(f"select name from sqlite_master where type='{kind}' order by name")]


class TestTheSchema:
    def test_creates_the_tables_the_alarm_engine_and_the_holdings_use_and_no_others(self, db):
        # the run pipeline's four tables and alembic's bookkeeping went in phase 10 (ADR 0014);
        # `reference_securities` arrived with ADR 0018, and is not called `references` because that
        # is a SQLite keyword
        assert names(db, "table") == [
            "monitor_positions",
            "monitors",
            "position_samples",
            "positions",
            "reference_securities",
            "schema_migrations",
        ]

    def test_carries_what_adr_0011_added_beyond_the_python_s_schema(self, db):
        # `position_samples`, `schema_migrations` and the two newer positions columns never existed
        # in the old Python's models
        assert sorted(n for n in names(db, "table") if n in ("position_samples", "schema_migrations")) == [
            "position_samples",
            "schema_migrations",
        ]
        positions = [r[0] for r in db.execute("select name from pragma_table_info('positions')")]
        assert positions[-2:] == ["opened_at", "manage_notified_at"]

    def test_creates_every_index_under_the_name_sqlalchemy_gave_it(self, db):
        # kept from the old Python's models so that a live file and a fresh one agree name for name
        indexes = [
            r[0]
            for r in db.execute(
                "select name from sqlite_master where type='index' and name not like 'sqlite_%' order by name"
            )
        ]
        assert indexes == ["ix_monitors_code", "ix_positions_name"]

    def test_keeps_a_monitor_s_code_and_field_unique_together(self, db):
        monitor(db, "a" * 32)
        # the same contract watched on a different field is legitimate
        monitor(db, "b" * 32, "US.SPXW261016C8050000", "mid_price")
        # the same field twice is not
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            monitor(db, "c" * 32)

    def test_keeps_a_position_s_name_unique(self, db):
        position(db, "a" * 32, "1016_IC")
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            position(db, "b" * 32, "1016_IC")

    def test_keeps_a_reference_s_code_unique(self, db):
        # the route refuses a duplicate with a 409 after a lookup of its own, so its test passes with
        # no constraint at all; the table-level UNIQUE is also invisible to the index test above
        reference(db, "a" * 32, "US.SPY")
        # a second row for a different code is what the table is for
        reference(db, "b" * 32, "HK.800000")
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            reference(db, "c" * 32, "US.SPY")


class TestThePragmas:
    def test_enforces_foreign_keys_which_sqlite_does_not_do_by_default(self, db):
        # without this, a link to a monitor that does not exist is accepted silently and the row
        # becomes an orphan — the shape of the three bugs in #70-#72
        with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
            db.execute("insert into monitor_positions values (?, ?)", ("nope" * 8, "alsonope" * 4))

    def test_enforces_each_end_of_a_link_not_just_one_of_them(self, db):
        # a row with both ends missing is rejected by either constraint alone, so testing only that
        # case let one of the two be dropped without any test noticing
        monitor(db, "m" * 32)
        position(db, "p" * 32, "one")
        with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):  # real monitor, missing position
            db.execute("insert into monitor_positions values (?, ?)", ("m" * 32, "ghost" * 6 + "pp"))
        with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):  # missing monitor, real position
            db.execute("insert into monitor_positions values (?, ?)", ("ghost" * 6 + "mm", "p" * 32))

    def test_accepts_a_link_whose_both_ends_exist(self, db):
        monitor(db, "m" * 32)
        position(db, "p" * 32, "1016_IC")
        db.execute("insert into monitor_positions values (?, ?)", ("m" * 32, "p" * 32))

    def test_is_in_wal_as_the_python_s_file_is(self, db):
        assert db.execute("pragma journal_mode").fetchone() == ("wal",)


def count(db, table):
    return db.execute(f"select count(*) from {table}").fetchone()[0]


class TestATransaction:
    async def test_commits_everything_when_the_body_finishes(self, db):
        async def body():
            monitor(db, "a" * 32)
            position(db, "b" * 32, "one")

        await atomic(db, body)
        assert count(db, "monitors") == 1
        assert count(db, "positions") == 1

    async def test_rolls_everything_back_when_the_body_throws(self, db):
        async def body():
            monitor(db, "a" * 32)
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            await atomic(db, body)
        assert count(db, "monitors") == 0

    async def test_rolls_back_a_half_finished_delete_which_is_the_case_it_exists_for(self, db):
        # clearing monitor_positions and removing what it pointed at must happen together: a commit
        # in between leaves either an orphan link or a monitor nothing can delete
        monitor(db, "m" * 32)
        position(db, "p" * 32, "one")
        db.execute("insert into monitor_positions values (?, ?)", ("m" * 32, "p" * 32))

        async def body():
            db.execute("delete from monitor_positions where monitor_id = ?", ("m" * 32,))
            raise RuntimeError("interrupted")

        with pytest.raises(RuntimeError, match="interrupted"):
            await atomic(db, body)
        assert count(db, "monitor_positions") == 1

    async def test_rolls_back_when_a_constraint_fails_partway_through(self, db):
        monitor(db, "a" * 32)

        async def body():
            position(db, "b" * 32, "one")
            monitor(db, "c" * 32)  # duplicate code+field

        with pytest.raises(sqlite3.IntegrityError):
            await atomic(db, body)
        assert count(db, "positions") == 0
        assert count(db, "monitors") == 1

    async def test_returns_what_the_body_returned(self, db):
        async def body():
            return 42

        assert await atomic(db, body) == 42


class TestBindingValues:
    def test_binds_a_python_boolean_as_1_where_node_sqlite_refuses_one(self, db):
        # The TypeScript's test is "refuses a JavaScript boolean, which is why the conversion helpers
        # exist": node:sqlite will not bind true/false at all. Python's sqlite3 binds True as 1, so
        # that reason does not cross over (db/values.py) — what does is that the column holds 1.
        monitor(db, "a" * 32)
        db.execute("update monitors set enabled = ? where id = ?", (True, "a" * 32))
        assert db.execute("select enabled from monitors").fetchone() == (1,)
        db.execute("update monitors set enabled = ? where id = ?", (to_sqlite_bool(True), "a" * 32))
        assert db.execute("select enabled from monitors").fetchone() == (1,)

    def test_round_trips_a_boolean_through_the_column_the_python_writes_0_and_1_into(self, db):
        monitor(db, "a" * 32)
        db.execute("update monitors set enabled = ?", (to_sqlite_bool(False),))
        (enabled,) = db.execute("select enabled from monitors").fetchone()
        assert enabled == 0
        assert from_sqlite_bool(enabled) is False


class TestWhatOnlyThePythonCanGetWrong:
    """node:sqlite is autocommit and single-threaded by construction; Python's sqlite3 is neither
    unless it is opened that way."""

    def test_writes_a_statement_when_it_runs_as_node_sqlite_does(self, tmp_path):
        # Python's default opens a transaction before the first write and holds it until commit(),
        # so a second connection — the other backend, a backup — would see nothing
        db = create_database(tmp_path / "t.db")
        position(db, "p" * 32, "one")
        other = sqlite3.connect(tmp_path / "t.db")
        assert other.execute("select count(*) from positions").fetchone() == (1,)
        other.close()
        db.close()

    def test_refuses_to_be_used_from_another_thread(self, db):
        # the service runs on ONE asyncio loop (ADR 0021, Decision 6), and sqlite3's own same-thread
        # check is what holds it: a route written as a plain `def` runs in FastAPI's threadpool and
        # fails here rather than racing the sweep
        caught = []

        def elsewhere():
            try:
                db.execute("select 1")
            except sqlite3.ProgrammingError as err:
                caught.append(err)

        t = threading.Thread(target=elsewhere)
        t.start()
        t.join()
        assert caught and "same thread" in str(caught[0])

    async def test_a_body_that_answers_a_plain_value_is_not_awaited(self, db):
        # `fn: () => T | Promise<T>`: a synchronous body is a body too
        assert await atomic(db, lambda: 7) == 7

    async def test_rolls_back_a_body_that_was_cancelled_and_does_not_swallow_the_cancel(self, db):
        # JavaScript has no cancellation; asyncio does, and a task cancelled inside the transaction
        # must not leave BEGIN open for the next writer to trip over
        started = asyncio.Event()

        async def body():
            monitor(db, "a" * 32)
            started.set()
            await asyncio.sleep(10)

        task = asyncio.create_task(atomic(db, body))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert count(db, "monitors") == 0
        assert db.in_transaction is False

    def test_opens_an_existing_file_with_both_pragmas(self, tmp_path):
        create_database(tmp_path / "t.db").close()
        db = open_database(tmp_path / "t.db")
        assert db.execute("pragma foreign_keys").fetchone() == (1,)
        assert db.execute("pragma journal_mode").fetchone() == ("wal",)
        db.close()
