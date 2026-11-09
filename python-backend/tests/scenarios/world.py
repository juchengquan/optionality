"""A scenario's world, made real: a database holding exactly its rows, vendors that answer from its
tables, a clock that says what it says, ids minted in a stated order, and a Telegram that delivers
into a list. Mirrors `backend/testing/scenarios/world.ts`, and the half of `format.ts` that reads
the schema.

Nothing here knows a door. `doors.py` runs the three on top of this, and the backend is built on
it through `backend.py`, so this half stands on its own — which is why it can be tested in full
before a line of the backend exists.

**The database is built by the backend's own `db/open.create_database`**, as `world.ts` calls the
TypeScript's `createDatabase`, because the two backends share one file (ADR 0021): from
`schema/schema.sql`, with the two pragmas `open_database` sets, and STAMPED rather than migrated
(ADR 0011) — every file in `schema/migrations/` recorded as run, because schema.sql already has their
effect. Until phase 3 this module wrote its own copy of all three, character for character.

Deterministic BY INJECTION, never by scrubbing: the clock and the id minter are handed to the
backend, so what a replay records is what the backend actually wrote.
"""

import json
import shutil
import sqlite3
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from optionality.quote import Batch
from optionality.quotes import QuoteFetcher

from optionality_backend.db.migrate import DIRECTORY
from optionality_backend.db.open import create_database

from .compare import same

#: `schema/migrations/` at the repository root, which the backend stamps a new database with
MIGRATIONS = DIRECTORY

#: every table a scenario states, in an order rows can be inserted without breaking a foreign key.
#: `schema_migrations` is not one: it is bookkeeping, stamped when a database is made, and no door
#: reads it (`format.ts`'s TABLES)
TABLES = ("positions", "monitors", "monitor_positions", "position_samples", "reference_securities")

#: the columns that hold JSON text. A scenario writes their CONTENT, so they are compared as
#: values, and their bytes may differ between languages by design (`8050` against `8050.0`)
JSON_COLUMNS = {
    "monitors": ("legs",),
    "positions": ("legs",),
    "position_samples": ("legs_iv", "legs_vega"),
}

type Row = dict[str, Any]
type Tables = dict[str, list[Row]]
type Calls = dict[str, list[list[str]]]


class WorldError(Exception):
    """A scenario that describes a world nobody can build."""


def minted_id(n: int) -> str:
    """The n-th id minted during the event: n in hexadecimal, zero-padded to the 32 characters of
    the uuid4 hex the service otherwise mints. Counted from 1, per scenario."""
    return format(n, "032x")


def instant(text: str) -> datetime:
    """An ISO 8601 instant from a scenario — always UTC, always with its zone."""
    when = datetime.fromisoformat(text)
    if when.tzinfo is None:
        raise WorldError(f"{text} names no zone; a scenario's instants are UTC")
    return when.astimezone(UTC)


def json_text(value: Any) -> str:
    """Compact and unescaped, as `JSON.stringify` writes it, so the text a world puts in a JSON
    column is the TypeScript's text for everything the corpus holds. Where it cannot be (Python
    spells `1e-07` where JavaScript spells `1e-7`) nothing reads it but a JSON parser."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


# -- the database --------------------------------------------------------------------------------


def _info(db: sqlite3.Connection, table: str) -> list[tuple]:
    return db.execute(f"pragma table_info({table})").fetchall()


def primary_keys(db: sqlite3.Connection) -> dict[str, list[str]]:
    """Each table's primary key, read from the schema rather than written here (`primaryKeys`)."""
    return {t: [c[1] for c in sorted((c for c in _info(db, t) if c[5] > 0), key=lambda c: c[5])] for t in TABLES}


def columns_of(db: sqlite3.Connection) -> dict[str, list[str]]:
    """Each table's columns, in the order the schema declares them (`columnsOf`)."""
    return {t: [c[1] for c in _info(db, t)] for t in TABLES}


def _encode(table: str, column: str, value: Any) -> Any:
    if column not in JSON_COLUMNS.get(table, ()) or value is None:
        return value
    return json_text(value)


