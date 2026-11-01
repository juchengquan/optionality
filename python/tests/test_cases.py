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
    # MORE arguments than parameters means the TypeScript takes an argument this port does not.
    # `zip(strict=False)` dropped the extra in silence, so a parameter lost in the port — or gained
    # on the canonical side and not mirrored — left every case passing on the Python default. The
    # cases are the only thing holding the port, so the hole was in the guard itself (review
    # 2026-11-01). Fewer is legal and deliberate: eight cases omit a trailing optional argument,
    # which is the only way a DEFAULT is ever compared.
    assert len(args) <= len(params), (
        f"optionality.{module}.{snake(fn)} takes {len(params)} arguments; "
        f"the case passes {len(args)} — the port is missing a parameter"
    )
    for extra in params[len(args) :]:
        assert extra.default is not inspect.Parameter.empty, (
            f"optionality.{module}.{snake(fn)} requires {extra.name}, which the case does not pass"
        )
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


def load_constants():
    """Each module's exported VALUES, which the cases above cannot carry: a case is a call."""
    for path in sorted(CASES.glob("*.json")):
        file = json.loads(path.read_text())
        for name, expected in file.get("constants", {}).items():
            yield pytest.param(file["module"], name, expected, id=f"{file['module']}.{name}")


ALL = list(load())
CONSTANTS = list(load_constants())


def test_the_cases_are_there():
    # a missing testdata/golden/ directory would otherwise be a suite that passes by collecting nothing
    assert len(ALL) >= 100


def test_the_constants_are_there():
    # the same guard `test_the_cases_are_there` is: a file shape that changed would otherwise make
    # this suite pass by collecting nothing
    assert len(CONSTANTS) >= 4


@pytest.mark.parametrize(("module", "name", "expected"), CONSTANTS)
def test_states_the_same_constant(module, name, expected):
    """An exported value, compared like a computed one.

    The TypeScript's coverage guard filters on `typeof v === "function"`, so these were mirrored on
    trust: a name UPPER_SNAKE in both languages, with nothing checking the value. A tuple here
    against an array there is fine — both encode to a list — and a frozenset against a Set is fine
    for the same reason. What is not fine is a different zone, or a greek missing from a list.
    """
    mod = importlib.import_module(f"optionality.{module}")
    assert hasattr(mod, name), f"optionality.{module} has no {name}"
    assert same(encode(getattr(mod, name)), expected), f"got {getattr(mod, name)!r}, the TypeScript says {expected!r}"


@pytest.mark.parametrize(("module", "case"), ALL)
def test_reproduces_the_typescript(module, case):
    actual = call(module, case["fn"], case["args"])
    assert same(actual, case["expect"]), f"got {actual!r}, the TypeScript says {case['expect']!r}"
