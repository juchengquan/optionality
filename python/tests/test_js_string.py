"""`js_string` against JavaScript's `String(n)`.

`js_string` mirrors no TypeScript function — the TypeScript interpolates a number where the Python
must spell the conversion out — so no golden case holds it, and until 2026-11-09 nothing did. It was
right wherever the alarm notices had used it and wrong in two places found when the backend began
writing stored JSON through it: below 1e-4, where Python's `repr` turns to an exponent six places
before JavaScript does and pads it (`1e-05` for `0.00001`, `1e-07` for `1e-7`), and for an integer
past 2**53, where `str(int(x))` printed the double's exact binary value and JavaScript prints its
shortest digits padded with zeros.

Every expected string below was produced by Node 26 with `String(x)`, run once on 2026-11-09.
"""

import math

import pytest

from optionality.js import js_string

CASES = [
    (8050.0, "8050"),
    (-8050.0, "-8050"),
    (0.5, "0.5"),
    (100.5, "100.5"),
    (1234.5678, "1234.5678"),
    (0.1 + 0.2, "0.30000000000000004"),
    (-0.0, "0"),
    # the decimal form reaches six places below the point in JavaScript, four in Python's repr
    (0.0001, "0.0001"),
    (0.00001, "0.00001"),
    (0.000001, "0.000001"),
    # and past it, JavaScript's exponent is unpadded
    (1e-7, "1e-7"),
    (-1e-7, "-1e-7"),
    (1.5e-7, "1.5e-7"),
    (1.23e-18, "1.23e-18"),
    (5e-324, "5e-324"),
    # integers print whole up to 1e21, as their shortest digits padded with zeros
    (1e16, "10000000000000000"),
    (2.0**53, "9007199254740992"),
    (2.0**60, "1152921504606847000"),
    (123456789012345680000.0, "123456789012345680000"),
    (1e20, "100000000000000000000"),
    # and from 1e21 as an exponent with its sign
    (1e21, "1e+21"),
    (1.5e21, "1.5e+21"),
    (1e300, "1e+300"),
    (1.7976931348623157e308, "1.7976931348623157e+308"),
    (math.nan, "NaN"),
    (math.inf, "Infinity"),
    (-math.inf, "-Infinity"),
]


@pytest.mark.parametrize(("value", "expected"), CASES, ids=[e for _, e in CASES])
def test_writes_a_number_as_javascripts_string_does(value: float, expected: str) -> None:
    assert js_string(value) == expected
