"""Schema migrations (ADR 0011). Port of backend/src/db/migrate.ts.

Plain `.sql` files applied in name order, each in a transaction, with a table recording what has run.
Language-neutral on purpose: both backends apply the same files to the one database and record them
in the same table, so whichever starts first after a change applies it and the other finds it done
(ADR 0021, Decision 3).

`schema.sql` always carries the CURRENT shape, which means a database built from it already has
everything the migrations would add. Such a database is therefore STAMPED rather than migrated — the
same move alembic's `stamp head` makes, and the one the cutover made by hand.

**Where the Python differs, and why.** A script of several statements runs through `executescript`,
which COMMITS any transaction already open before it starts — on Python 3.12 whatever the connection's
`isolation_level` — so a `BEGIN` executed first would be committed at once and a failed migration
would leave half of itself behind (measured: `test_migrate.py` failed that way). The `BEGIN` is
therefore the script's own first statement, which `executescript` leaves open for the record and the
`COMMIT`. A failure is a `RuntimeError` from the original, which stays its `__cause__`.
"""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

APPLIED_TABLE = "schema_migrations"

#: `schema/migrations/` at the repository root, not beside this module: the migrations are shared
#: ground that either backend applies to the one database (ADR 0021), so they cannot live inside one
#: backend's source. Resolved from this module rather than from the working directory, because
#: launchd, `make serve` and the suites each start the process somewhere different.
DIRECTORY = Path(__file__).resolve().parents[4] / "schema" / "migrations"


def _ensure_table(db: sqlite3.Connection) -> None:
    """Deliberately not `alembic_version`: that table belonged to alembic, held a single revision
    hash, and was what the old Python rollback read — two mechanisms, two records. Migration 0005
    dropped it with the rollback (phase 10).

    The DDL is the TypeScript's character for character, whitespace included, because SQLite keeps it
    verbatim in `sqlite_master` and both backends may be the one that creates it."""
    db.execute(
        f"CREATE TABLE IF NOT EXISTS {APPLIED_TABLE} (\n"
        "       name VARCHAR(100) NOT NULL PRIMARY KEY,\n"
        "       applied_at DATETIME NOT NULL\n"
        "     )"
    )


def _now() -> str:
    """`new Date().toISOString().replace("T", " ").slice(0, 23)`: UTC to the millisecond, no zone."""
    return datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")[:23]


def _all_migrations(directory: Path | str | None = None) -> list[str]:
    return sorted(p.name for p in Path(directory or DIRECTORY).iterdir() if p.name.endswith(".sql"))


def pending_migrations(db: sqlite3.Connection, directory: Path | str | None = None) -> list[str]:
    """Which migrations this database has not recorded, in the order they must run."""
    _ensure_table(db)
    done = {r[0] for r in db.execute(f"select name from {APPLIED_TABLE}")}
    return [n for n in _all_migrations(directory) if n not in done]


def stamp_all(db: sqlite3.Connection, directory: Path | str | None = None) -> None:
    """Record every migration as run without running any of it. For a database built from
    schema.sql, which already has their effect."""
    _ensure_table(db)
    now = _now()
    for name in _all_migrations(directory):
        db.execute(f"insert or ignore into {APPLIED_TABLE} (name, applied_at) values (?, ?)", (name, now))


def migrate(db: sqlite3.Connection, directory: Path | str | None = None) -> list[str]:
    """Apply what is pending, and answer what was applied. Raises on the first failure, having rolled
    that one back.

    Synchronous and not using `atomic`, which is async: this runs before the service serves anything,
    and a half-applied schema must never be something the server starts on top of."""
    pending = pending_migrations(db, directory)
    applied: list[str] = []
    for name in pending:
        sql = (Path(directory or DIRECTORY) / name).read_text(encoding="utf-8")
        try:
            # the transaction opens INSIDE the script: `executescript` commits one opened before it
            db.executescript(f"BEGIN;\n{sql}")
            db.execute(f"insert into {APPLIED_TABLE} (name, applied_at) values (?, ?)", (name, _now()))
            db.execute("COMMIT")
        except Exception as err:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise RuntimeError(f"migration {name} failed: {err}") from err
        applied.append(name)
    return applied
