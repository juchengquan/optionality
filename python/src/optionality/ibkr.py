"""IB Gateway, from Python: the client, and the figures it maps. Needs the `ibkr` extra to CONNECT.

    client = IbkrClient(port=4002, client_id=9301)    # one connection, held across asks
    records, unknown = await client.fetch_quotes(["US.SPXW261218C8100000", "SPX"])
    client.close()

    records, unknown = quotes([...], port=4002, client_id=9301)   # one-shot, from a script
    account = await client.account()                  # the account's totals and holdings (ADR 0030)
    watch = await client.watch_account()              # the account HELD while asked (ADR 0031)
    watch.picture(); await watch.stop()

A PORT of `typescript/src/vendors/ibkr/`, in three parts, and each is held to the TypeScript:

* the MAPPING (`fields.ts`) — tick ids to the service's names, the four data grades as the two
  facts they are, the 100x on implied volatility; and the account's (ADR 0030): which account,
  the id masked, a portfolio row as a holding with its cost per share, the totals in the base; and
  the account watch's (ADR 0031): a P&L stream's figures, IB's unset read as none, and a holding live. `tests/test_ibkr.py` holds it to
  `testdata/vendors/ibkr-fields.json`, what the TypeScript computes for every recorded case.
* the NAMING (`contract.ts`) — a service code as the contract IB Gateway wants: an option by
  parsing it, an index by the exchange that calculates it. `tests/test_ibkr_client.py` mirrors
  `contract.test.ts`.
* the CLIENT (`client.ts`) — one bounded ask over a held connection. `tests/test_ibkr_gateway.py`
  replays every conversation in `testdata/vendors/ibkr-gateway/` to it through a Python stub and
  compares what comes back with what the TypeScript's client made of the same bytes (`expected/`),
  exactly: same recording in, same quote batch out (ADR 0021, Decision 7).

## Whose decision is whose

The client is built on `ib_async` (BSD, maintained, protocol 157 to 178) rather than ported from
the hand-written TypeScript, because trading should remain possible later (ADR 0021, Decision 7) —
and `ibapi` on PyPI is IBKR's 2020 code uploaded by a third party, under IBKR's non-OSS licence and
topping out at 157, exactly what the gateway here negotiates down to.

`ib_async` owns the WIRE: the socket, the framing, the handshake and its protocol range, every
request's encoding, and the layout of every message it reads — including the ones whose layout
moves between 157 and 178. This module owns what a field MEANS, and every decision `client.ts`
makes: the grade read and carried, a -1 or an empty field as no figure, the conid cache, unknown
against silence, the bounded waits and what a timeout means.

Two of `ib_async`'s readings are therefore not used, and both are the FIGURE messages. Its decoder
skips a price tick whose price is empty, before any callback, and converts every greek with
`float()`, so one empty field drops the whole computation with a logged traceback. The TypeScript
reads a field at a time (`messages.ts`' `reading`): an empty price is no figure but still the
gateway ANSWERING, which is what separates "subscribed, nothing yet" from silence — recorded on
2026-11-09 and 2026-11-10 from a SNAPSHOT of SPX, whose high, low and close all come with their
prices empty (`index-in-the-session`'s notes). So `_FigureDecoder` reads ticks 1 and
21 from their fields, at the positions `ib_async`'s own decoder reads them at every version it
speaks, and leaves every other message to `ib_async`.

## How it connects, and why not through `IB`

`ib_async`'s `IB.connectAsync` is a portfolio client's connect: it asks for the account's
positions on EVERY connect, whatever `fetchFields` says, and waits out its whole timeout for the
answer; `readonly=True` turns off only the open- and completed-order fetches. Neither is a lock —
`readonly` refuses no order. A quote fetch has nothing account-shaped in it (ADR 0019), so this
connects `ib_async`'s `Client` directly, which performs the handshake and sends nothing else,
and the Python sends exactly what `messages.ts` sends: startApi, reqMarketDataType,
reqContractDetails, reqMktData, cancelMktData — and, only when the account is read (ADR 0030),
reqAccountUpdates, a subscribe and its unsubscribe; and only when it is watched (ADR 0031), reqPnL,
reqPnLSingle and their two cancels. `tests/test_ibkr_gateway.py` holds it to that.

The account's four messages are read field by field too (`_FigureDecoder`), at `ibapi` 9.81's
positions: `ib_async`'s PORTFOLIO_VALUE reader converts every figure with `float()`, so one empty
field would drop a whole holding where the TypeScript reads it as no figure. MANAGED_ACCTS, which
arrives with the handshake, reaches `_Reader.managedAccounts` and is read by `managed_accounts`. The P&L
streams' two messages (94 and 95, ADR 0031) are read field by field as well: `ib_async`'s readers
convert with `float(field or 0)`, so an empty figure would be a P&L of 0.

Two differences `ib_async` forces, neither in a recording: it calls a session started once BOTH
nextValidId and managedAccounts have arrived (the TypeScript, on nextValidId), so a gateway that
names no account never completes the handshake here; and its protocol floor is 157 where the
TypeScript's is 156, so a 156 gateway is refused.

## What is NOT here

Nothing that trades. `ib_async` can place orders, so the absence the TypeScript gets from
`messages.ts` having no order message is held here by a lint instead: `optionality.no_trading`
names every call and class in `ib_async` that places, modifies, cancels or exercises an order, and
`tests/test_no_trading.py` refuses each of them anywhere in this package. IB Gateway's own
Read-Only API switch is the lock that holds against intent.
"""

import asyncio
import functools
import logging
import math
import re
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, NamedTuple, Protocol, TypedDict, cast

from optionality.contract import parse_spx_code

# JavaScript's whitespace, which `trim()` and `Number` strip: a BOM is in it, and `\x1c`-`\x1f`, which
# Python's `str.strip()` strips, are not — every trim below is the TypeScript's, through this
from optionality.js import _WS as _JS_WHITESPACE
from optionality.js import number
from optionality.quote import Batch, Quote, mid_price

if TYPE_CHECKING:
    from ib_async.client import Client

_log = logging.getLogger(__name__)

#: IB Gateway's tick ids, mapped to the service's names. The delayed ids carry the same figures
#: from the delayed feed, so they map to the same names: WHICH tier answered is reported once per
#: request by the gateway (see `grade`) rather than inferred from the ids, because the gateway
#: contradicted a request once — asked for delayed, it granted live.
PRICE_TICKS: dict[int, str] = {
    1: "bid_price",
    2: "ask_price",
    4: "last_price",
    9: "prev_close_price",
    66: "bid_price",
    67: "ask_price",
    68: "last_price",
    75: "prev_close_price",
}

#: the greeks message's ids: the model computation, live (13) and delayed (83). Nothing else is read —
#: a bid- or ask-implied computation is a different claim from the model's, and so is the CUSTOM one
#: (53), which this once named as the delayed model's (`fields.ts` says how that was found)
GREEK_TICKS = frozenset({13, 83})

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
    """The mid, where there is a two-sided quote.

    Mutates the record it is given, as the TypeScript does, by the one rule every vendor shares
    (`quote.mid_price`): both sides, and an ask above zero. A mid from one side is a number with no
    meaning, and so is the 0 of an empty book (#380), which `reference.FIELDS`, the sweep and the
    holdings would all read as a price. The sides are kept as they came.
    """
    mid = mid_price(record.get("bid_price"), record.get("ask_price"))
    if mid is not None:
        record["mid_price"] = mid
    return record


def has_figures(record: Quote) -> bool:
    """Whether a record carries any of the figures that were asked for.

    The completion rule for a bounded ask, and the distinction it keeps is ADR 0015's: a record
    with a code and nothing else is the gateway saying "subscribed, nothing yet" — a figure that
    did not arrive, counted by the sweep and quarantined after N of them — and NOT a contract that
    does not exist. Those are different answers and the service keeps them apart.
    """
    return any(key not in _NOT_A_FIGURE and value is not None for key, value in record.items())


# --- the account (ADR 0030; `fields.ts`' `IbkrAccount`) -----------------------------------------


class IbkrTotals(TypedDict):
    """The account's totals from ACCT_VALUE, in the base currency; None where the gateway sent none."""

    net_liquidation: float | None
    total_cash: float | None
    unrealized_pnl: float | None
    realized_pnl: float | None


class IbkrHolding(TypedDict):
    """One PORTFOLIO_VALUE row: a position as IBKR marks it, in its own currency."""

    #: IB's security type, `STK`, `OPT`, `FUT`, ... as sent
    sec_type: str
    symbol: str
    currency: str
    #: lastTradeDateOrContractMonth as sent (`20261218`); None where empty, as for a stock
    expiry: str | None
    #: None for anything that is not an option
    strike: float | None
    #: "C" or "P"; None for anything that is not an option
    right: Literal["C", "P"] | None
    #: None where the gateway sent none, as for a stock
    multiplier: float | None
    #: signed: a short position is negative; None only where the field came empty
    position: float | None
    #: IBKR's own mark, per share
    market_price: float | None
    #: the position's value at that mark, in `currency`
    market_value: float | None
    #: PER SHARE: IB's `averageCost` divided by the multiplier, which IB's includes (`per_share_cost`)
    average_cost: float | None
    unrealized_pnl: float | None
    realized_pnl: float | None


class IbkrAccountRefused(Exception):
    """The account read refused to choose: several accounts on the login and none named, a named
    one not on it, or none named by the gateway at all (`client.ts`' `IbkrAccountRefused`). A fact
    about the configuration rather than the gateway's health; its message carries the ids MASKED."""


