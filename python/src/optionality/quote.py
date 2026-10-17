"""Quotes: one contract's live figures. Mirrors backend/src/domain/quote.ts.

A Quote stays a plain dict on purpose. moomoo sends about a hundred fields and the maths reads eight;
a model would either drop the ones a notebook wants or need changing whenever moomoo adds one.
"""

from typing import Any

from optionality._js import to_fixed

type Quote = dict[str, Any]
type ByCode = dict[str, Quote]


def round4(value: float) -> float:
    """A points figure rounded for a human: `toFixed(4)`, which ties away from zero."""
    return to_fixed(value, 4)
