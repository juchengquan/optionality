"""Every golden case in cases/, run against the Python (ADR 0014).

The TypeScript computed each `expect`; this package must reproduce it EXACTLY. There is no tolerance
on purpose: the differences that matter are rounding at .5, and a tolerance is precisely what would
hide them.

Arguments are converted through each function's own type hints, so a case's Position dict becomes a
`Position` the same way a notebook's dict or an API response would.
"""

import importlib
import inspect
import json
import re
import typing
from datetime import datetime
from pathlib import Path

import pytest
from pydantic import BaseModel, TypeAdapter

CASES = Path(__file__).resolve().parents[2] / "cases"


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def decode(value):
    if isinstance(value, dict):
        if set(value) == {"$date"}:
            return datetime.fromisoformat(value["$date"])
        return {k: decode(v) for k, v in value.items()}
    if isinstance(value, list):
        return [decode(v) for v in value]
    return value


def encode(value):
    if isinstance(value, BaseModel):
        return encode(value.model_dump(by_alias=True))
    if isinstance(value, (set, frozenset)):
        return {"$set": sorted(encode(v) for v in value)}
    if isinstance(value, dict):
        return {k: encode(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [encode(v) for v in value]
    return value


def same(actual, expected) -> bool:
    """Equal, and of the same kind: True is not 1, and None is not 0."""
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(actual) is type(expected) and actual == expected
    if isinstance(expected, (int, float)):
        return isinstance(actual, (int, float)) and actual == expected
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expected)
            and all(same(a, e) for a, e in zip(actual, expected, strict=True))
        )
    if isinstance(expected, dict):
        return (
            isinstance(actual, dict)
            and actual.keys() == expected.keys()
            and all(same(actual[k], expected[k]) for k in expected)
        )
    return actual == expected


def call(module: str, fn: str, args: list):
    f = getattr(importlib.import_module(f"optionality.{module}"), snake(fn))
    hints = typing.get_type_hints(f)
    params = list(inspect.signature(f).parameters.values())
    converted = [TypeAdapter(hints[p.name]).validate_python(a) for p, a in zip(params, decode(args), strict=False)]
    try:
        return encode(f(*converted))
    except ValueError:
        # the contract is THAT it refuses, not what it says; anything but ValueError is a bug here
        return {"$throws": True}


def load():
    for path in sorted(CASES.glob("*.json")):
        file = json.loads(path.read_text())
        for case in file["cases"]:
            yield pytest.param(file["module"], case, id=f"{file['module']}.{case['fn']}: {case['name']}")


ALL = list(load())


def test_the_cases_are_there():
    # a missing cases/ directory would otherwise be a suite that passes by collecting nothing
    assert len(ALL) >= 100


@pytest.mark.parametrize(("module", "case"), ALL)
def test_reproduces_the_typescript(module, case):
    actual = call(module, case["fn"], case["args"])
    assert same(actual, case["expect"]), f"got {actual!r}, the TypeScript says {case['expect']!r}"