class IbkrUnreachable(ConnectionError):
    """The account read could not reach IB Gateway at all (`client.ts`' `IbkrUnreachable`): the
    connect failed, in its own words — a refused session ("IB Gateway refused the session: 326 …"), a
    refused connection ("could not reach IB Gateway at …"), a handshake that did not complete in time,
    or a gateway that closed the socket during the handshake. Distinct from a read that failed once it
    began (its deadline, or its connection closing under it), a plain ConnectionError, and from
    `IbkrAccountRefused`. Raised by `account()` only: `fetch_quotes` and `reachable()` are as they
    were."""


class IbkrAccount(TypedDict):
    """What the account read answers, read once and never stored, the id only ever MASKED."""

    #: the account id, masked: its leading letters, then always five `•`, then at most its last three
    #: characters (`U1234567` is `U•••••567`)
    account: str
    #: IB's paper accounts, whose ids start `DU`
    paper: bool
    #: the base currency the totals are in; None where the gateway did not say
    base_currency: str | None
    #: the gateway's ACCT_UPDATE_TIME exactly as sent: a time of day ("13:45") with NO DATE and no
    #: zone, which is all the message carries; None where none arrived before the end
    updated_at: str | None
    totals: IbkrTotals
    #: IBKR's exchange rates from `$LEDGER-ExchangeRate`: units of the base currency per ONE unit of
    #: each currency, by its code ({"USD": 1, "EUR": 1.0841} on a USD base). BASE itself is left
    #: out, the base currency is always 1, and a rate that is not a positive number is left out.
    exchange_rates: dict[str, float]
    holdings: list[IbkrHolding]


class IbkrPnl(TypedDict):
    """reqPnL's figures for the account, in the BASE currency; None where IB sent it unset (ADR 0031)."""

    daily_pnl: float | None
    unrealized_pnl: float | None
    realized_pnl: float | None


class IbkrLiveHolding(IbkrHolding):
    """A holding as the account watch holds it (ADR 0031; `fields.ts`' `IbkrLiveHolding`): an
    `IbkrHolding`, where `market_value`, `unrealized_pnl` and `market_price` (value / (position x
    multiplier)) are the holding's own P&L stream's once it has spoken for it — in the holding's own
    currency — and the rest the account updates'."""

    #: the stream's daily P&L, in the holding's currency; None before it speaks, or where unset
    daily_pnl: float | None


class IbkrLiveAccount(TypedDict):
    """The account as the watch holds it: the account read's answer, its holdings live, and the
    account's P&L apart from the totals, which stay the account updates' (ADR 0031)."""

    account: str
    paper: bool
    base_currency: str | None
    updated_at: str | None
    totals: IbkrTotals
    exchange_rates: dict[str, float]
    holdings: list[IbkrLiveHolding]
    #: reqPnL's last figures; None before it first speaks
    pnl: IbkrPnl | None
    #: when reqPnL last spoke, ms since the epoch by the client's `now`; None before
    pnl_at: float | None


#: ACCT_VALUE's keys the answer's totals are read from, and the name each takes (`fields.ts`).
#: Nothing else the gateway sends about the account is read: an AccountCode carries the id in full.
ACCOUNT_TOTALS: dict[str, str] = {
    "NetLiquidation": "net_liquidation",
    "TotalCashValue": "total_cash",
    "UnrealizedPnL": "unrealized_pnl",
    "RealizedPnL": "realized_pnl",
}

#: the tag ACCT_VALUE gives a figure summed over every currency and expressed in the base one
BASE = "BASE"

#: what stands for the hidden part of an account id: always five, so the mask does not say how long
#: the id is (the owner's decision on #469)
MASK = "•••••"

#: the prefix of the ledger's keys: the live gateway sends the P&L only as `$LEDGER-UnrealizedPnL` and
#: `$LEDGER-RealizedPnL`, a row for BASE and one per currency (measured on 2026-11-23)
LEDGER = "$LEDGER-"

#: the ledger key whose rows are IBKR's exchange rates: base units per unit of the row's currency
EXCHANGE_RATE = "$LEDGER-ExchangeRate"

#: the letters an account id's prefix is made of: ASCII only, as `fields.ts`' `/^[A-Za-z]*/`
_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


class AccountValueRow(TypedDict):
    """One ACCT_VALUE, its fields as the wire carried them."""

    key: str
    value: str
    currency: str


class PortfolioRow(TypedDict):
    """One PORTFOLIO_VALUE's fields as the wire carried them, the account aside."""

    sec_type: str
    symbol: str
    expiry: str
    strike: str
    right: str
    multiplier: str
    currency: str
    position: str
    market_price: str
    market_value: str
    average_cost: str
    unrealized_pnl: str
    realized_pnl: str


def managed_accounts(accounts: str) -> list[str]:
    """The accounts MANAGED_ACCTS names: one field, the ids separated by commas, the empty ones (a
    trailing comma) dropped."""
    return [a.strip(_JS_WHITESPACE) for a in accounts.split(",") if a.strip(_JS_WHITESPACE)]


def mask_account(account_id: str) -> str:
    """An account id as it may leave the client (`fields.ts`' `maskAccount`): its leading letters,
    which say what KIND of account it is, then always FIVE `•`, then at most its last three
    characters, which tell two apart — `U1234567` is `U•••••567`, the owner's decisions on #469: five
    whatever the length, so the id's length is hidden too. At least one character after the letters
    is always hidden (`U001` is `U•••••01`), and an id of letters alone has no prefix kept: neither
    rule may ever show an id whole."""
    letters = len(account_id) - len(account_id.lstrip(_LETTERS))
    prefix = "" if letters == len(account_id) else account_id[:letters]
    rest = account_id[len(prefix) :]
    # at most three shown, and never all of them: a short id would otherwise come out whole
    showing = max(0, min(3, len(rest) - 1))
    return prefix + MASK + rest[len(rest) - showing :]


def is_paper(account_id: str) -> bool:
    """IB's paper accounts are the ids that start `DU`."""
    return account_id.startswith("DU")


def choose_account(managed: list[str], wanted: str | None) -> dict[str, str]:
    """Which of the login's accounts to read (`{"account": id}`), or why none (`{"refused": words}`):
    the one there is; where there are several, the one `wanted` names; never a guess. Every id in a
    refusal is masked, `wanted`'s too."""
    named = (wanted or "").strip(_JS_WHITESPACE) or None
    masked = ", ".join(mask_account(a) for a in managed)
    if not managed:
        return {"refused": "IB Gateway named no account on this login"}
    if named is not None:
        if named in managed:
            return {"account": named}
        return {"refused": f"IBKR_ACCOUNT ({mask_account(named)}) names no account on this login, which has {masked}"}
    if len(managed) > 1:
        return {"refused": f"several accounts on this login; set IBKR_ACCOUNT to one of {masked}"}
    return {"account": managed[0]}


def per_share_cost(average_cost: float | None, multiplier: float | None) -> float | None:
    """The average cost PER SHARE: IB's `averageCost` for anything with a multiplier includes it — an
    option bought at 2.50 arrives as 250 — while its market price is per share. A multiplier that is
    absent, zero or not a number divides by nothing."""
    if average_cost is None:
        return None
    return average_cost / multiplier if multiplier is not None and multiplier > 0 else average_cost


def _figure_of(text: str) -> float | None:
    """A figure out of a text field, or None where it carries none (`fields.ts`' `figureOf`): read
    by JavaScript's `Number` (`optionality.js`), not by `float`, which reads "1_00" as 100 and
    refuses "0x1C" — the TypeScript reads them as no number and 28. Empty and non-finite are none."""
    if not text.strip(_JS_WHITESPACE):
        return None
    value = number(text)
    return value if math.isfinite(value) else None


def _side_of(right: str) -> Literal["C", "P"] | None:
    r = right.strip(_JS_WHITESPACE).upper()
    if r in ("C", "CALL"):
        return "C"
    if r in ("P", "PUT"):
        return "P"
    return None


def holding_from(row: PortfolioRow) -> IbkrHolding:
    """One PORTFOLIO_VALUE row as the answer's holding."""
    right = _side_of(row["right"])
    multiplier = _figure_of(row["multiplier"])
    return {
        "sec_type": row["sec_type"],
        "symbol": row["symbol"],
        "currency": row["currency"],
        "expiry": None if not row["expiry"].strip(_JS_WHITESPACE) else row["expiry"],
        # a stock's row carries a strike of 0: no strike, rather than one at zero
        "strike": None if right is None else _figure_of(row["strike"]),
        "right": right,
        "multiplier": multiplier,
        "position": _figure_of(row["position"]),
        "market_price": _figure_of(row["market_price"]),
        "market_value": _figure_of(row["market_value"]),
        "average_cost": per_share_cost(_figure_of(row["average_cost"]), multiplier),
        "unrealized_pnl": _figure_of(row["unrealized_pnl"]),
        "realized_pnl": _figure_of(row["realized_pnl"]),
    }


