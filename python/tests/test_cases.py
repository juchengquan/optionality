"""Every golden case in testdata/golden/, run against the Python (ADR 0014).

The TypeScript computed each `expect`; this package must reproduce it EXACTLY. There is no tolerance
on purpose: the differences that matter are rounding at .5, and a tolerance is precisely what would
hide them.

Arguments are converted through each function's own type hints, so a case's Position dict becomes a
`Position` the same way a notebook's dict or an API response would.
"""

import importlib
import inspect
import json
import math
import re
import typing
from datetime import datetime
from pathlib import Path

import pytest
from pydantic import BaseModel, TypeAdapter

CASES = Path(__file__).resolve().parents[2] / "testdata" / "golden"


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


NON_FINITE = {"NaN": math.nan, "Infinity": math.inf, "-Infinity": -math.inf, "-0": -0.0}


def decode(value):
    if isinstance(value, dict):
        if set(value) == {"$date"}:
            return datetime.fromisoformat(value["$date"])
        if set(value) == {"$num"}:
            return NON_FINITE[value["$num"]]
        # a Set as an ARGUMENT, which only appeared once lifecycle.silenceReason was cased
        # (ADR 0017): until then `$set` was written by results and never read by inputs
        if set(value) == {"$set"}:
            return {decode(v) for v in value["$set"]}
        return {k: decode(v) for k, v in value.items()}
    if isinstance(value, list):
        return [decode(v) for v in value]
    return value


def encode(value):
    if isinstance(value, BaseModel):
        return encode(value.model_dump(by_alias=True))
    # the four numbers JSON cannot write, spelled as the TypeScript spells them. -0.0 is compared
    # rather than exempted: Math.round(-0.5) is -0, and `0` would be wrong in a way JSON hides.
    if isinstance(value, float) and not isinstance(value, bool):
        if math.isnan(value):
            return {"$num": "NaN"}
        if math.isinf(value):
            return {"$num": "Infinity" if value > 0 else "-Infinity"}
        if value == 0.0 and math.copysign(1.0, value) < 0:
            return {"$num": "-0"}
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
    # a missing testdata/golden/ directory would otherwise be a suite that passes by collecting nothing
    assert len(ALL) >= 100


@pytest.mark.parametrize(("module", "case"), ALL)
def test_reproduces_the_typescript(module, case):
    actual = call(module, case["fn"], case["args"])
    assert same(actual, case["expect"]), f"got {actual!r}, the TypeScript says {case['expect']!r}"
