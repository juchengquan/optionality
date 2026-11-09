"""IB Gateway's figures, under the service's names. A PORT of `typescript/src/vendors/ibkr/fields.ts`.

`tests/test_ibkr.py` holds it to `testdata/vendors/ibkr-fields.json` — what the TypeScript computes
for all sixteen recorded cases, over figures measured against the live gateway on 2026-11-08. Two
implementations, one recorded truth, compared exactly, which is what `tests/test_cases.py` gives the
domain.

## This is the MAPPING only; there is no client here yet

Deliberately, and the reason is worth stating rather than discovering. The mapping is the half that
is cased and the half where a wrong answer is PLAUSIBLE: a delayed tick id landing on the wrong
field shows a bid as a last, and IBKR's implied volatility of 0.1368 is moomoo's 14.007, so a rule
written at 14 would never fire. Those are the errors a corpus catches.

A `quotes()` answering `quotes.QuoteFetcher` is the other half. It was blocked on how to verify it
without the Python suite spawning Node, and that is now answered (ADR 0021, Decision 7): the
gateway conversations are recorded once in `testdata/vendors/ibkr-gateway/`, a Python stub replays
the same messages to `ib_async`, and the client must return exactly the batch the TypeScript client
did (`expected/`). It lands with the Python backend's vendor door (phase 4).

## What the client will use, when it is written, and why

Measured on 2026-11-09 against both the stub and the live gateway. `ibapi` on PyPI is IBKR's own
2020 code uploaded by a third party: unmaintained, under IBKR's non-OSS licence, and topping out at
protocol 157 — exactly what the gateway here negotiates DOWN to, so no headroom. The live gateway
(IB Gateway 10.52) offers 178. `ib_async` is BSD, maintained, and knows 178.

Its awkwardness, recorded so the next reader does not rediscover it: `connectAsync` will not report
a connection until the accounts list is populated, and it requests positions whatever `fetchFields`
says. Both are portfolio concerns this path does not have — ADR 0019's point is that there is no
order message and nothing account-shaped — so a connection wants `readonly=True` with the startup
fetch off, and an unanswered positions request is a warning rather than a fault. The stub was taught
to answer `managedAccounts` for exactly this reason.

And whatever is written must not trade. `ib_async` can place orders; the TypeScript's `messages.ts`
carries no order message precisely so the service cannot trade by absence rather than by discipline,
and that property is this module's to keep too.
"""

from typing import NamedTuple

from optionality.quote import Quote

#: IB Gateway's tick ids, mapped to the service's names. The delayed ids carry the same figures
#: from the delayed feed, so they map to the same names: WHICH tier answered is reported once per
#: request by the gateway (see `grade`) rather than inferred from the ids, because the gateway
#: contradicted a request once — asked for delayed, it granted live.
PRICE_TICKS: dict[int, str] = {
    1: "bid_price", 2: "ask_price", 4: "last_price", 9: "prev_close_price",
    66: "bid_price", 67: "ask_price", 68: "last_price", 75: "prev_close_price",
}

#: the greeks message's ids: the model computation, live and delayed. Nothing else is read — a bid-
#: or ask-implied computation is a different claim from the model's.
GREEK_TICKS = frozenset({13, 53})

#: the keys `has_figures` does not count: identity and the grade. The gateway answers a grade for
#: every request, including ones that then price nothing.
_NOT_A_FIGURE = frozenset({"code", "name", "delayed", "last_known"})


class Grade(NamedTuple):
    """IB Gateway's four data grades, as the two independent facts they really are."""

    #: the delayed tier answered — a fact about the subscription, not about today
    delayed: bool
    #: the vendor is serving the most recent value it holds rather than an updating one
    last_known: bool


class Greeks(NamedTuple):
    implied_vol: float | None
    delta: float | None
    gamma: float | None
    vega: float | None
    theta: float | None


def grade(type_: int) -> Grade | None:
    """Four grades are two questions, not one scale.

    Grade 4 is both delayed AND last known, which is why collapsing it into either neighbour loses
    something the gateway bothered to distinguish — it drew that distinction per contract in a
    single response on 2026-11-08. A grade nobody documented is not a claim about freshness: None
    renders as nothing, and nothing is what the strip shows for a source that did not say.
    """
    match type_:
        case 1:
            return Grade(delayed=False, last_known=False)
        case 2:
            return Grade(delayed=False, last_known=True)
        case 3:
            return Grade(delayed=True, last_known=False)
        case 4:
            return Grade(delayed=True, last_known=True)
        case _:
            return None


def greek_fields(figures: Greeks) -> Quote:
    """The greeks, under the service's names and in the service's units."""
    out: Quote = {}
    if figures.delta is not None:
        out["option_delta"] = figures.delta
    if figures.gamma is not None:
        out["option_gamma"] = figures.gamma
    if figures.vega is not None:
        out["option_vega"] = figures.vega
    if figures.theta is not None:
        out["option_theta"] = figures.theta
    # the 100x that is not a rename: IBKR's 0.1368 is moomoo's 14.007, and a rule's threshold is
    # written in the service's units
    if figures.implied_vol is not None:
        out["option_implied_volatility"] = figures.implied_vol * 100
    return out


def with_mid(record: Quote) -> Quote:
    """The mid, where BOTH sides arrived.

    Mutates the record it is given, as the TypeScript does, and only when both sides are numbers: a
    mid from one side is a number with no meaning, and `reference.FIELDS` prefers the mid over the
    last trade. Zero on both sides is an empty book and stays zero — whether 0 may be SHOWN is ADR
    0018's positivity guard to decide, not this mapping's to suppress.
    """
    bid = record.get("bid_price")
    ask = record.get("ask_price")
    if _is_number(bid) and _is_number(ask):
        record["mid_price"] = (bid + ask) / 2
    return record


def has_figures(record: Quote) -> bool:
    """Whether a record carries any of the figures that were asked for.

    The completion rule for a bounded ask, and the distinction it keeps is ADR 0015's: a record
    with a code and nothing else is the gateway saying "subscribed, nothing yet" — a figure that
    did not arrive, counted by the sweep and quarantined after N of them — and NOT a contract that
    does not exist. Those are different answers and the service keeps them apart.
    """
    return any(key not in _NOT_A_FIGURE and value is not None for key, value in record.items())


def _is_number(value: object) -> bool:
    """`typeof value === "number"`, ported. A bool passes `isinstance(x, int)` in Python, and a
    `bid_price` of True would otherwise average into a mid."""
    return isinstance(value, int | float) and not isinstance(value, bool)