def account_answer(
    account_id: str, values: list[AccountValueRow], holdings: list[IbkrHolding], updated_at: str | None
) -> IbkrAccount:
    """The account's answer from what its read collected (`fields.ts`' `accountAnswer`): the base
    currency is the one NetLiquidation is sent in, and a total is read from its plain `BASE` row, then
    the ledger's `$LEDGER-…` BASE row (where the live gateway sends the P&L), then its plain row in
    the base code. The exchange rates are the ledger's by currency, BASE left out, the base 1, and a
    rate that is not a positive number left out."""
    net = next((v for v in values if v["key"] == "NetLiquidation" and v["currency"] != BASE), None)
    base = net["currency"] if net is not None and net["currency"].strip(_JS_WHITESPACE) else None
    totals: dict[str, float | None] = {}
    for key, name in ACCOUNT_TOTALS.items():
        row = next((v for v in values if v["key"] == key and v["currency"] == BASE), None)
        if row is None:
            row = next((v for v in values if v["key"] == LEDGER + key and v["currency"] == BASE), None)
        if row is None and base is not None:
            row = next((v for v in values if v["key"] == key and v["currency"] == base), None)
        totals[name] = None if row is None else _figure_of(row["value"])
    exchange_rates: dict[str, float] = {}
    for v in values:
        if v["key"] != EXCHANGE_RATE or v["currency"] == BASE or not v["currency"].strip(_JS_WHITESPACE):
            continue
        rate = _figure_of(v["value"])
        if rate is not None and rate > 0:
            exchange_rates[v["currency"]] = rate
    if base is not None:
        exchange_rates[base] = 1.0
    return {
        "account": mask_account(account_id),
        "paper": is_paper(account_id),
        "base_currency": base,
        "updated_at": updated_at,
        "totals": cast(IbkrTotals, totals),
        "exchange_rates": exchange_rates,
        "holdings": holdings,
    }


# --- the account watch (ADR 0031; `fields.ts`) ----------------------------------------------------

#: what IB sends for a figure it has not set: Java's `Double.MAX_VALUE`, written out in full
#: (`1.7976931348623157E308`); read as a number it would be a P&L of 1.8e308
UNSET_DOUBLE = sys.float_info.max


class PnlRow(TypedDict):
    """One PNL message's figures, as the wire carried them."""

    daily_pnl: str
    unrealized_pnl: str
    realized_pnl: str


class PnlSingleRow(TypedDict):
    """One PNL_SINGLE message's figures, as the wire carried them."""

    position: str
    daily_pnl: str
    unrealized_pnl: str
    realized_pnl: str
    value: str


class IbkrPnlSingle(TypedDict):
    """One holding's P&L stream, read: in the holding's own currency, None where unset or empty."""

    position: float | None
    daily_pnl: float | None
    unrealized_pnl: float | None
    realized_pnl: float | None
    value: float | None


def _stream_figure(text: str) -> float | None:
    """A stream's figure: none where the field is empty, not a number, or IB's unset."""
    value = _figure_of(text)
    return None if value == UNSET_DOUBLE else value


def pnl_from(row: PnlRow) -> IbkrPnl:
    """reqPnL's message as the account's P&L (`fields.ts`' `pnlFrom`)."""
    return {
        "daily_pnl": _stream_figure(row["daily_pnl"]),
        "unrealized_pnl": _stream_figure(row["unrealized_pnl"]),
        "realized_pnl": _stream_figure(row["realized_pnl"]),
    }


def pnl_single_from(row: PnlSingleRow) -> IbkrPnlSingle:
    """reqPnLSingle's message as one holding's stream reading (`fields.ts`' `pnlSingleFrom`)."""
    return {
        "position": _stream_figure(row["position"]),
        "daily_pnl": _stream_figure(row["daily_pnl"]),
        "unrealized_pnl": _stream_figure(row["unrealized_pnl"]),
        "realized_pnl": _stream_figure(row["realized_pnl"]),
        "value": _stream_figure(row["value"]),
    }


def live_holding(holding: IbkrHolding, single: IbkrPnlSingle | None) -> IbkrLiveHolding:
    """A holding as the watch holds it (`fields.ts`' `liveHolding`): the account update's row, with
    its value, unrealised P&L and mark the stream's where the stream has a figure for each, and the
    stream's daily P&L. The mark is the stream's value over the position (the stream's, or the row's
    where it sent none) times the multiplier (none is 1); a figure the stream left unset leaves the
    row's."""
    if single is None:
        return cast(IbkrLiveHolding, {**holding, "daily_pnl": None})
    position = single["position"] if single["position"] is not None else holding["position"]
    multiplier = holding["multiplier"] if holding["multiplier"] is not None and holding["multiplier"] > 0 else 1
    size = 0 if position is None else position * multiplier
    value = single["value"]
    return cast(
        IbkrLiveHolding,
        {
            **holding,
            "market_price": value / size if value is not None and size != 0 else holding["market_price"],
            "market_value": value if value is not None else holding["market_value"],
            "unrealized_pnl": single["unrealized_pnl"]
            if single["unrealized_pnl"] is not None
            else holding["unrealized_pnl"],
            "daily_pnl": single["daily_pnl"],
        },
    )


# --- the naming: a service code as the contract IB Gateway wants (`contract.ts`) ---------------

#: Which exchange calculates each index, measured against the gateway on 2026-11-08. SMART routing,
#: which works for options, answers "no security definition" for an index, and guessing cost four
#: failed lookups before `INDU@CME` resolved — so anything unlisted is refused HERE rather than sent
#: to be guessed at: a wrong exchange and an unknown symbol come back as the same error, and the
#: first is ours to prevent. `DJX` and `INDU` are both the Dow, and neither serves a figure without
#: a subscription; they are listed because resolving is what this table is for.
INDEX_EXCHANGE: dict[str, str] = {
    "SPX": "CBOE",
    "VIX": "CBOE",
    "VIX9D": "CBOE",
    "VIX3M": "CBOE",
    "VIX6M": "CBOE",
    "VVIX": "CBOE",
    "SKEW": "CBOE",
    "SPOTVOL": "CBOE",
    "LTV": "CBOE",
    "OEX": "CBOE",
    "PUT": "CBOE",
    "BXM": "CBOE",
    "DJX": "CBOE",
    "NDX": "NASDAQ",
    "COMP": "NASDAQ",
    "INDU": "CME",
}

#: the market prefix the service puts on moomoo's codes; IBKR names no market in a symbol
_MARKET = re.compile(r"^US\.+")


class TwsContract(NamedTuple):
    """One contract, named the way IB Gateway names them. `sec_type` is `OPT` or `IND` and nothing
    else: an ETF needs an entitlement this account does not have (SPY answered `10089`)."""

    symbol: str
    sec_type: str
    last_trade_date_or_contract_month: str
    strike: float
    #: empty for an index, which has no side
    right: str
    #: empty for an index, which has no trading class
    trading_class: str
    exchange: str
    currency: str
    multiplier: str


class Named(NamedTuple):
    contract: TwsContract
    #: what the gateway will call it back
    symbol: str


def contract_for(code: str) -> Named | None:
    """The contract for a code, or None where this client cannot name one.

    The code is the discriminator: `parse_spx_code` reads an option and cannot read an index, so
    nothing stored beside the code has to say which it is. None is "I cannot ask about this", which
    the caller reports as unknown — the answer a vendor gives for a symbol it does not carry, and a
    different one from a request that was made and answered with nothing.
    """
    option = parse_spx_code(code)
    if option is not None:
        y, m, d = option.strike_date.split("-")
        return Named(
            symbol="SPX",
            contract=TwsContract(
                symbol="SPX",
                sec_type="OPT",
                last_trade_date_or_contract_month=f"{y}{m}{d}",
                strike=option.strike,
                right="C" if option.option_type == "CALL" else "P",
                # SPXW is the weekly class every code this service builds names; a monthly SPX
                # option would need its own class rather than a guess
                trading_class="SPXW",
                exchange="SMART",
                currency="USD",
                multiplier="100",
            ),
        )
    symbol = _MARKET.sub("", code)
    exchange = INDEX_EXCHANGE.get(symbol)
    if exchange is None:
        return None
    # an index has no expiry, no strike and no side; the gateway wants the fields present and empty
    return Named(
        symbol=symbol,
        contract=TwsContract(
            symbol=symbol,
            sec_type="IND",
            last_trade_date_or_contract_month="",
            strike=0.0,
            right="",
            trading_class="",
            exchange=exchange,
            currency="USD",
            multiplier="",
        ),
    )


# --- what a field means (`messages.ts`' reading, for the two figure messages) ------------------

#: Which value means "not computed" in the greeks message. NUMBERS, not empty fields, which is what
#: makes them dangerous: -2 is a perfectly good double and would print as a delta. Implied
#: volatility cannot be negative, so ANY negative is absent (`_not_computed`).
SENTINEL: dict[str, float] = {
    "delta": -2,
    "gamma": -2,
    "vega": -2,
    "theta": -2,
    "optPrice": -1,
    "undPrice": -1,
    "pvDividend": -1,
}


def _not_computed(what: str, value: float) -> bool:
    if what == "impliedVol":
        return value < 0
    sentinel = SENTINEL.get(what)
    return sentinel is not None and value == sentinel


def _reading(fields: list[str], at: int) -> float | None:
    """A FIGURE, or None where the field carries none. Not `float` alone: an empty field is the
    gateway declining to answer that one, kept so nothing after it shifts, and read as a number it
    becomes a figure nobody sent — a snapshot of SPX sends its close with an empty price."""
    if at >= len(fields) or not fields[at].strip():
        return None
    try:
        value = float(fields[at])
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _price(fields: list[str], at: int) -> float | None:
    """A price, or None where the gateway means it has none. -1 is its "no value" on a price tick,
    and a deliberate divergence from the official client, which passes it through for combos where
    a negative price is a credit: an option or an index cannot cost minus one. Zero is kept — an
    empty book quotes 0, and whether 0 may be SHOWN is ADR 0018's positivity guard to decide."""
    value = _reading(fields, at)
    return None if value is None or value == -1 else value


