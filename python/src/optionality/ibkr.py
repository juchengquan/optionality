"""IB Gateway, from Python: the client, and the figures it maps. Needs the `ibkr` extra to CONNECT.

    client = IbkrClient(port=4002, client_id=9301)    # one connection, held across asks
    records, unknown = await client.fetch_quotes(["US.SPXW261218C8100000", "SPX"])
    client.close()

    records, unknown = quotes([...], port=4002, client_id=9301)   # one-shot, from a script

A PORT of `typescript/src/vendors/ibkr/`, in three parts, and each is held to the TypeScript:

* the MAPPING (`fields.ts`) — tick ids to the service's names, the four data grades as the two
  facts they are, the 100x on implied volatility. `tests/test_ibkr.py` holds it to
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
reqContractDetails, reqMktData, cancelMktData. `tests/test_ibkr_gateway.py` holds it to that.

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
import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, NamedTuple

from optionality.contract import parse_spx_code
from optionality.quote import Batch, Quote

if TYPE_CHECKING:
    from ib_async.client import Client

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


type _Incoming = _Contract | _ContractEnd | _Price | _GreeksTick | _SnapshotEnd | _DataType | _Error


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

    def __init__(self, route: Callable[[_Incoming], None], failed: "asyncio.Future[str]") -> None:
        self._route = route
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

    def _deliver(self, message: _Incoming) -> None:
        if self._attached:
            self._route(message)

    # the handshake
    def nextValidId(self, reqId: int) -> None:
        self._started = True

    def setEventsDone(self) -> None:
        """`ib_async` calls this whenever its socket goes, before it resets."""
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

    def figures(self, message: _Price | _GreeksTick) -> None:
        """Ticks 1 and 21, read field by field by `_FigureDecoder`."""
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
        """`ib_async`'s decoder, but ticks 1 and 21 are read field by field (see the docstring)."""

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


class _Found(NamedTuple):
    con_id: int | None
    silent: bool


class IbkrClient:
    """One bounded ask of IB Gateway, and the connection it is asked over (ADR 0019).

    The shape of `client.ts`, deliberately: hold the connection, bound every wait, tear it down on
    any failure so the next ask reconnects.

    **When an ask is finished** (#257): at the snapshot's end, where the gateway sends one; or
    once every figure the contract's kind is waited for has arrived — a figure at all
    (`has_figures`, which keeps "subscribed, nothing yet" apart from a contract that does not
    exist), and for an option its model greeks too, computed or not — and a brief quiet has
    followed, `quiet_ms`, restarted by every NEW figure and not by a stream repeating one it
    already sent; or at `request_timeout_ms`, keeping whatever arrived. Every contract is asked side
    by side, so a batch costs its slowest contract, and an index is asked as a STREAM and cancelled
    once read, because a snapshot of one carries no figure at any hour (the account has no
    snapshot permission for an index). `client.ts` says why each, and what was measured.

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
    ) -> None:
        # IB Gateway permits ONE connection per client id, and a second user of the same number
        # displaces the first in silence; the service's is its own port, 31415
        self.host, self.port, self.client_id = host, port, client_id
        self.connect_timeout_ms = connect_timeout_ms
        self.request_timeout_ms = request_timeout_ms
        self.quiet_ms = quiet_ms
        self._client: Client | None = None
        #: a conid, once resolved, for the life of the connection: a contract's identity does not
        #: change, and asking again is a call spent to be told the same thing
        self._conids: dict[str, int] = {}
        #: every message the gateway sends, routed by the id that asked for it
        self._waiting: dict[int, Callable[[_Incoming], None]] = {}
        self._next_id = 1

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
        assumption would otherwise survive."""
        client, self._client = self._client, None
        if client is not None:
            _detach(client)
        self._conids.clear()
        self._waiting.clear()

    async def fetch_quotes(self, codes: list[str]) -> Batch:
        """The one bounded call: figures for these codes, and which of them could not be priced."""
        if not codes:
            return Batch(records=[], unknown=[])
        try:
            return await self._ask(codes)
        except BaseException:
            # torn down so the next call reconnects, as `opend` does: a socket that has quietly
            # died otherwise produces a silent stream of empty batches rather than a failure
            self.close()
            raise

    async def _connected(self) -> "Client":
        if self._client is not None and self._client.isReady():
            return self._client
        if self._client is not None:
            _detach(self._client)  # gone underneath us; its reader must not route stale messages
            self._client = None
        client = await self._open()
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

    def _route(self, message: _Incoming) -> None:
        if message.req_id is None:
            return
        listener = self._waiting.get(message.req_id)
        if listener is not None:
            listener(message)

    def _id(self) -> int:
        req_id, self._next_id = self._next_id, self._next_id + 1
        return req_id

    async def _ask(self, codes: list[str]) -> Batch:
        client = await self._connected()

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
        self._waiting[req_id] = lambda message: read(message, finish, settle)
        try:
            _send(client, send)
        except BaseException:
            timer.cancel()
            self._waiting.pop(req_id, None)
            raise
        return await answer


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
