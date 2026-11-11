"""The payoff at expiry: what a structure makes or loses on its expiry day, at every SPX level, for the
Entry taken (#291, ADR 0023). Mirrors typescript/src/domain/payoff.ts.

AT EXPIRY ONLY: an option is then worth its intrinsic value and nothing else, so the curve needs no
pricing model and no market data — the legs, the Entry and the count. A T+0 curve, a "today" line or a
probability would need a model the service does not have.

The curve is piecewise linear with its corners at the strikes, so the P&L at each strike and the slope
beyond the outer two describe all of it. Signed as everywhere else (ADR 0013): Entry is a credit
RECEIVED, a debit negative. In POINTS, across the contracts held, as `realized_points` is.
"""

from pydantic import BaseModel, ConfigDict

from optionality.position import Leg
from optionality.quote import round4


class PayoffAt(BaseModel):
    """The P&L at expiry with SPX at `spx`."""

    model_config = ConfigDict(frozen=True)
    spx: float
    pnl: float


class Payoff(BaseModel):
    model_config = ConfigDict(frozen=True)
    #: the P&L with SPX settling at each strike, the lowest strike first, each strike once
    at_strikes: list[PayoffAt]
    #: how much the P&L changes for each point SPX rises below the lowest strike, and above the highest
    slope_below: float
    slope_above: float
    #: each SPX level at which the P&L is zero, lowest first
    breakevens: list[float]
    #: the highest P&L, or None where it rises without limit as SPX does (a long call)
    max_profit: float | None
    #: the LOWEST P&L, signed: a loss is negative. None where it falls without limit as SPX rises. Positive
    #: means the structure cannot lose — for a credit, the sign of a leg entered the wrong way round. Bounded
    #: below the lowest strike, because SPX stops at zero.
    max_loss: float | None


def _intrinsic(leg: Leg, spx: float) -> float:
    return max(0, spx - leg.strike) if leg.option_type == "CALL" else max(0, leg.strike - spx)


def _pnl_at(legs: list[Leg], entry: float, contracts: int, spx: float) -> float:
    """Entry less what the legs cost to settle, across the count: a plain left-to-right sum in the legs'
    order, as the TypeScript's is."""
    settle = 0
    for leg in legs:
        settle += (1 if leg.side == "short" else -1) * _intrinsic(leg, spx)
    return (entry - settle) * contracts


def payoff_at_expiry(legs: list[Leg], entry: float, contracts: int) -> Payoff:
    """The payoff at expiry of `legs`, for an Entry of `entry` points per contract, over `contracts`.

    Every derivation uses the unrounded figures and only the answers are rounded, to four places like
    every points figure, so a breakeven is not moved by its neighbours' rounding.
    """
    strikes = sorted({leg.strike for leg in legs})
    # SPX cannot settle below zero, so that is where the curve's left end is
    xs = strikes if strikes and strikes[0] <= 0 else [0, *strikes]
    vs = [_pnl_at(legs, entry, contracts, x) for x in xs]

    # below every strike only puts pay, each a point per point SPX falls; above, only calls
    below = 0
    above = 0
    for leg in legs:
        if leg.option_type == "PUT":
            below += 1 if leg.side == "short" else -1
        else:
            above += -1 if leg.side == "short" else 1
    slope_below = below * contracts
    slope_above = above * contracts

    breakevens: list[float] = []
    for i, (x, v) in enumerate(zip(xs, vs, strict=True)):
        if v == 0:
            breakevens.append(x)
        if i + 1 < len(xs):
            nx, nv = xs[i + 1], vs[i + 1]
            if (v < 0 and nv > 0) or (v > 0 and nv < 0):
                breakevens.append(x + (nx - x) * -v / (nv - v))
    # past the highest strike the line goes on for ever, and crosses zero once if it heads that way
    last = vs[-1]
    if (last < 0 and slope_above > 0) or (last > 0 and slope_above < 0):
        breakevens.append(xs[-1] - last / slope_above)

    return Payoff(
        at_strikes=[PayoffAt(spx=spx, pnl=round4(vs[xs.index(spx)])) for spx in strikes],
        slope_below=slope_below,
        slope_above=slope_above,
        breakevens=[round4(b) for b in breakevens],
        max_profit=None if slope_above > 0 else round4(max(vs)),
        max_loss=None if slope_above < 0 else round4(min(vs)),
    )