def _figure(fields: list[str], at: int, what: str) -> float | None:
    value = _reading(fields, at)
    return None if value is None or _not_computed(what, value) else value


def _ident(fields: list[str], at: int) -> int | None:
    """An id or a tick type: a field that names something rather than measures it. JavaScript's
    `Number` reads an empty one as 0, which reaches nobody (no request is sent with id 0, and tick 0
    is a size); anything that is not a whole number reaches nobody either."""
    if at >= len(fields):
        return None
    text = fields[at].strip()
    if not text:
        return 0
    try:
        value = float(text)
    except ValueError:
        return None
    return int(value) if value.is_integer() else None


# --- what the gateway said, routed by the id that asked for it ---------------------------------


@dataclass(frozen=True, slots=True)
class _Contract:
    req_id: int
    con_id: int


@dataclass(frozen=True, slots=True)
class _ContractEnd:
    req_id: int


@dataclass(frozen=True, slots=True)
class _Price:
    req_id: int | None
    tick_type: int | None
    price: float | None


@dataclass(frozen=True, slots=True)
class _GreeksTick:
    req_id: int | None
    tick_type: int | None
    figures: Greeks


@dataclass(frozen=True, slots=True)
class _SnapshotEnd:
    req_id: int


@dataclass(frozen=True, slots=True)
class _DataType:
    req_id: int
    type_: int


@dataclass(frozen=True, slots=True)
class _Error:
    req_id: int
    code: int
    message: str


@dataclass(frozen=True, slots=True)
class _Pnl:
    """Message 94, PNL: the account's P&L stream (ADR 0031), its figures as sent."""

    req_id: int | None
    row: PnlRow


@dataclass(frozen=True, slots=True)
class _PnlSingle:
    """Message 95, PNL_SINGLE: one holding's, as sent."""

    req_id: int | None
    row: PnlSingleRow


type _Incoming = _Contract | _ContractEnd | _Price | _GreeksTick | _SnapshotEnd | _DataType | _Error | _Pnl | _PnlSingle


# --- the account's messages (ADR 0030; `messages.ts`), which carry the account and no request id --


@dataclass(frozen=True, slots=True)
class _AccountValue:
    account: str
    row: AccountValueRow


@dataclass(frozen=True, slots=True)
class _Portfolio:
    account: str
    #: the row's identity: a later row for it replaces the earlier one
    con_id: str
    row: PortfolioRow


@dataclass(frozen=True, slots=True)
class _AccountTime:
    time: str


@dataclass(frozen=True, slots=True)
class _AccountEnd:
    account: str


@dataclass(frozen=True, slots=True)
class _ConnectionClosed:
    """The attached connection went underneath the client: an account read on it hears nothing
    more (`socket.ts`' `onClose`)."""

    client: Any


type _AccountMessage = _AccountValue | _Portfolio | _AccountTime | _AccountEnd


def _text(fields: list[str], at: int) -> str:
    """A field as the text it came as, empty where the message ended before it (`messages.ts`)."""
    return fields[at] if at < len(fields) else ""


def _read_account_value(fields: list[str]) -> _AccountValue:
    """Message 6, ACCT_VALUE: `id, version, key, value, currency, account`."""
    return _AccountValue(
        account=_text(fields, 5),
        row={"key": _text(fields, 2), "value": _text(fields, 3), "currency": _text(fields, 4)},
    )


def _read_portfolio(fields: list[str]) -> _Portfolio:
    """Message 7, PORTFOLIO_VALUE, version 8: `id, version, conId, symbol, secType, expiry, strike,
    right, multiplier, primaryExchange, currency, localSymbol, tradingClass, position, marketPrice,
    marketValue, averageCost, unrealizedPNL, realizedPNL, account` — every field kept as text, what
    each MEANS being `holding_from`'s, as it is `fields.ts`' `holdingFrom`'s."""
    return _Portfolio(
        account=_text(fields, 19),
        con_id=_text(fields, 2),
        row={
            "sec_type": _text(fields, 4),
            "symbol": _text(fields, 3),
            "expiry": _text(fields, 5),
            "strike": _text(fields, 6),
            "right": _text(fields, 7),
            "multiplier": _text(fields, 8),
            "currency": _text(fields, 10),
            "position": _text(fields, 13),
            "market_price": _text(fields, 14),
            "market_value": _text(fields, 15),
            "average_cost": _text(fields, 16),
            "unrealized_pnl": _text(fields, 17),
            "realized_pnl": _text(fields, 18),
        },
    )


def _read_pnl(fields: list[str]) -> _Pnl:
    """Message 94, PNL, with no version field: `id, reqId, dailyPnL, unrealizedPnL, realizedPnL`
    (`messages.ts`). Read here rather than by `ib_async`, whose reader turns an empty figure into 0."""
    return _Pnl(
        req_id=_ident(fields, 1),
        row={"daily_pnl": _text(fields, 2), "unrealized_pnl": _text(fields, 3), "realized_pnl": _text(fields, 4)},
    )


def _read_pnl_single(fields: list[str]) -> _PnlSingle:
    """Message 95, PNL_SINGLE, with no version field: `id, reqId, pos, dailyPnL, unrealizedPnL,
    realizedPnL, value`."""
    return _PnlSingle(
        req_id=_ident(fields, 1),
        row={
            "position": _text(fields, 2),
            "daily_pnl": _text(fields, 3),
            "unrealized_pnl": _text(fields, 4),
            "realized_pnl": _text(fields, 5),
            "value": _text(fields, 6),
        },
    )


def _read_price(fields: list[str]) -> _Price:
    """Message 1, tickPrice: `id, version, reqId, tickType, price, size, attrib`."""
    return _Price(req_id=_ident(fields, 2), tick_type=_ident(fields, 3), price=_price(fields, 4))


def _read_greeks(fields: list[str]) -> _GreeksTick:
    """Message 21, tickOptionComputation, with no version field at the protocols both clients
    speak: `id, reqId, tickType, tickAttrib, impliedVol, delta, optPrice, pvDividend, gamma, vega,
    theta, undPrice`."""
    return _GreeksTick(
        req_id=_ident(fields, 1),
        tick_type=_ident(fields, 2),
        figures=Greeks(
            implied_vol=_figure(fields, 4, "impliedVol"),
            delta=_figure(fields, 5, "delta"),
            gamma=_figure(fields, 8, "gamma"),
            vega=_figure(fields, 9, "vega"),
            theta=_figure(fields, 10, "theta"),
        ),
    )


class _Reader:
    """What `ib_async`'s `Client` and decoder call back: the EWrapper half of the client.

    Only the messages `client.ts` reads become anything; every other callback — farm notices'
    neighbours, tick sizes, strings, request parameters, anything the gateway volunteers — is
    accepted and dropped, as `messages.ts` turns them into `other`, because a reader that treated
    the unexpected as fatal would fall over on a message meant for nobody.

    During the handshake it also watches for the two ways a session is refused, so the connect
    fails with the gateway's words at once rather than at the timeout.
    """

    def __init__(
        self, route: Callable[[_Incoming | _AccountMessage | _ConnectionClosed], None], failed: "asyncio.Future[str]"
    ) -> None:
        self._route = route
        #: MANAGED_ACCTS' one field as the session sent it, with the handshake: the login's accounts
        self.accounts = ""
        self._failed: asyncio.Future[str] | None = failed
        self.client: Client | None = None
        #: nextValidId has arrived: the session STARTED, which is where the TypeScript stops
        #: treating an error against -1 as a refusal
        self._started = False
        self._attached = True

    def detach(self) -> None:
        """Nothing this reader hears from now on reaches the client: its connection is gone."""
        self._attached = False
        self._failed = None

    def handshake_done(self) -> None:
        self._failed = None

    def _fail(self, why: str) -> None:
        if self._failed is not None and not self._failed.done():
            self._failed.set_result(why)

    def _deliver(self, message: _Incoming | _AccountMessage | _ConnectionClosed) -> None:
        if self._attached:
            self._route(message)

    # the handshake
    def nextValidId(self, reqId: int) -> None:
        self._started = True

    def setEventsDone(self) -> None:
        """`ib_async` calls this whenever its socket goes, before it resets. Once the session has
        started, a connection that goes while still attached — not one the client hung up, which
        detaches it first — is told to the client, for an account read running on it."""
        if self._failed is None and self.client is not None:
            self._deliver(_ConnectionClosed(self.client))
        version = self.client.serverVersion() if self.client is not None else 0
        floor = self.client.MinClientVersion if self.client is not None else 0
        if 0 < version < floor:
            self._fail(f"IB Gateway speaks protocol {version}; this client needs {floor} or newer (ib_async's floor)")
        self._fail(
            "IB Gateway closed the connection during the handshake — logging out closes the API "
            "socket, so this is what a logged-out gateway looks like"
        )

    # the messages a quote fetch reads
    def error(self, reqId: int, errorCode: int, errorString: str, advancedOrderRejectJson: str = "") -> None:
        # an error against -1 before the session starts is the gateway refusing it — most often a
        # client id already in use, which otherwise looks exactly like "no gateway there"
        if reqId == -1 and self._failed is not None and not self._started:
            self._fail(f"IB Gateway refused the session: {errorCode} {errorString}")
            return
        self._deliver(_Error(reqId, errorCode, errorString))

    def contractDetails(self, reqId: int, contractDetails: Any) -> None:
        self._deliver(_Contract(reqId, contractDetails.contract.conId))

    def contractDetailsEnd(self, reqId: int) -> None:
        self._deliver(_ContractEnd(reqId))

    def marketDataType(self, reqId: int, marketDataId: int) -> None:
        self._deliver(_DataType(reqId, marketDataId))

    def tickSnapshotEnd(self, reqId: int) -> None:
        self._deliver(_SnapshotEnd(reqId))

    def figures(self, message: _Price | _GreeksTick | _Pnl | _PnlSingle) -> None:
        """Ticks 1 and 21, and the P&L streams' 94 and 95 (ADR 0031), read field by field by
        `_FigureDecoder`."""
        self._deliver(message)

    # the account read's (ADR 0030)
    def managedAccounts(self, accountsList: str) -> None:
        self.accounts = accountsList

    def account(self, message: _AccountMessage) -> None:
        """Messages 6, 7, 8 and 54, read field by field by `_FigureDecoder`."""
        self._deliver(message)

    def __getattr__(self, name: str) -> Callable[..., None]:
        if name.startswith("_"):
            raise AttributeError(name)
        return _ignore


