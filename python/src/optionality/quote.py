"""Quotes: one contract's live figures. Mirrors typescript/src/domain/quote.ts.

A Quote stays a plain dict on purpose. moomoo sends about a hundred fields and the maths reads eight;
a model would either drop the ones a notebook wants or need changing whenever moomoo adds one.
"""

import math
from datetime import datetime
from typing import Any, NamedTuple

from pydantic import BaseModel, ConfigDict

from optionality.contract import parse_spx_code
from optionality.js import to_fixed
from optionality.timefmt import display_time, market_time_to_display

type Quote = dict[str, Any]
type ByCode = dict[str, Quote]


class Batch(NamedTuple):
    """What one bounded batch came back with: the quotes, and the codes the Provider does not know.

    `unknown`, not `bad`: the TypeScript's `QuoteBatch` has always called it that, and the two names
    for one concept were a divergence nothing checked (ADR 0017).
    """

    records: list[Quote]
    unknown: list[str]


def round4(value: float) -> float:
    """A points figure rounded for a human: `toFixed(4)`, which ties away from zero."""
    return to_fixed(value, 4)


def display_records(records: list[Quote], display_tz: str, fetched_at: datetime | None) -> ByCode:
    """Index a batch's records by code, with display-tz timestamps stamped on.

    Copies rather than mutates: the records are SHARED — the service caches its last batch and
    renders it on every poll — so writing `fetched_at` into them would plant one caller's stamp in
    state another owns. Not because conversion is non-idempotent: `market_time_to_display` requires
    a NAIVE time and declines a value that already carries an offset, which is cased in timefmt.

    `fetched_at` is the honest "data as-of"; `update_time` is only the last trade, and it arrives
    naive US-Eastern.
    """
    stamped = display_time(fetched_at, display_tz)
    by_code: ByCode = {}
    for raw in records:
        record = dict(raw)
        if record.get("update_time"):
            record["update_time"] = market_time_to_display(str(record["update_time"]), display_tz)
        record["fetched_at"] = stamped
        by_code[str(record.get("code"))] = record
    return by_code


def unverifiable_verdict(message: str) -> str:
    """Why a probe that THREW cannot vouch for these contracts.

    `verify_verdict`'s sibling, for the path where the Provider did not answer about them at all. It
    said "OpenD unreachable", which asserts an outage — and a Provider that answered and DECLINED
    throws here too: moomoo refuses every US stock index as a class, with a sentence and no culprit,
    so the containment loop re-throws it (ADR 0018). So it asserts neither, and prints the Provider's
    own sentence — which is where the difference between "could not be reached" and "answered and
    declined" actually reads.
    """
    return f"cannot verify contract: the Provider did not confirm it — {message}"


def verify_verdict(codes: list[str], batch: Batch) -> str | None:
    """Why these contracts cannot be trusted to exist, or None.

    Strict on purpose: creation is gated by a live probe and refuses while the Provider is down,
    because a monitor created against a contract that does not exist would quarantine itself on the
    first sweep. BOTH checks, though a code named unknown usually has no record either: a Provider
    that does both at once is contradicting itself, and a gate this strict takes the pessimistic
    reading.
    """
    if batch.unknown:
        return f"contract does not exist: {', '.join(batch.unknown)} — check strike and expiry"
    returned = {r.get("code") for r in batch.records}
    missing = [c for c in codes if c not in returned]
    if missing:
        return f"contract does not exist: {', '.join(missing)} — check strike and expiry"
    return None


class DerivedSpx(BaseModel):
    """SPX's price as the batch implies it, or None and the reason there is none (#288, ADR 0024)."""

    model_config = ConfigDict(frozen=True)
    #: points, to two places; None where nothing in the batch can give it
    price: float | None
    #: why `price` is None, in words a dash can sit beside; None when there is a price
    reason: str | None


def mid_price(bid: object, ask: object) -> float | None:
    """The mid of a quote, or None where there is no two-sided quote to take one from (#380).

    Every vendor's mapping derives `mid_price` through this one rule, in both languages. Both sides
    must be finite numbers (a bool is not one, as `typeof` says in the TypeScript), the ask above
    zero and the bid zero or more. Out of hours moomoo quotes every option bid 0 / ask 0, and a mid
    of 0 valued the book at 0.00 every evening: nobody offers an option for nothing, so an ask of
    zero is no offer at all. A worthless wing is bid 0 / ask 0.05 and keeps its mid. Mirrors
    `quote.ts`' `midPrice`.
    """
    b, a = _finite(bid), _finite(ask)
    if b is None or a is None or not a > 0 or b < 0:
        return None
    return (b + a) / 2


