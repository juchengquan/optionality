"""Stored rows into the shapes the domain works in (ADR 0009, phase 5). Port of backend/src/hydrate.ts.

The split is deliberate: a row holds `legs` as JSON text and `enabled` as 0 or 1, because that is what
SQLite holds and what both backends write. The domain holds parsed legs and real booleans. One of the
two has to be converted, and doing it here means no row type ever claims to be something it is not and
no domain function ever parses JSON.

**A row is CHECKED on its way in** (#266), by the TypeScript's own rules in the TypeScript's own words:
what the domain's types say and nothing more, the first fault in field order named, as a `ValueError`.
The library's models validate too, but by pydantic's rules — which coerce a strike of "8100" and a sign
of "1" that the TypeScript refuses — and in pydantic's words, which `/positions/values` would answer
with. So the check comes first, and a row it passes is one the models accept as they stand. Until #266
this file was where the backends differed: the TypeScript cast, and swept such a row with a NaN where a
sign should be, while this refused it.

**Where the Python differs, and why.**

- `typeof v === "number"` is `int | float` without `bool` (`_is_number`): True is an int to Python and
  never a number to JavaScript. It matters most for a sign, because the model's `Literal[1, -1]` would
  take True as 1 (and 1.0 as 1, which is right: JavaScript has one kind of number).
- Legs that are not text are ruled on before any parser sees them, in both backends: a number (the
  column's affinity is NUMERIC, so legs of `'5'` are stored as 5) is read as itself, anything else is
  no JSON. `from_sqlite_json` refuses the `NaN` Python's `json` would read, as JSON.parse does, and
  the parser's error is the cause, in both.
"""

import math
from collections.abc import Callable
from typing import Any, NoReturn

from optionality.monitor import Monitor
from optionality.position import Position

from .db.rows import MonitorRow, PositionRow
from .db.values import from_sqlite_json

#: A test of one stored value, and the words for what it must be (`hydrate.ts`' `Rule`).
type Rule = tuple[Callable[[Any], bool], str]


def _is_number(value: Any) -> bool:
    """`typeof value === "number"`."""
    return isinstance(value, int | float) and not isinstance(value, bool)


TEXT: Rule = (lambda v: isinstance(v, str), "text")
TEXT_OR_NULL: Rule = (lambda v: v is None or isinstance(v, str), "text or null")
NUMBER: Rule = (_is_number, "a number")
NUMBER_OR_NULL: Rule = (lambda v: v is None or _is_number(v), "a number or null")
WHOLE: Rule = (lambda v: _is_number(v) and (isinstance(v, int) or v.is_integer()), "a whole number")
SIGN: Rule = (lambda v: _is_number(v) and v in (1, -1), "1 or -1")
OPTION_TYPE: Rule = (lambda v: isinstance(v, str) and v in ("CALL", "PUT"), '"CALL" or "PUT"')
SIDE: Rule = (lambda v: isinstance(v, str) and v in ("short", "long"), '"short" or "long"')
QTY: Rule = (
    lambda v: _is_number(v) and (isinstance(v, int) or v.is_integer()) and v >= 1,
    "a whole number, 1 or more",
)


class _Reader:
    """Reads one row's values, refusing the first that is not what its rule says."""

    def __init__(self, kind: str, name: Any) -> None:
        self._label = f"{kind} {name}" if isinstance(name, str) else f"a {kind}"

    def refuse(self, path: str, must: str) -> NoReturn:
        raise ValueError(f"{self._label} cannot be read: {path} must be {must}")

    def take(self, path: str, value: Any, rule: Rule) -> Any:
        test, must = rule
        return value if test(value) else self.refuse(path, must)

    def list(self, path: str, value: Any) -> list[Any]:
        return value if isinstance(value, list) else self.refuse(path, "a list")

    def fields(self, path: str, value: Any) -> dict[str, Any]:
        return value if isinstance(value, dict) else self.refuse(path, "an object")

    def json(self, path: str, value: Any) -> Any:
        if _is_number(value):
            return value if math.isfinite(value) else self.refuse(path, "JSON")
        if value is not None and not isinstance(value, str):
            self.refuse(path, "JSON")
        try:
            return from_sqlite_json(value)
        except ValueError as err:
            raise ValueError(f"{self._label} cannot be read: {path} must be JSON") from err


def to_monitor(row: MonitorRow) -> Monitor:
    read = _Reader("monitor", row["code"])
    monitor = {
        "id": read.take("id", row["id"], TEXT),
        "code": read.take("code", row["code"], TEXT),
        "strike_date": read.take("strike_date", row["strike_date"], TEXT),
        "option_type": read.take("option_type", row["option_type"], TEXT),
        "strike": read.take("strike", row["strike"], NUMBER),
        "field": read.take("field", row["field"], TEXT),
        "threshold": read.take("threshold", row["threshold"], NUMBER),
        "direction": read.take("direction", row["direction"], TEXT),
        "compare": read.take("compare", row["compare"], TEXT),
    }
    stored = read.json("legs", row["legs"])
    legs = None if stored is None else [_monitor_leg(read, i, v) for i, v in enumerate(read.list("legs", stored))]
    return Monitor(**monitor, legs=legs)


def _monitor_leg(read: _Reader, i: int, value: Any) -> dict[str, Any]:
    leg = read.fields(f"legs[{i}]", value)
    return {
        "sign": read.take(f"legs[{i}].sign", leg.get("sign"), SIGN),
        "option_type": read.take(f"legs[{i}].option_type", leg.get("option_type"), OPTION_TYPE),
        "strike": read.take(f"legs[{i}].strike", leg.get("strike"), NUMBER),
        # absent is 1, every leg written before #351; present, it multiplies the maths and must be one
        **({} if "qty" not in leg else {"qty": read.take(f"legs[{i}].qty", leg["qty"], QTY)}),
    }


def to_position(row: PositionRow) -> Position:
    read = _Reader("position", row["name"])
    position = {
        "id": read.take("id", row["id"], TEXT),
        "name": read.take("name", row["name"], TEXT),
        "strategy": read.take("strategy", row["strategy"], TEXT_OR_NULL),
        "opened_at": read.take("opened_at", row["opened_at"], TEXT_OR_NULL),
        "strike_date": read.take("strike_date", row["strike_date"], TEXT),
        "contracts": read.take("contracts", row["contracts"], WHOLE),
        "entry": read.take("entry", row["entry"], NUMBER_OR_NULL),
    }
    stored = read.json("legs", row["legs"])
    legs = read.list("legs", stored if stored is not None else [])
    return Position(**position, legs=[_leg(read, i, v) for i, v in enumerate(legs)])


def _leg(read: _Reader, i: int, value: Any) -> dict[str, Any]:
    leg = read.fields(f"legs[{i}]", value)
    return {
        "side": read.take(f"legs[{i}].side", leg.get("side"), SIDE),
        "option_type": read.take(f"legs[{i}].option_type", leg.get("option_type"), OPTION_TYPE),
        "strike": read.take(f"legs[{i}].strike", leg.get("strike"), NUMBER),
        **({} if "qty" not in leg else {"qty": read.take(f"legs[{i}].qty", leg["qty"], QTY)}),
    }