def _ignore(*_args: object) -> None:
    return None


_MISSING = "optionality.ibkr needs ib_async to connect: uv add 'optionality[ibkr]'"


@functools.cache
def _transport() -> tuple[Any, Any, Any]:
    """`ib_async`'s `Client`, a decoder that reads the figure messages this module's way, and its
    `Contract` — imported here, not at the top, so the mapping and the naming import with no extra
    and only CONNECTING needs one, as `opend` reaches its SDK."""
    try:
        from ib_async.client import Client
        from ib_async.contract import Contract
        from ib_async.decoder import Decoder
    except ModuleNotFoundError as err:
        raise ImportError(_MISSING) from err

    class _FigureDecoder(Decoder):  # type: ignore[misc]
        """`ib_async`'s decoder, but ticks 1 and 21 are read field by field (see the docstring), and
        so are the P&L streams' two (ADR 0031) and the account's four messages: its PORTFOLIO_VALUE reader converts every figure with
        `float()`, so one empty field drops the whole row with a logged traceback where the
        TypeScript reads it as no figure, and the other three are read here too so that every
        account message reaches the client one way."""

        def __init__(self, wrapper: Any, server_version: int) -> None:
            super().__init__(wrapper, server_version)
            self.handlers[6] = lambda fields: self.wrapper.account(_read_account_value(fields))
            self.handlers[7] = lambda fields: self.wrapper.account(_read_portfolio(fields))
            self.handlers[8] = lambda fields: self.wrapper.account(_AccountTime(_text(fields, 2)))
            self.handlers[54] = lambda fields: self.wrapper.account(_AccountEnd(_text(fields, 2)))
            # the P&L streams (ADR 0031): `ib_async`'s readers turn an empty figure into 0
            self.handlers[94] = lambda fields: self.wrapper.figures(_read_pnl(fields))
            self.handlers[95] = lambda fields: self.wrapper.figures(_read_pnl_single(fields))

        def priceSizeTick(self, fields: list[str]) -> None:
            self.wrapper.figures(_read_price(fields))

        def tickOptionComputation(self, fields: list[str]) -> None:
            self.wrapper.figures(_read_greeks(fields))

    return Client, _FigureDecoder, Contract


# --- the client (`client.ts`) -------------------------------------------------------------------

DEFAULT_HOST = "127.0.0.1"
#: How the market data a request gets is graded, and which grade this asks for: DELAYED_FROZEN,
#: not FROZEN — for an instrument the account is not subscribed to, FROZEN delivers NOTHING
#: (measured twice on 2026-11-08), and asking for delayed does not give up live data where it is
#: entitled: the gateway falls back rather than downgrades, and says which grade it served.
MARKET_DATA_DELAYED_FROZEN = 4
#: bounds the handshake: a port that accepts is not a gateway that answers
CONNECT_TIMEOUT_MS = 10_000
#: bounds each request: a logged-in gateway can accept one and never answer, the 2026-10-16 shape
REQUEST_TIMEOUT_MS = 8_000
#: how long to wait after the figures a contract is waited for, in case more are coming;
#: restarted by every NEW figure, and not by a stream repeating one it already sent
QUIET_MS = 250


class IbkrAccountWatch(Protocol):
    """The account held while asked (ADR 0031; `client.ts`' `IbkrAccountWatch`): the subscriptions
    `IbkrClient.watch_account` started, and the latest picture they make."""

    def picture(self) -> IbkrLiveAccount:
        """The latest picture, a copy the caller may keep."""
        ...

    @property
    def lost(self) -> ConnectionError | None:
        """Set, once, when the connection closes under the watch; the picture stays the last one."""
        ...

    def on_lost(self, listener: Callable[[ConnectionError], None]) -> None:
        """Called once, at once, when the connection closes under the watch — or now, if it has."""
        ...

    async def stop(self) -> None:
        """The cancels, then the unsubscribe; idempotent; returns when sent."""
        ...


class _Found(NamedTuple):
    con_id: int | None
    silent: bool


@dataclass(slots=True)
class _AccountRead:
    """The account read running now: whose, over which connection, and how to feed or fail it."""

    client: "Client"
    account: str
    answer: "asyncio.Future[IbkrAccount]"
    read: Callable[[_AccountMessage], None]
    fail: Callable[[BaseException], None]


@dataclass(slots=True)
class _Stream:
    """One followed holding's P&L stream: its request id and its last reading."""

    req_id: int
    single: IbkrPnlSingle | None = None


class _AccountWatch:
    """The watch's whole life (ADR 0031; `client.ts`' `startWatch`). Its messages reach it two ways:
    the account's, which carry no request id, by the account they name (`IbkrClient._route`), and the
    P&L streams' by their request ids (`_waiting`)."""

    def __init__(self, owner: "IbkrClient", client: "Client", account: str) -> None:
        self._owner = owner
        self.client = client
        self.account = account
        loop = asyncio.get_running_loop()
        #: the start: this watch on the first complete picture, or why not
        self.ready: asyncio.Future[_AccountWatch] = loop.create_future()
        # retrieved, so a start every caller gave up on does not warn that nobody heard its failure
        self.ready.add_done_callback(lambda done: done.cancelled() or done.exception())
        self._values: dict[tuple[str, str], AccountValueRow] = {}
        #: by conId, in the order each first came
        self._holdings: dict[str, IbkrHolding] = {}
        #: each followed holding's stream, by conId
        self._streams: dict[str, _Stream] = {}
        self._updated_at: str | None = None
        self._pnl: IbkrPnl | None = None
        self._pnl_at: float | None = None
        self._started = False
        #: stopped, failed or lost: nothing more is heard
        self._ended = False
        self._lost: ConnectionError | None = None
        self._listeners: list[Callable[[ConnectionError], None]] = []
        self._pnl_id = owner._id()
        self._timer: asyncio.TimerHandle | None = None

    def begin(self) -> None:
        loop = asyncio.get_running_loop()
        self._timer = loop.call_later(self._owner.request_timeout_ms / 1000, self._late)
        self._owner._waiting[self._pnl_id] = (self.client, self._read_pnl)
        try:
            _send(self.client, lambda: self.client.reqAccountUpdates(True, self.account))
            _send(self.client, lambda: self.client.reqPnL(self._pnl_id, self.account, ""))
        except Exception as err:  # noqa: BLE001 — the start's own failure, told to its caller
            self._fail(err, cancel=False)

    # --- the handle (`IbkrAccountWatch`) ---

    def picture(self) -> IbkrLiveAccount:
        answer = account_answer(self.account, list(self._values.values()), [], self._updated_at)
        holdings = [
            live_holding(h, stream.single if (stream := self._streams.get(con_id)) is not None else None)
            for con_id, h in self._holdings.items()
        ]
        return cast(
            IbkrLiveAccount,
            {
                **answer,
                "holdings": holdings,
                "pnl": None if self._pnl is None else dict(self._pnl),
                "pnl_at": self._pnl_at,
            },
        )

    @property
    def lost(self) -> ConnectionError | None:
        return self._lost

    def on_lost(self, listener: Callable[[ConnectionError], None]) -> None:
        if self._lost is not None:
            listener(self._lost)
        elif not self._ended:
            self._listeners.append(listener)

    async def stop(self) -> None:
        if self._ended:
            return
        singles = [stream.req_id for stream in self._streams.values()]
        self._end()
        if not self.client.isReady():
            return
        for req_id in singles:
            self.client.cancelPnLSingle(req_id)
        self.client.cancelPnL(self._pnl_id)
        self.client.reqAccountUpdates(False, self.account)

    # --- what the client calls ---

    def answer(self) -> IbkrAccount:
        """The picture as the account read answers it, for a bounded read of the watched account."""
        picture: dict[str, Any] = dict(self.picture())
        del picture["pnl"], picture["pnl_at"]
        picture["holdings"] = [{k: v for k, v in h.items() if k != "daily_pnl"} for h in picture["holdings"]]
        return cast(IbkrAccount, picture)

    def read(self, message: _AccountMessage) -> None:
        if self._ended:
            return
        match message:
            case _AccountTime(time=time_of_day):
                self._updated_at = time_of_day
            case _AccountValue(account=whose, row=row) if whose == self.account:
                self._values[(row["key"], row["currency"])] = row
            case _Portfolio(account=whose, con_id=con_id, row=row) if whose == self.account:
                holding = holding_from(row)
                if holding["position"] == 0:
                    # closed: out of the picture, and its stream stopped
                    self._holdings.pop(con_id, None)
                    self._unfollow(con_id)
                else:
                    self._holdings[con_id] = holding
                    if self._started:
                        self._follow(con_id)
            case _AccountEnd(account=whose) if whose == self.account and not self._started:
                self._started = True
                if self._timer is not None:
                    self._timer.cancel()
                for con_id in list(self._holdings):
                    self._follow(con_id)
                self.ready.set_result(self)

    def closed(self) -> None:
        """The connection went: before the first picture the start fails, after it the watch is lost."""
        if self._ended:
            return
        if not self._started:
            self._fail(ConnectionError("IB Gateway's connection closed during the account read"), cancel=False)
            return
        self._end()
        lost = self._lost = ConnectionError("IB Gateway's connection closed under the account watch")
        listeners, self._listeners = self._listeners, []
        for listener in listeners:
            try:
                listener(lost)
            except Exception:  # noqa: BLE001 — a listener's fault is its own, and the rest are told
                _log.exception("an account watch's on_lost listener raised")

    # --- its own ---

    def _read_pnl(self, message: _Incoming) -> None:
        if isinstance(message, _Pnl) and not self._ended:
            self._pnl = pnl_from(message.row)
            self._pnl_at = self._owner.now()

    def _follow(self, con_id: str) -> None:
        if con_id in self._streams:
            return
        stream = _Stream(self._owner._id())
        self._streams[con_id] = stream

        def read(message: _Incoming) -> None:
            if isinstance(message, _PnlSingle) and not self._ended:
                stream.single = pnl_single_from(message.row)

        self._owner._waiting[stream.req_id] = (self.client, read)
        self.client.reqPnLSingle(stream.req_id, self.account, "", con_id)

    def _unfollow(self, con_id: str) -> None:
        stream = self._streams.pop(con_id, None)
        if stream is None:
            return
        self._owner._waiting.pop(stream.req_id, None)
        self.client.cancelPnLSingle(stream.req_id)

    def _end(self) -> None:
        """Forgets every route to the watch; what is sent on the way out is the caller's."""
        self._ended = True
        if self._timer is not None:
            self._timer.cancel()
        if self._owner._watching is self:
            self._owner._watching = None
        self._owner._waiting.pop(self._pnl_id, None)
        for stream in self._streams.values():
            self._owner._waiting.pop(stream.req_id, None)

    def _fail(self, error: BaseException, *, cancel: bool) -> None:
        self._end()
        if cancel and self.client.isReady():
            self.client.cancelPnL(self._pnl_id)
            self.client.reqAccountUpdates(False, self.account)
        if not self.ready.done():
            self.ready.set_exception(error)

    def _late(self) -> None:
        if self._ended or self._started:
            return
        self._fail(
            ConnectionError(
                f"IB Gateway did not finish sending the account within {self._owner.request_timeout_ms}ms — its link "
                "to IBKR may be down while its own socket is still open"
            ),
            cancel=True,
        )


