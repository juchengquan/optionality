"""Opening the database, and the schema it is created from (ADR 0009, phase 4). Port of
backend/src/db/open.ts.

The standard library's `sqlite3` directly, with no ORM, blocking, as `node:sqlite` is (ADR 0021,
Decision 6): a query runs on the loop's own thread and holds it, which is what Node does too, so the
two backends have the same interleavings.

**Where the Python differs, and why.** Two things node:sqlite is by construction and `sqlite3` is
only when opened that way:

- **Autocommit**, `isolation_level=None`. Python's default opens a transaction before the first write
  and holds it until `commit()`, so every other connection to the file — the other backend's, a
  backup — would see nothing; and its `executescript` would commit a migration's BEGIN halfway.
  `atomic` opens its transactions explicitly, as the TypeScript's does.
- **One thread.** `check_same_thread` is left ON: a connection used from any thread but the one that
  opened it raises. The service runs on one asyncio loop, so that is the loop's thread, and the check
  is what HOLDS it — a route written as a plain `def`, which FastAPI would run in its threadpool,
  fails at its first query instead of racing the sweep. The moomoo SDK's worker thread never touches
  the database.

`atomic` rolls back on ANY exit that is not a return, cancellation included, and re-raises it:
JavaScript has no cancellation, and a task cancelled inside the transaction must not leave BEGIN open
for the next writer.
"""

import inspect
import sqlite3
from collections.abc import Awaitable, Callable
from pathlib import Path

from .migrate import stamp_all

#: `schema/schema.sql` at the repository root, for the reason `migrate.py` gives its migrations: one
#: schema that either backend builds a database from (ADR 0021), resolved from this module.
SCHEMA = Path(__file__).resolve().parents[4] / "schema" / "schema.sql"


def open_database(path: Path | str) -> sqlite3.Connection:
    """Open an existing database for reading and writing, with the pragmas the old Python set.

    Both pragmas matter. WAL is stored in the file; foreign_keys is NOT — it is per connection and
    defaults to OFF, so a connection that forgets it turns a missed `monitor_positions` cleanup into a
    silent orphan instead of an error. That is how three bugs got in (#70-#72).
    """
    db = sqlite3.connect(path, isolation_level=None)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def apply_schema(db: sqlite3.Connection) -> None:
    """Create the tables. Safe to call on a database that already has them only if it is empty."""
    db.executescript(SCHEMA.read_text(encoding="utf-8"))


def create_database(path: Path | str) -> sqlite3.Connection:
    """A new database with the schema applied. Used by every test and by the scenario runner.

    Stamped, not migrated: schema.sql carries the current shape, so every migration's effect is
    already present and applying one would fail on a duplicate column. See `migrate.py`."""
    db = open_database(path)
    apply_schema(db)
    stamp_all(db)
    return db


async def atomic[T](db: sqlite3.Connection, fn: Callable[[], T | Awaitable[T]]) -> T:
    """Run `fn` inside a transaction, rolling back if it raises.

    Written out rather than taken from a library because this is the operation the delete paths
    depend on: clearing `monitor_positions` and removing the row it pointed at have to happen together
    or not at all. `fn` may answer a value or an awaitable, and is awaited only in the second case.
    """
    db.execute("BEGIN")
    try:
        out = fn()
        if inspect.isawaitable(out):
            out = await out
        db.execute("COMMIT")
        return out  # type: ignore[return-value]
    except BaseException:
        db.execute("ROLLBACK")
        raise
