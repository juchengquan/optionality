"""What "the same" means for a scenario, from `testdata/scenarios/README.md`'s "Comparing".

As JSON values: object key order does not matter, array order does, a boolean is not a number,
and numbers compare as IEEE doubles, exactly, with no tolerance. Python's own `==` gets three of
those wrong — `True == 1`, `(1, 2) != [1, 2]` only by accident of type, and an `int` compared with
a `float` exactly rather than as the double JSON.parse would have read — so every case is spelled
out here rather than left to it.

`first_difference` says where and what, because a replay that only says "not equal" over a world,
a response and a row diff is a replay nobody can act on. `same` is defined by it, so the two cannot
disagree.
"""

from typing import Any


def _double(value: float) -> float:
    """A number as JSON.parse reads it. An integer past 2**53 has no double of its own, and the
    TypeScript that wrote the file could not tell it from its neighbour either."""
    try:
        return float(value)
    except OverflowError:
        return float("inf") if value > 0 else float("-inf")


def _kind(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return f"{type(value).__name__}, which is not JSON"


def first_difference(actual: Any, expected: Any, at: str = "$") -> str | None:
    """Where `actual` first differs from `expected`, and how — or None when they are the same."""
    a, e = _kind(actual), _kind(expected)
    if a != e:
        return f"at {at}: {actual!r} ({a}) where the scenario says {expected!r} ({e})"
    if a == "number":
        if _double(actual) != _double(expected):
            return f"at {at}: {actual!r} is not {expected!r}"
        return None
    if a == "array":
        if len(actual) != len(expected):
            return f"at {at}: length {len(actual)}, the scenario says {len(expected)}"
        for i, (x, y) in enumerate(zip(actual, expected, strict=True)):
            found = first_difference(x, y, f"{at}[{i}]")
            if found is not None:
                return found
        return None
    if a == "object":
        for key in actual:
            if key not in expected:
                return f'at {at}: unexpected key "{key}" ({actual[key]!r})'
        for key in expected:
            if key not in actual:
                return f'at {at}: missing key "{key}" ({expected[key]!r})'
            found = first_difference(actual[key], expected[key], f"{at}.{key}")
            if found is not None:
                return found
        return None
    if a in ("null", "boolean", "string"):
        return None if actual == expected else f"at {at}: {actual!r} is not {expected!r}"
    return f"at {at}: {actual!r} ({a})"


def same(actual: Any, expected: Any) -> bool:
    """Equal as JSON values, under the README's rules."""
    return first_difference(actual, expected) is None