class IbkrClient:
    """One bounded ask of IB Gateway, and the connection it is asked over (ADR 0019).

    The shape of `client.ts`, deliberately: hold the connection, bound every wait, tear it down on
    any failure so the next ask reconnects.

    **When an ask is finished** (#257): at the snapshot's end, where the gateway sends one; or
    once every figure the contract's kind is waited for has arrived — a figure at all
    (`has_figures`, which keeps "subscribed, nothing yet" apart from a contract that does not
    exist), and for an option its model greeks too, computed or not — and a brief quiet has
    followed, `quiet_ms`, restarted by every NEW figure and not by a stream repeating one it
    already sent; or at `request_timeout_ms`, keeping whatever arrived. The snapshot's end comes
    eleven to twelve seconds in, after the default timeout, so live it is the timeout that ends an
    option whose model greeks never come. Every contract is asked side by side, so a batch costs
    its slowest contract (`ib_async` paces the wire at 45 messages a second, as `socket.ts` now
    does), and an index is asked as a STREAM and cancelled once read, because a snapshot of one
    carries no figure at any hour (the account has no snapshot permission for an index).
    `client.ts` says why each, and what was measured.

    **Silence is a failure, not an answer.** A gateway whose link to IBKR has dropped keeps its own
    socket open and answers nothing. Reporting those contracts as unknown would read as "none of
    these exist" and quarantine every rule that watches one, and an empty batch is no better: as
    the Provider it is every watched figure missing. So silence from EVERY contract raises, judged
    where it was met — at the market data once any contract got that far, whatever the conid cache
    holds, and at the lookups only where none did — and silence from some leaves the rest standing.
    """

    def __init__(
        self,
        host: str = DEFAULT_HOST,
        *,
        port: int,
        client_id: int,
        connect_timeout_ms: int = CONNECT_TIMEOUT_MS,
        request_timeout_ms: int = REQUEST_TIMEOUT_MS,
        quiet_ms: int = QUIET_MS,
        now: Callable[[], float] | None = None,
    ) -> None:
        # IB Gateway permits ONE connection per client id, and a second user of the same number
        # displaces the first in silence; the service's is its own port, 31415
        self.host, self.port, self.client_id = host, port, client_id
        self.connect_timeout_ms = connect_timeout_ms
        self.request_timeout_ms = request_timeout_ms
        self.quiet_ms = quiet_ms
        #: the clock an account watch stamps reqPnL's figures with (`pnl_at`), in ms since the epoch:
        #: read once for each P&L message the watch reads, and nowhere else (`client.ts`' `now`); a
        #: replay pins it, so the corpus carries no wall time
        self.now: Callable[[], float] = now if now is not None else _epoch_ms
        self._client: Client | None = None
        #: the connect in flight, shared by every caller who arrives while it runs (`client.ts`'s
        #: `connecting`): IB Gateway allows one connection per client id, and the sweep, the
        #: dashboard's poll and a creation probe can all find the client cold at once
        self._connecting: asyncio.Task[Client] | None = None
        #: callers waiting on `_connecting`, so the last one to give up cancels it
        self._connect_waiters = 0
        #: bumped by `close`, so a connect that completes after it hangs up rather than leaving a
        #: connection nobody holds
        self._generation = 0
        #: a conid, once resolved, for the life of the connection: a contract's identity does not
        #: change, and asking again is a call spent to be told the same thing
        self._conids: dict[str, int] = {}
        #: every message the gateway sends, routed by the id that asked for it — with the connection
        #: that asked, so tearing one down drops only its own listeners
        self._waiting: dict[int, tuple[Client, Callable[[_Incoming], None]]] = {}
        self._next_id = 1
        #: the account read in flight, which a second caller for the same account joins: IB allows
        #: a single account subscription per client at a time
        self._reading: _AccountRead | None = None
        #: the account watch held, if any (ADR 0031): it holds the one account subscription too
        self._watching: _AccountWatch | None = None

    @property
    def name(self) -> str:
        return "ibkr"

    async def reachable(self) -> bool:
        """Whether the gateway answered, for `/health`. Any failure is a no: a probe that raises
        because the gateway is down has reported the thing it was asked."""
        try:
            await self._connected()
        except Exception:  # noqa: BLE001 — see above
            return False
        return True

    def close(self) -> None:
        """Idempotent. Drops the conids with the connection, because a reconnect is where a stale
        assumption would otherwise survive. A connect still in flight finishes for nobody and
        hangs up (`_start`)."""
        self._generation += 1
        self._connecting = None
        self._conids.clear()
        if self._client is not None:
            self._drop(self._client)

    async def account(self, wanted: str | None = None) -> IbkrAccount:
        """The account's totals and holdings, read once (ADR 0030; `client.ts`' `account`):
        subscribe, collect until the gateway's download end, unsubscribe, answer — over the same
        connection and client id as the price reads.

        Which account: the login's one managed account; or, where it has several, the one `wanted`
        names. Refused with `IbkrAccountRefused`, every id MASKED, where several are managed and
        `wanted` is unset, or where `wanted` names none of them. A gateway that cannot be reached
        raises `IbkrUnreachable` (a ConnectionError) in the connect's own words; a plain ConnectionError
        is a read that failed once it began: a connection that closed under it, or a deadline
        (`request_timeout_ms`), in its own words, the unsubscribe sent on that path too. A second caller while a read of the same account
        runs JOINS it: IB allows a single account subscription per client at a time."""
        while True:
            # taken afresh on every turn, and the account chosen afresh from what THAT session
            # names: the read waited on below may have ended because its connection went
            try:
                client = await self._connected()
            except ConnectionError as err:
                raise IbkrUnreachable(str(err)) from err
            reader = client.wrapper
            listed = reader.accounts if isinstance(reader, _Reader) else ""
            choice = choose_account(managed_accounts(listed), wanted)
            if "refused" in choice:
                raise IbkrAccountRefused(choice["refused"])
            account = choice["account"]
            held = self._watching
            if held is not None:
                # a watch holds the one subscription: a subscribe and an unsubscribe of this read's
                # own would end it, so a read of the watched account is answered from the watch
                if held.account != account:
                    raise RuntimeError(
                        f"IB Gateway's one account subscription is held by a watch of {mask_account(held.account)}; "
                        "stop it first"
                    )
                await asyncio.wait({held.ready})
                if self._watching is held:
                    return held.answer()
                continue
            running = self._reading
            if running is None:
                running = self._read_account(client, account)
            elif running.client is not client or running.account != account:
                # another account's read holds the one subscription: it finishes first, whatever it
                # comes to
                await asyncio.wait({running.answer})
                continue
            # shielded, so one caller giving up does not cancel the read under the others; the read
            # is bounded by its own deadline
            return await asyncio.shield(running.answer)

    async def watch_account(self, wanted: str | None = None) -> IbkrAccountWatch:
        """The account HELD while asked (ADR 0031; `client.ts`' `watchAccount`): subscribe to its
        updates and to its P&L and keep both, and once the first download ends follow each holding's
        own P&L stream by its conId. Returns the handle on that first complete picture.

        The start is the account read's: the same account chosen, the same refusals
        (`IbkrAccountRefused`, every id masked; `IbkrUnreachable` in the connect's words), and the
        same deadline in the same words, the cancel and the unsubscribe sent on that path too; a
        connection that closes before the first picture fails it in the read's words. It waits for a
        bounded read that is running, since IB allows one account subscription per client at a time,
        and refuses while this client already holds a watch.

        While held: a holding a portfolio update names for the first time starts its stream, and one
        whose position goes to zero stops it and leaves the picture. If the connection closes — the
        gateway goes, a price read drops it, or the client is closed — the handle says so at once
        (`lost`, `on_lost`) and keeps its last picture; nothing re-subscribes: that is the caller's."""
        while True:
            try:
                client = await self._connected()
            except ConnectionError as err:
                raise IbkrUnreachable(str(err)) from err
            reader = client.wrapper
            listed = reader.accounts if isinstance(reader, _Reader) else ""
            choice = choose_account(managed_accounts(listed), wanted)
            if "refused" in choice:
                raise IbkrAccountRefused(choice["refused"])
            if self._reading is not None:
                # the one subscription is a bounded read's: it finishes first, whatever it comes to
                await asyncio.wait({self._reading.answer})
                continue
            if self._watching is not None:
                raise RuntimeError(
                    f"this client already holds a watch of {mask_account(self._watching.account)}; stop it first"
                )
            watch = _AccountWatch(self, client, choice["account"])
            self._watching = watch
            watch.begin()
            return await asyncio.shield(watch.ready)

    def _read_account(self, client: "Client", account: str) -> _AccountRead:
        """Subscribe, collect until the download's end, unsubscribe, answer — or fail at the
        deadline, unsubscribing all the same (`client.ts`' `readAccount`). The account messages
        carry no request id, so they reach this by the account they name; one naming another
        account is not this read's. A value or a holding sent twice is the later one, a holding kept
        where it first came. Nothing it reads leaves it but `account_answer`'s, whose id is masked."""
        loop = asyncio.get_running_loop()
        answer: asyncio.Future[IbkrAccount] = loop.create_future()
        # retrieved, so a read every caller gave up on does not warn that nobody heard its failure
        answer.add_done_callback(lambda done: done.cancelled() or done.exception())
        values: dict[tuple[str, str], AccountValueRow] = {}
        holdings: dict[str, IbkrHolding] = {}
        updated_at: str | None = None

        def settle(result: IbkrAccount | None, error: BaseException | None, unsubscribe: bool) -> None:
            if answer.done():
                return
            timer.cancel()
            if self._reading is entry:
                self._reading = None
            if unsubscribe and client.isReady():
                client.reqAccountUpdates(False, account)
            if error is not None:
                answer.set_exception(error)
            else:
                answer.set_result(cast(IbkrAccount, result))

        def read(message: _AccountMessage) -> None:
            nonlocal updated_at
            match message:
                case _AccountTime(time=time):
                    updated_at = time
                case _AccountValue(account=whose, row=row) if whose == account:
                    values[(row["key"], row["currency"])] = row
                case _Portfolio(account=whose, con_id=con_id, row=row) if whose == account:
                    holdings[con_id] = holding_from(row)
                case _AccountEnd(account=whose) if whose == account:
                    settle(
                        account_answer(account, list(values.values()), list(holdings.values()), updated_at), None, True
                    )

        def late() -> None:
            settle(
                None,
                ConnectionError(
                    f"IB Gateway did not finish sending the account within {self.request_timeout_ms}ms — its link "
                    "to IBKR may be down while its own socket is still open"
                ),
                True,
            )

        timer = loop.call_later(self.request_timeout_ms / 1000, late)
        entry = _AccountRead(client, account, answer, read, lambda error: settle(None, error, False))
        self._reading = entry
        try:
            _send(client, lambda: client.reqAccountUpdates(True, account))
        except Exception as err:  # noqa: BLE001 — the read's own failure, told to every caller
            settle(None, err, False)
        return entry

    def _drop(self, client: "Client") -> None:
        """Hang up ONE connection, and forget what was asked over it. The client's own connection
        is forgotten only if it is this one: an ask that failed on a connection since replaced must
        not close the replacement, nor drop the listeners of the asks running on it."""
        # an account read on this connection can hear nothing more, and is told so now rather than at
        # its deadline; there is no connection left to unsubscribe over
        if self._reading is not None and self._reading.client is client:
            self._reading.fail(ConnectionError("IB Gateway's connection closed during the account read"))
        # and a watch on it is lost, or its start fails, now
        if self._watching is not None and self._watching.client is client:
            self._watching.closed()
        _detach(client)
        for req_id in [k for k, (owner, _) in self._waiting.items() if owner is client]:
            del self._waiting[req_id]
        if self._client is client:
            self._client = None
            self._conids.clear()

    async def fetch_quotes(self, codes: list[str]) -> Batch:
        """The one bounded call: figures for these codes, and which of them could not be priced."""
        if not codes:
            return Batch(records=[], unknown=[])
        # a connect that fails has already hung up its own connection, and is nobody else's
        client = await self._connected()
        try:
            return await self._ask(client, codes)
        except BaseException:
            # torn down so the next call reconnects, as `opend` does: a socket that has quietly
            # died otherwise produces a silent stream of empty batches rather than a failure
            self._drop(client)
            raise

    async def _connected(self) -> "Client":
        """The held connection, or ONE connect shared by everyone who asks while it runs."""
        if self._client is not None and self._client.isReady():
            return self._client
        task = self._connecting
        if task is None:
            # the generation is read NOW, not when the task first runs: a close in between must count
            task = asyncio.ensure_future(self._start(self._generation))
            self._connecting = task

            def forget(done: "asyncio.Task[Client]") -> None:
                if self._connecting is done:
                    self._connecting = None
                if not done.cancelled():
                    done.exception()  # retrieved: every caller has been told, or none was waiting

            task.add_done_callback(forget)
        self._connect_waiters += 1
        try:
            # shielded, so one caller giving up does not cancel the connect under the others
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # the last caller to give up takes the connect with it: a connect left running for
            # nobody would hold the client id
            if self._connect_waiters == 1 and not task.done():
                task.cancel()
                # forgotten NOW, not when the task finishes cancelling a tick later: a caller who
                # arrives in between must start a connect of its own, not inherit this cancel
                if self._connecting is task:
                    self._connecting = None
            raise
        finally:
            self._connect_waiters -= 1

    async def _start(self, generation: int) -> "Client":
        if self._client is not None:
            self._drop(self._client)  # gone underneath us; its reader must not route stale messages
        client = await self._open()
        if generation != self._generation:
            _detach(client)
            raise ConnectionError("IB Gateway client was closed while it was connecting")
        self._client = client
        client.reqMarketDataType(MARKET_DATA_DELAYED_FROZEN)
        return client

    async def _open(self) -> "Client":
        """Open, greet and start the session, inside one bound, failing with the gateway's own
        words where it gives any: a refusal, a close, or nothing at all."""
        client_class, decoder_class, _ = _transport()
        loop = asyncio.get_running_loop()
        failed: asyncio.Future[str] = loop.create_future()
        reader = _Reader(self._route, failed)
        client = client_class(reader)
        client.decoder = decoder_class(reader, 0)
        reader.client = client
        # `timeout=None`: the bound is this method's, over the TCP connect and the handshake
        # together, as the TypeScript's `connectTimeoutMs` is
        connecting = asyncio.ensure_future(client.connectAsync(self.host, self.port, self.client_id, None))
        why: str | None = None
        try:
            async with asyncio.timeout(self.connect_timeout_ms / 1000):
                await asyncio.wait({connecting, failed}, return_when=asyncio.FIRST_COMPLETED)
        except TimeoutError:
            why = (
                f"IB Gateway at {self.host}:{self.port} did not complete the handshake "
                f"within {self.connect_timeout_ms}ms"
            )
        except BaseException:
            # the caller gave up (cancelled): a connect left running would complete for nobody and
            # hold the client id, which the gateway lets a second connection take in silence
            connecting.cancel()
            _detach(client)
            raise
        if why is None and failed.done():
            why = failed.result()
        if why is None and connecting.done() and connecting.exception() is not None:
            err = connecting.exception()
            why = f"could not reach IB Gateway at {self.host}:{self.port}: {err}"
        if why is not None:
            connecting.cancel()
            await asyncio.wait({connecting})
            _detach(client)
            raise ConnectionError(why)
        reader.handshake_done()
        return client

    def _route(self, message: _Incoming | _AccountMessage | _ConnectionClosed) -> None:
        if isinstance(message, _ConnectionClosed):
            # only the account read: the price asks judge a silence themselves, as they always have
            if self._reading is not None and self._reading.client is message.client:
                self._reading.fail(ConnectionError("IB Gateway's connection closed during the account read"))
            if self._watching is not None and self._watching.client is message.client:
                self._watching.closed()
            return
        if isinstance(message, _AccountValue | _Portfolio | _AccountTime | _AccountEnd):
            # only the attached connection's reader delivers anything (`_Reader.detach`)
            if self._reading is not None:
                self._reading.read(message)
            elif self._watching is not None:
                self._watching.read(message)
            return
        if message.req_id is None:
            return
        entry = self._waiting.get(message.req_id)
        if entry is not None:
            entry[1](message)

    def _id(self) -> int:
        req_id, self._next_id = self._next_id, self._next_id + 1
        return req_id

    async def _ask(self, client: "Client", codes: list[str]) -> Batch:

        # a code this client cannot name is unknown without a call: the gateway would answer the
        # same thing, and spending a request to hear it is a request bought for nothing
        named: dict[str, Named] = {}
        unknown: list[str] = []
        for code in codes:
            shape = contract_for(code)
            if shape is not None:
                named[code] = shape
            else:
                unknown.append(code)
        if not named:
            return Batch(records=[], unknown=unknown)

        # side by side: a batch costs its slowest contract rather than the sum of them (#257)
        asks = [asyncio.ensure_future(self._one(client, code, shape)) for code, shape in named.items()]
        try:
            outcomes = await asyncio.gather(*asks)
        except BaseException:
            # one failed (the socket went): the rest are abandoned with it, as `fetch_quotes` is
            for ask in asks:
                ask.cancel()
            raise

        records: list[Quote] = []
        # Who answered, counted in THIS ask. A conid from the cache is not an answer: it is what
        # the gateway said on an earlier ask, before its link had any chance to drop.
        asked = 0  # contracts whose market data was asked for
        answered = 0  # of those, the ones that sent anything back
        refused = 0  # lookups answered "no such contract"
        for code, found, data in outcomes:
            if found.silent:
                continue  # counted below, not reported as unknown
            if data is None:  # the lookup said "no such contract"
                refused += 1
                unknown.append(code)
                continue
            asked += 1
            record, silent = data
            if silent:
                continue
            answered += 1
            records.append(record)

        # Silence is judged where it was met: once any contract got as far as market data, the
        # market data is what must answer, and a lookup answering — or a "no such contract" beside
        # it — says only that the contract database does. Where nothing got that far, the lookups
        # are what must answer, and "no such contract" is an answer.
        if answered == 0 if asked > 0 else refused == 0:
            what = f"{asked} market-data request(s)" if asked > 0 else f"{len(named)} request(s)"
            raise ConnectionError(
                f"IB Gateway accepted {what} and answered none of them — its link to IBKR may be down "
                "while its own socket is still open"
            )
        return Batch(records=records, unknown=unknown)

    async def _one(self, client: "Client", code: str, shape: Named) -> tuple[str, _Found, tuple[Quote, bool] | None]:
        """One contract's lookup and, where it found one, its figures."""
        found = await self._conid(client, code, shape)
        data = None if found.silent or found.con_id is None else await self._figures(client, code, shape)
        return code, found, data

    async def _conid(self, client: "Client", code: str, shape: Named) -> _Found:
        """A conid, "the gateway does not carry this" (None), or SILENCE — nothing came back at all,
        which is the gateway's link being down rather than a fact about the contract. A cached
        conid is not silent, and is no evidence the gateway answers NOW."""
        cached = self._conids.get(code)
        if cached is not None:
            return _Found(cached, silent=False)
        req_id = self._id()
        heard = False

        def read(message: _Incoming, done: Callable[[int | None], None], _settle: Callable[[int], None]) -> None:
            nonlocal heard
            heard = True
            match message:
                case _Contract(con_id=con_id):
                    done(con_id)
                # the end marker arrives whether or not anything was found, which is how "no such
                # contract" is told from "still coming"
                case _ContractEnd() | _Error():
                    done(None)

        contract = _ib_contract(shape.contract)
        answer = await self._collect(client, req_id, lambda: client.reqContractDetails(req_id, contract), read)
        if answer is not None:
            self._conids[code] = answer
        return _Found(answer, silent=not heard)

    async def _figures(self, client: "Client", code: str, shape: Named) -> tuple[Quote, bool]:
        """One contract's figures, under the service's names, and whether it was silent: an
        option's as a snapshot, an index's as a stream, and either finished as the class says."""
        req_id = self._id()
        record: Quote = {"code": code}
        option = shape.contract.sec_type == "OPT"
        heard = False
        modelled = False  # the model's greeks arrived, computed or not

        def complete() -> bool:
            return has_figures(record) and (not option or modelled)

        def read(message: _Incoming, done: Callable[[Quote | None], None], settle: Callable[[Quote], None]) -> None:
            nonlocal heard, modelled
            heard = True
            if isinstance(message, _SnapshotEnd):
                done(record)  # the gateway says nothing more is coming
                return
            held, was_complete = len(record), complete()
            match message:
                case _DataType(type_=type_):
                    # the grade the gateway SERVED, which contradicted the one asked for on
                    # 2026-11-08 — read, so the record carries a fact rather than a hope
                    grades = grade(type_)
                    if grades is not None:
                        record.update(grades._asdict())
                case _Price(tick_type=tick_type, price=price) if price is not None and tick_type is not None:
                    field = PRICE_TICKS.get(tick_type)
                    if field is not None:
                        record[field] = price
                case _GreeksTick(tick_type=tick_type, figures=figures) if tick_type in GREEK_TICKS:
                    modelled = True
                    record.update(greek_fields(figures))
            # complete, or a new figure since it was: start the quiet again. A figure already held
            # is a stream repeating itself, and restarting on that would hold a busy stream open
            # until the timeout
            if complete() and (not was_complete or len(record) > held):
                settle(record)

        contract = _ib_contract(shape.contract)
        await self._collect(client, req_id, lambda: client.reqMktData(req_id, contract, "", option, False, []), read)
        _send(client, lambda: client.cancelMktData(req_id))
        return with_mid(record), not heard

    async def _collect[T](
        self,
        client: "Client",
        req_id: int,
        send: Callable[[], None],
        read: Callable[[_Incoming, Callable[[T | None], None], Callable[[T], None]], None],
    ) -> T | None:
        """Send, and listen on that id until the reader says it is done or the clock says it is over.

        None on a timeout rather than a raise is the containment: one contract that never answers
        leaves the others' figures standing. A gateway that is wholly unreachable raises earlier,
        from `_open`.
        """
        loop = asyncio.get_running_loop()
        answer: asyncio.Future[T | None] = loop.create_future()
        quiet: asyncio.TimerHandle | None = None

        def finish(value: T | None) -> None:
            if answer.done():
                return
            timer.cancel()
            if quiet is not None:
                quiet.cancel()
            self._waiting.pop(req_id, None)
            answer.set_result(value)

        def settle(value: T) -> None:
            # enough has arrived; wait a moment in case more is on its way, and restart that wait
            # whenever the reader says something new has
            nonlocal quiet
            if quiet is not None:
                quiet.cancel()
            quiet = loop.call_later(self.quiet_ms / 1000, finish, value)

        timer = loop.call_later(self.request_timeout_ms / 1000, finish, None)
        self._waiting[req_id] = (client, lambda message: read(message, finish, settle))
        try:
            _send(client, send)
        except BaseException:
            timer.cancel()
            self._waiting.pop(req_id, None)
            raise
        return await answer