def _decode(table: str, column: str, value: Any) -> Any:
    if column not in JSON_COLUMNS.get(table, ()) or value is None:
        return value
    # `JSON.parse(String(value))`: a JSON column whose text looked like a number came back as one
    return json.loads(value if isinstance(value, str) else str(value))


def dump_tables(db: sqlite3.Connection) -> Tables:
    """Every row of every table, ordered by primary key, columns in schema order (`dumpTables`)."""
    keys, columns = primary_keys(db), columns_of(db)
    out: Tables = {}
    for table in TABLES:
        cursor = db.execute(f"select * from {table} order by {', '.join(keys[table])}")
        names = [d[0] for d in cursor.description]
        out[table] = [{c: _decode(table, c, row[names.index(c)]) for c in columns[table]} for row in cursor.fetchall()]
    return out


def diff_tables(db: sqlite3.Connection, before: Tables, after: Tables) -> dict[str, dict[str, list]]:
    """What happened to the tables, by primary key (`diffTables`): rows added (whole), rows changed
    (the columns that moved, before and after), rows removed (their keys). Tables nothing happened
    to are left out.

    A column has moved when its VALUE has, under the README's rules — not its spelling. The
    TypeScript compares `JSON.stringify` texts, which is the same thing for every value it reads
    back from SQLite; here 7300 and 7300.0 would be two texts and one number."""
    keys = primary_keys(db)
    diff: dict[str, dict[str, list]] = {}
    for table in TABLES:

        def key_of(row: Row, table: str = table) -> Row:
            return {k: row[k] for k in keys[table]}

        def index(rows: list[Row], table: str = table) -> dict[str, Row]:
            return {json_text(key_of(r, table)): r for r in rows}

        was, now = index(before.get(table, [])), index(after.get(table, []))
        added = [r for k, r in now.items() if k not in was]
        removed = [key_of(r) for k, r in was.items() if k not in now]
        changed = []
        for k, r in now.items():
            if k not in was:
                continue
            old = was[k]
            moved = [c for c in r if not same(old.get(c), r[c])]
            if moved:
                changed.append(
                    {"key": key_of(r), "from": {c: old.get(c) for c in moved}, "to": {c: r[c] for c in moved}}
                )
        if not (added or changed or removed):
            continue
        diff[table] = {
            **({"added": added} if added else {}),
            **({"changed": changed} if changed else {}),
            **({"removed": removed} if removed else {}),
        }
    return diff


def insert_rows(db: sqlite3.Connection, tables: Tables) -> None:
    """The world's rows, inserted as they are stated: every column, and no other."""
    columns = columns_of(db)
    for table in TABLES:
        for row in tables.get(table, []):
            missing = [c for c in columns[table] if c not in row]
            extra = [c for c in row if c not in columns[table]]
            if missing or extra:
                raise WorldError(
                    f"a {table} row must name every column and no other: "
                    f"missing {', '.join(missing) or 'none'}, unknown {', '.join(extra) or 'none'}"
                )
            holes = ", ".join("?" for _ in columns[table])
            db.execute(
                f"insert into {table} ({', '.join(columns[table])}) values ({holes})",
                [_encode(table, c, row[c]) for c in columns[table]],
            )


def fill(db: sqlite3.Connection, tables: Tables) -> None:
    """The world's rows, inserted — and checked, because a row the database stores differently from
    how the file says it (a number as text, a boolean for a number) is a scenario describing a
    world nobody can build. Compared row by row on the primary key, as `fill` in `world.ts` does,
    so neither the order of the rows nor of a row's columns is part of the format."""
    insert_rows(db, tables)
    astray = diff_tables(db, tables, dump_tables(db))
    if astray:
        raise WorldError(
            "the database does not hold the rows the scenario states — write them as it stores "
            f"them:\n{json.dumps(astray, indent=2, ensure_ascii=False)}"
        )


# -- the fakes ---------------------------------------------------------------------------------------


class VendorError(Exception):
    """What a fake vendor raises: an outage, or a refusal of the whole batch."""


