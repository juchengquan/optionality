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
import re
import uuid
from typing import Any

from optionality.js import js_string


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
    """JSON on its way into the database, exactly as `JSON.stringify` writes it.

    Byte for byte, and not merely the same value: both backends write the ONE database file (ADR
    0021, Decision 3), and the sweep tells a changed sample by comparing this TEXT
    (`engine/positions.ts`: `stored.legs_iv === legsIv`), so a second spelling of one value reads
    as a change and rewrites the row. Python's own `json.dumps` writes
    `[{"sign": -1, "strike": 8050.0}]` where JSON.stringify writes `[{"sign":-1,"strike":8050}]`,
    and the door scenarios, which compare these columns as values, would never notice the file
    filling with both.

    So: no spaces; every number as `String(n)` writes it, through `optionality.js.js_string`, and a
    number that is not finite as `null` (Python would write the bare token `NaN`, which is not JSON,
    and JSON.parse would refuse the whole row); strings as JSON.stringify quotes them, non-ASCII kept
    and a lone surrogate escaped; an object's keys in the order a JavaScript object keeps them, which
    is insertion order except that array-index keys come first, ascending. What JSON cannot hold —
    a datetime, a model, a key that is not a string — raises, as `json.dumps` would: the caller
    converts it first, knowing what it should become.
    """
    return _stringify(value)


def _stringify(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        number = float(value)  # a JavaScript number is a double, an integer past 2**53 included
        return js_string(number) if math.isfinite(number) else "null"
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_stringify(v) for v in value) + "]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise TypeError(f"a JSON key must be a string, not {type(key).__name__}: {key!r}")
        indices = sorted((k for k in value if _is_index(k)), key=int)
        ordered = indices + [k for k in value if not _is_index(k)]
        return "{" + ",".join(f"{_quote(k)}:{_stringify(value[k])}" for k in ordered) + "}"
    raise TypeError(f"not JSON: {type(value).__name__}")


# a canonical array index: 0 to 2**32 - 2, written with no sign and no leading zero
_INDEX = re.compile(r"0|[1-9][0-9]*", re.ASCII)


def _is_index(key: str) -> bool:
    return _INDEX.fullmatch(key) is not None and int(key) < 2**32 - 1


# a surrogate code point in a Python str is always a lone one: a pair is one code point already
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _quote(text: str) -> str:
    """A string as JSON.stringify quotes it. `json.dumps` escapes the same characters the same way
    once it is told to keep non-ASCII (`"`, `\\`, the controls below 0x20, `\\b\\f\\n\\r\\t` short
    and the rest as lowercase `\\u00xx`), and differs only on a lone surrogate, which it writes raw."""
    quoted = json.dumps(text, ensure_ascii=False)
    return _LONE_SURROGATE.sub(lambda m: f"\\u{ord(m[0]):04x}", quoted)


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
