"""Converting between what SQLite stores and what Python works in (ADR 0009, phase 4).
Port of backend/src/db/values.ts.

Booleans are why the TypeScript has this file: node:sqlite REFUSES a JavaScript boolean as a bind
value, so every write of `enabled`, `triggered` or `notify` has to go through it. Python's `sqlite3`
would bind `True` as 1 by itself, so that reason does not cross over — but the rule it serves does:
the rows hold 0 and 1, which both backends read, and the conversions stay in one place so the two
backends make them at the same call sites.

Minting an id belongs here for the same reason: it is a value shaped for a stored column.
"""

import json
import math
import uuid
from typing import Any


def new_id() -> str:
    """A new row id: uuid4().hex — 32 hex characters, no dashes, which every `id VARCHAR(32)` column
    is sized for. One definition, because a dashed uuid is 36."""
    return uuid.uuid4().hex


def to_sqlite_bool(value: bool) -> int:
    """A boolean on its way into the database: 0 or 1, an `int` and not a `bool` that equals one."""
    return 1 if value else 0


def from_sqlite_bool(value: int) -> bool:
    """A boolean on its way out. Anything non-zero is true, which is what SQLAlchemy does."""
    return value != 0


def to_sqlite_json(value: Any) -> str:
    """JSON on its way into the database.

    Python's own bytes, `[{"sign": -1, "strike": 8050.0}]` — spaces after the separators, and
    8050.0 — which is what the service before the cutover wrote and every row copied from it holds.
    The TypeScript writes `[{"sign":-1,"strike":8050}]`. The values are the same, each side parses
    the other's text, and nothing reads these bytes except a JSON parser, so the difference is
    accepted, not overlooked: matching JSON.stringify would mean writing a serialiser to imitate
    another language's formatting. The scenarios compare these columns as values for this reason.

    The VALUE is JSON.stringify's, though, where the two disagree about one: a number that is not
    finite is written `null`, as JavaScript writes it, and not as the bare `NaN` Python would — which
    is not JSON, so the TypeScript's JSON.parse would refuse the whole row. And -0 is written 0.
    """
    return json.dumps(_as_javascript_writes(value))


def _as_javascript_writes(value: Any) -> Any:
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return 0.0 if value == 0 else value
    if isinstance(value, dict):
        return {k: _as_javascript_writes(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_as_javascript_writes(v) for v in value]
    return value


def _refuse(token: str) -> None:
    raise ValueError(f"not JSON: {token}")


def from_sqlite_json(value: str | None) -> Any:
    """JSON on its way out, or None for a NULL column.

    Refusing what JSON.parse refuses: Python's `json` reads `NaN` and `Infinity`, which are not JSON.
    A row the TypeScript cannot hydrate is quarantined, and a row this read anyway would leave the two
    backends disagreeing about which rules the sweep can evaluate. The TypeScript's `<T>` is a cast
    that checks nothing, so this answers `Any` and the caller's model does the checking.
    """
    return None if value is None else json.loads(value, parse_constant=_refuse)