def _epoch_ms() -> float:
    """Now, in whole ms since the epoch, as JavaScript's `Date.now()`."""
    return time.time_ns() // 1_000_000


def _send(client: "Client", send: Callable[[], None]) -> None:
    if not client.isReady():
        raise ConnectionError("not connected to IB Gateway")
    send()


def _detach(client: "Client") -> None:
    reader = client.wrapper
    if isinstance(reader, _Reader):
        reader.detach()
    client.disconnect()


def _ib_contract(c: TwsContract) -> Any:
    """`ib_async`'s Contract, which it writes field for field in the order `messages.ts` does:
    conId 0 ("I am describing it rather than naming it"), the strike as Python writes a float —
    "8100.0", which is what the reference client sent and the gateway was shown to accept."""
    _, _, contract_class = _transport()
    return contract_class(
        symbol=c.symbol,
        secType=c.sec_type,
        lastTradeDateOrContractMonth=c.last_trade_date_or_contract_month,
        strike=float(c.strike),
        right=c.right,
        multiplier=c.multiplier,
        exchange=c.exchange,
        currency=c.currency,
        tradingClass=c.trading_class,
    )


def quotes(codes: list[str], *, port: int, client_id: int, host: str = DEFAULT_HOST) -> Batch:
    """One-shot, from a script: connect, ask, close. A notebook already runs an event loop, where
    `asyncio.run` refuses; there, `await IbkrClient(...).fetch_quotes(codes)` instead."""

    async def once() -> Batch:
        client = IbkrClient(host, port=port, client_id=client_id)
        try:
            return await client.fetch_quotes(codes)
        finally:
            client.close()

    return asyncio.run(once())