def fake_vendor(name: str, table: dict[str, Any], calls: Calls, outage: Callable[[], str | None]) -> QuoteFetcher:
    """A vendor answering from its table, recording every call, the failed ones included. In order:
    an error if it is `down`; an error naming the first requested code it `rejects`; otherwise a
    record for each requested code it quotes, the requested codes it does not know, and nothing at
    all for the rest — "subscribed, nothing yet", which is not the same as unknown. The library's
    own port (`optionality.quotes.QuoteFetcher`) is the shape, because it is what the backend reads."""

    def fetch(codes: list[str]) -> Batch:
        calls.setdefault(name, []).append(list(codes))
        down = outage()
        if down is not None:
            raise VendorError(down)
        rejected = next((c for c in codes if c in table["rejects"]), None)
        if rejected is not None:
            raise VendorError(table["rejects"][rejected])
        return Batch(
            records=[{"code": c, **table["quotes"][c]} for c in codes if c in table["quotes"]],
            unknown=[c for c in codes if c in table["unknown"]],
        )

    return fetch


@dataclass
class Clock:
    """What the clock says now; moved by `doors.py` for each earlier sweep."""

    now: datetime


@dataclass
class Outage:
    """Whether the Provider is failing right now, and with what: an earlier sweep may say so."""

    down: str | None


@dataclass
class Provider:
    """The Provider's port, and what its own probe answers (`/health` asks before any batch has)."""

    name: str
    fetch_quotes: QuoteFetcher
    reachable: Callable[[], bool]


@dataclass
class OpenWorld:
    """Everything the backend is built on, faked where `world.ts` fakes it and nowhere else."""

    path: Path
    db: sqlite3.Connection
    #: the scenario's `.env` lines, unparsed: reading them is the backend's job (its `env.py`)
    env: dict[str, str]
    clock: Clock
    new_id: Callable[[], str]
    provider: Provider
    #: every vendor by name, the Provider among them under its own, as `openVendors` assembles
    sources: dict[str, QuoteFetcher]
    outage: Outage
    #: the sweep's Telegram transport, and what it delivered, in order
    send: Callable[[str], None]
    sent: list[str]
    #: the bot's Telegram API, and every `sendMessage` it was asked for, in order
    api: Callable[[str, dict[str, Any]], Any]
    replies: list[dict[str, Any]]
    calls: Calls
    close: Callable[[], None] = field(repr=False)


def open_world(world: dict[str, Any]) -> OpenWorld:
    """The world, opened: a fresh database holding exactly `world["tables"]`, and the fakes the
    backend is built on. Closing it removes the database."""
    folder = Path(tempfile.mkdtemp(prefix="optionality-scenario-"))
    path = folder / "scenario.db"
    db = create_database(path)

    def close() -> None:
        db.close()
        shutil.rmtree(folder, ignore_errors=True)

    try:
        fill(db, world["tables"])
    except BaseException:
        close()
        raise

    calls: Calls = {}
    outage = Outage(world["provider"]["down"])
    p = world["provider"]
    provider = Provider(
        name=p["name"],
        fetch_quotes=fake_vendor(p["name"], p, calls, lambda: outage.down),
        reachable=lambda: p["reachable"],
    )
    sources: dict[str, QuoteFetcher] = {provider.name: provider.fetch_quotes}
    for name, table in world["sources"].items():
        sources[name] = fake_vendor(name, table, calls, lambda table=table: table["down"])

    minted = 0

    def new_id() -> str:
        nonlocal minted
        minted += 1
        return minted_id(minted)

    sent: list[str] = []

    def send(text: str) -> None:
        if world["telegram"] == "down":
            raise VendorError("telegram is down")
        sent.append(text)

    replies: list[dict[str, Any]] = []

    def api(method: str, params: dict[str, Any]) -> Any:
        if method == "sendMessage":
            replies.append(dict(params))
        return {}

    return OpenWorld(
        path=path,
        db=db,
        env=dict(world["settings"]),
        clock=Clock(instant(world["clock"])),
        new_id=new_id,
        provider=provider,
        sources=sources,
        outage=outage,
        send=send,
        sent=sent,
        api=api,
        replies=replies,
        calls=calls,
        close=close,
    )
