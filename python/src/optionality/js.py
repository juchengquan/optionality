"""JavaScript's number rules, reproduced exactly. Mirrors backend/src/domain/js.ts.

Named `js.py` since ADR 0017, not `_js.py`: the leading underscore said "internal helper", and
these four are now a cased module of the contract like any other. The package mirrors the domain
module for module, with snake_case the only translation, and a private name broke that.

The TypeScript is canonical, and it rounds three ways. Two of them it took from Python on purpose
(`round(x, 2)` for money, half-to-even for the fill bar), so the port uses Python's own there. The
other two are JavaScript's and are reproduced here, because Python's `round` ties to even:

- `Math.round` ties toward +infinity: 12.5 -> 13, -2.5 -> -2 (Python: 12 and -2)
- `Number.prototype.toFixed` rounds the EXACT binary value and ties away from zero:
  0.03125 -> 0.0313 (Python's round(0.03125, 4): 0.0312)

`number` and `truthy` are JavaScript's `Number(v)` and `if (v)`, for values read out of a quote,
where moomoo can send a string.

Held to the real thing by golden cases since ADR 0017. Before that these were four hand-written
claims with no case of their own, under all 36 of the comparisons that rested on them — and
measured against JavaScript on 2026-11-01 they diverged five ways: `Number(null)`, `Number("0x10")`
and `Number([])` answered NaN where JavaScript answers 0, 16 and 0; `truthy([])` answered False
where JavaScript answers true; and `math_round(-0.5)` answered 0 where JavaScript answers -0. None
was reachable, because every call site guards None first — the port was correct because its callers
were disciplined, not because it was right. It is right now, and `testdata/golden/js.json` is why.
"""

import math
import re
from decimal import ROUND_HALF_UP, Decimal, localcontext


def math_round(x: float) -> float:
    """`Math.round`: the nearest integer, ties toward +infinity. Exact, unlike floor(x + 0.5)."""
    if not math.isfinite(x):
        return x
    floor = math.floor(x)
    nearest = float(floor + 1 if x - floor >= 0.5 else floor)
    # -0, not 0: JavaScript keeps the sign of a zero and so does Python, so there is no reason to
    # lose it. Math.round(-0.5) and Math.round(-0.2) are both -0 (ADR 0017 retired the exemption
    # this used to have, once the cases could carry the value).
    if nearest == 0.0 and (x < 0.0 or math.copysign(1.0, x) < 0.0):
        return -0.0
    return nearest


def to_fixed(x: float, digits: int) -> float:
    """`Number(x.toFixed(digits))`: the exact value rounded half away from zero.

    `localcontext` because `quantize` raises `InvalidOperation` once the integer digits plus
    `digits` pass the default precision of 28 — `to_fixed(1e18, 10)` threw where
    `(1e18).toFixed(10)` answers 1e18. The `>= 1e21` guard covered it only while `digits <= 7`,
    which is true of every call site in this package: correct because its callers were disciplined,
    which is the thing this module exists to stop (review 2026-11-01).

    JavaScript refuses a digit count outside 0..100 with a RangeError, and so does this: a caller
    that passes one has a bug, and answering anyway hides it.
    """
    if not 0 <= digits <= 100:
        raise ValueError(f"toFixed() digits argument must be between 0 and 100, got {digits}")
    if not math.isfinite(x) or abs(x) >= 1e21:
        return x
    with localcontext() as ctx:
        # room for every integer digit of a double plus the decimals asked for
        ctx.prec = 400
        return float(Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


# JavaScript's StrWhiteSpace: the Unicode space separators plus the ASCII controls, NBSP, BOM and
# the line terminators. `str.strip()` alone also eats \x1c-\x1f, which JavaScript does not.
_WS = "\t\n\v\f\r \xa0                　﻿"
# ASCII, because `\d` matches every Unicode decimal digit and `float()` accepts them:
# `number("١٢٣")` answered 123.0 where JavaScript answers NaN (review 2026-11-01)
_DECIMAL = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$", re.ASCII)
_RADIX = {"x": 16, "o": 8, "b": 2}
_RADIX_DIGITS = {
    16: re.compile(r"[0-9a-fA-F]+", re.ASCII),
    8: re.compile(r"[0-7]+", re.ASCII),
    2: re.compile(r"[01]+", re.ASCII),
}


def _from_string(text: str) -> float:
    """JavaScript's StringToNumber, which is wider than Python's `float`."""
    text = text.strip(_WS)
    if text == "":
        return 0.0
    if text in ("Infinity", "+Infinity"):
        return math.inf
    if text == "-Infinity":
        return -math.inf
    # 0x10 is 16, and a SIGNED radix literal is not a number at all: Number("-0x10") is NaN.
    # The digits are matched before converting, because `int()` tolerates `_` separators, a sign and
    # inner whitespace and JavaScript's StringNumericLiteral does not — `number("0x1_0")` answered
    # 16.0 where JavaScript answers NaN (review 2026-11-01).
    if len(text) > 2 and text[0] == "0" and text[1] in "xXoObB":
        radix = _RADIX[text[1].lower()]
        if not _RADIX_DIGITS[radix].fullmatch(text[2:]):
            return math.nan
        return float(int(text[2:], radix))
    if _DECIMAL.match(text):
        return float(text)
    return math.nan


def number(value: object) -> float:
    """`Number(value)` for what a quote field can hold."""
    if value is None:
        # JavaScript's `null`, which is 0. `undefined` would be NaN, and JSON has no spelling for it
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        return _from_string(value)
    if isinstance(value, (list, tuple)):
        # ToPrimitive joins with commas, then the string rules apply: [] is 0, [5] is 5, [1,2] NaN
        return _from_string(_stringify(value))
    return math.nan


def js_string(value: float) -> str:
    """A number as JavaScript writes it: no trailing `.0`, and `1e+21` rather than a long integer.

    Python's `str(5.0)` is "5.0" and JavaScript's `String(5)` is "5". That shows up wherever a
    figure is interpolated into a sentence both languages must agree on — the alarm notice's
    threshold, and a contract code's strike.
    """
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == int(value) and abs(value) < 1e21:
        return str(int(value))
    return repr(value)


def _stringify(value: object) -> str:
    """Array.prototype.join's view of an element, which is all `number` needs of it.

    It RECURSES into a nested list, because join calls `String` on each element and String of an
    array is its own join. Python's `repr` gave "[5]", so `number([[5]])` answered NaN where
    JavaScript answers 5 (review 2026-11-01). `number([1,2])` agreed either way, which is why it
    read as correct.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        return ",".join(_stringify(v) for v in value)
    if isinstance(value, float):
        return js_string(value)
    return str(value)


def truthy(value: object) -> bool:
    """JavaScript's truthiness: only false, 0, -0, "", null, undefined and NaN are falsy.

    A container is TRUTHY, where Python's `bool` calls an empty one false — `[]` and `{}` are both
    truthy in JavaScript, and `"0"` is truthy in both.
    """
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return not (value == 0 or math.isnan(value))
    if isinstance(value, str):
        return value != ""
    return True