def _finite(value: object) -> float | None:
    """A figure from the wire, or None for anything that is not a finite number.

    `bool` is excluded explicitly, where the TypeScript gets it from `typeof`: in Python
    `isinstance(True, int)` is true.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:
        # an int past a double's range, which JavaScript reads as Infinity: not a figure
        return None
    return number if math.isfinite(number) else None


def derived_spx(records: list[Quote]) -> DerivedSpx:
    """SPX's price, worked out from the option quotes a batch already holds (#288, ADR 0024).

    moomoo serves each option's `option_premium`, worked out from the option's LAST price against
    the index as moomoo quotes it at that moment. Inverting it with that same last gives that index
    level back, with p = premium / 100:

        call  S = (K + last) / (1 + p)        put  S = (K - last) / (1 - p)

    The batch's figure is the MEDIAN over every SPX option carrying both, rounded to two places.
    No staleness filter (moomoo recomputes the premium whatever the last's age), never the mid
    (the premium was not worked out from it), never a Reference (ADR 0018). A last of zero or less
    is no trade and is left out; a negative premium is taken as it comes; an inversion that is not
    a positive finite number is left out. See the TypeScript for the measurements.
    """
    options = 0
    premiums = 0
    levels: list[float] = []
    for record in records:
        code = record.get("code")
        contract = parse_spx_code(code) if isinstance(code, str) else None
        if contract is None:
            continue
        options += 1
        premium = _finite(record.get("option_premium"))
        if premium is None:
            continue
        premiums += 1
        last = _finite(record.get("last_price"))
        if last is None or last <= 0:
            continue
        p = premium / 100
        try:
            level = (
                (contract.strike + last) / (1 + p)
                if contract.option_type == "CALL"
                else (contract.strike - last) / (1 - p)
            )
        except ZeroDivisionError:
            # JavaScript answers ±Infinity or NaN here, which it then leaves out as not finite
            continue
        if math.isfinite(level) and level > 0:
            levels.append(level)
    if not levels:
        if options == 0:
            reason = "no SPX option in the batch to derive it from"
        elif premiums == 0:
            reason = "the Provider gives no option premium to derive it from"
        else:
            reason = "no option in the batch has both a last trade and a premium"
        return DerivedSpx(price=None, reason=reason)
    levels.sort()
    mid = len(levels) // 2
    median = levels[mid] if len(levels) % 2 == 1 else (levels[mid - 1] + levels[mid]) / 2
    return DerivedSpx(price=to_fixed(median, 2), reason=None)


def sigma_distance(points: float, spx: float, iv: float, dte: float) -> float | None:
    """How many standard deviations of SPX to expiry a distance in points is (#297).

        sigma = points / (SPX × IV × √(DTE / 365))

    IV is the leg's own `option_implied_volatility`, a PERCENTAGE wherever it comes from (moomoo
    serves 18.5 for 18.5%; IB Gateway's fraction is converted at its field mapping), so it is divided
    by 100 here. DTE is calendar days over a calendar year. Rounded to two places and signed as the
    points are; None where an IV, an SPX or a DTE is not positive — on the expiry day there is no
    time left to measure — or the answer is not finite.
    """
    if not (iv > 0) or not (spx > 0) or not (dte > 0):
        return None
    try:
        sigma = points / (spx * (iv / 100) * math.sqrt(dte / 365))
    except ZeroDivisionError:
        # a denominator that underflowed to zero: JavaScript answers ±Infinity, not a figure
        return None
    return to_fixed(sigma, 2) if math.isfinite(sigma) else None


def one_sigma(spx: float, iv: float, dte: float) -> float | None:
    """One standard deviation of SPX to expiry, in points (#298).

        1 sigma = SPX × IV × √(DTE / 365)

    The width `sigma_distance` divides a distance by, served on its own so the price map can draw a
    ±1 sigma band about SPX without the browser working it out (ADR 0005). IV is a percentage and DTE
    calendar days, as there. Rounded to two places; None where an IV, an SPX or a DTE is not positive,
    or the answer is not finite.
    """
    if not (iv > 0) or not (spx > 0) or not (dte > 0):
        return None
    width = spx * (iv / 100) * math.sqrt(dte / 365)
    return to_fixed(width, 2) if math.isfinite(width) else None


class StrikeDistance(BaseModel):
    """A short strike placed against SPX: what the strike strip draws (#297)."""

    model_config = ConfigDict(frozen=True)
    code: str
    option_type: str
    strike: float
    #: the leg's own delta from the same batch, or None where it served none
    delta: float | None
    #: how far SPX has still to move to reach the strike, to two places: POSITIVE while it has not
    #: (above a put's strike, below a call's), negative by how far past; None without an SPX
    points: float | None
    #: `points` in sigma to expiry (`sigma_distance`), or None where either cannot be a figure
    sigma: float | None
    #: one sigma of SPX to expiry in points, from this leg's IV (`one_sigma`, #298): the price map's
    #: band. None without an SPX or an IV, or with no day left.
    one_sigma: float | None


def strike_distances(codes: list[str], by_code: ByCode, spx: float | None, dte: float) -> list[StrikeDistance]:
    """Each of these contracts — a spread's SHORT legs — placed against SPX's price (#297).

    In the order given, with delta and IV read from the same batch. The price is the batch's own
    `derived_spx`, never a Reference's figure (ADR 0018): without one each strike is still placed and
    its delta read, and only the distances are None. A code naming no SPX option is left out.
    """
    out: list[StrikeDistance] = []
    for code in codes:
        contract = parse_spx_code(code)
        if contract is None:
            continue
        record = by_code.get(code) or {}
        points = (
            None
            if spx is None
            else to_fixed(contract.strike - spx if contract.option_type == "CALL" else spx - contract.strike, 2)
        )
        iv = _finite(record.get("option_implied_volatility"))
        out.append(
            StrikeDistance(
                code=code,
                option_type=contract.option_type,
                strike=contract.strike,
                delta=_finite(record.get("option_delta")),
                points=points,
                sigma=None if points is None or spx is None or iv is None else sigma_distance(points, spx, iv, dte),
                one_sigma=None if spx is None or iv is None else one_sigma(spx, iv, dte),
            )
        )
    return out
