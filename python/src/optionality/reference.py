"""What a Reference reads. Mirrors backend/src/domain/reference.ts.

A Reference is a Security kept on the page to read the market by: it never alarms, need not be held,
and no rule reads one. SPX is shown through SPY ×10 because moomoo refuses every US stock index as a
CLASS — measured against the live gateway, where `GetStaticInfo` names `US..SPX` happily and all
three quote endpoints decline it (ADR 0018).

The arithmetic is a multiplication, which is not the decision. The decision is WHICH FIELD IS TRUE:
on 2026-11-02 SPY's last trade read 755.72 while its own book gave 758.73, stale from the previous
session while the book was current pre-market. So the mid leads and the last is the fallback.
"""

import math

from pydantic import BaseModel, ConfigDict

from optionality.quote import Quote, round4


class ReferenceReading(BaseModel):
    """What the strip draws: one figure, the field it came from, and the day's move.

    `field` is published rather than kept private so the page can say which number it is showing:
    a mid and a last are different claims, and a figure whose provenance is invisible cannot be
    checked against a broker screen.
    """

    model_config = ConfigDict(frozen=True)
    #: the figure, scaled and rounded, or None where neither field arrived
    figure: float | None
    #: "mid_price" | "last_price", or None when there is no figure
    field: str | None
    #: the move against the previous close, as a FRACTION of it, or None. Scale-free by
    #: construction — both sides are the unscaled reading — and left unrounded, where the figure is
    #: rounded to four places: a ratio is about 0.004 and four places would throw away the digits
    #: that make it readable as a percent.
    change: float | None


NOTHING = ReferenceReading(figure=None, field=None, change=None)

#: the fields a Reference's figure may come from, in the order of preference
FIELDS = ("mid_price", "last_price")


def _price(value: object) -> float | None:
    """A quoted price, or None for anything that is not one.

    POSITIVE, not merely finite. An empty book quotes 0 on both sides and `(0 + 0) / 2` is a mid, so
    a Security nobody is quoting yet arrives with `mid_price: 0` — which times a scale of 10 is still
    0, and 0 prints as a price. A genuinely worthless far wing therefore reads as a dash rather than
    as zero, which is the cheaper of the two mistakes: a dash is not a claim.

    `bool` is excluded explicitly, where the TypeScript gets it from `typeof`: moomoo sends booleans
    too (`suspension`), and in Python `isinstance(True, int)` is true.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    return float(value)


def reference_figure(quote: Quote | None, scale: float | None) -> ReferenceReading:
    """One Reference's reading, or nothing at all.

    `scale` is nullable and None means ×1, as the column is: most References need none, and a stored
    1 would invite the strip to print "×1".
    """
    if not quote:
        return NOTHING
    for field in FIELDS:
        raw = _price(quote.get(field))
        if raw is None:
            continue
        previous = _price(quote.get("prev_close_price"))
        return ReferenceReading(
            figure=round4(raw * (1 if scale is None else scale)),
            field=field,
            # the same field on both sides of the subtraction: a figure taken from the book and a
            # change measured from the last trade would be a pair of numbers that cannot both be true
            change=None if previous is None else (raw - previous) / previous,
        )
    return NOTHING
