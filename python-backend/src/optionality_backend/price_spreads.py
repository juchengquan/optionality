"""Pricing any SPX structure an agent names, live, in one bounded call (#452, ADR 0027): the service behind
`GET /spreads/quote`, paired with `routes/spreads.py`. Port of backend/src/price-spreads.ts.

Three parts, in the order a request meets them:

  1. **The grammar** (`parse_spreads`): `<expiry>:<legs>[@<entry>]`, one per `spread=`, every refusal
     decided here, before anything leaves the machine.
  2. **The budget** (`SpreadPricer`): ONE Provider batch for every distinct leg of every structure,
     shared for `SHARED_FOR_MS` by any request that normalises to the same one, and at most
     `spread_quote_calls_per_30s` of them in any 30 seconds whoever asks — the HTTP door and the MCP door
     reach this one instance through the one app, so they share both. A batch in flight is joined; a
     cached one spends nothing.
  3. **The answer** (`price_structures`): each structure valued from that batch by the domain's own
     functions — `combo_field_sum` for the value and the greeks, `natural_price`, `strike_distances`,
     `payoff_at_expiry` — all reckoned at the instant the batch was fetched, so a cached answer is the
     same answer. Each leg says its last stored regular-session close beside it, never summed.

It never trades and never writes: the only call that leaves the machine is the market-data batch, the
bounded call CLAUDE.md's first invariant names for this route.

**Where the Python differs, and why.**

- **A strike and an Entry are read as JavaScript's `Number` reads them**, as floats: a strike past 2^53
  is then the same double, and the same code, in both.
- **A shared batch is an `asyncio.Task`**, started eagerly as a JavaScript promise starts, and awaited
  through `asyncio.shield`: awaiting a task directly cancels it when the awaiting request is cancelled,
  which would cancel it for everyone sharing it. Its failure is retrieved by a callback, as the
  TypeScript marks the promise handled, so a batch nobody comes back for logs nothing.
- **Times are counted in whole milliseconds since the epoch**, as `Date.getTime` counts them, so the
  wait a 429 states rounds as the TypeScript's does.
"""

import asyncio
import math
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, TypedDict

from optionality.contract import build_spx_code, normalize_strike_date
from optionality.expiry import (
    MarketPhase,
    close_sample,
    days_to_expiry,
    in_session,
    market_date,
    market_phase,
    valued_timing,
)
from optionality.monitor import COMBO_GREEK_FIELDS, Monitor, MonitorLeg, combo_field_sum
from optionality.payoff import payoff_at_expiry
from optionality.position import Leg
from optionality.quote import (
    Batch,
    ByCode,
    FillLeg,
    derived_spx,
    display_records,
    mid_price,
    natural_price,
    session_spx,
    strike_distances,
)
from optionality.timefmt import display_time

from .db.queries import priced_watch_samples_holding
from .db.time import display_stored
from .ports import QuoteFetcher
from .schemas.position import MAX_LEG_QTY
from .schemas.spread import MAX_PROBE_LEGS
from .watch_history import LAST_CLOSE_DAYS, LastClose, stored_leg_map

#: How long a batch is shared by the requests that normalise to it (#452: "5-second shared cache"), the
#: MCP door's `LIVE_FOR_MS` by another name, because here it is the route's.
SHARED_FOR_MS = 5000
#: The window `spread_quote_calls_per_30s` counts calls over.
CAP_WINDOW_MS = 30_000
#: The most legs one structure may have: `POST /spreads`' six (#334).
MAX_STRUCTURE_LEGS = 6


class PricedLeg(TypedDict):
    side: Literal["short", "long"]
    option_type: Literal["CALL", "PUT"]
    strike: float
    qty: int


@dataclass(frozen=True)
class Structure:
    """One structure as asked for: its expiry (YYYY-MM-DD), its legs in the order given, its Entry."""

    expiry: str
    legs: list[PricedLeg]
    entry: float | None


@dataclass(frozen=True)
class QuoteFault:
    status: Literal[422, 429]
    message: str


def _refuse(message: str, status: Literal[422, 429] = 422) -> QuoteFault:
    return QuoteFault(status=status, message=message)


_STRUCTURE = re.compile(r"([^:@]*):([^@]*)(?:@(-?\d+(?:\.\d+)?))?", re.ASCII)
#: A raw `+` in a query string arrives as a space, so a space where a sign goes reads as `+`. A strike is at
#: most six digits: SPX is near 7,000, so that is two orders of magnitude to spare, and every such number is an
#: exact double, so both languages build the same code. Unbounded, 400 digits raised OverflowError here (a 500)
#: and 22 built a code the TypeScript does not (#453 review).
_LEG = re.compile(r"([-+ ])([CP])([1-9]\d{0,5})(?:x(\d+))?", re.ASCII)
_EXAMPLE = "e.g. ?spread=20261218:-P6800,%2BP6750"


def parse_spreads(given: list[str], now: datetime) -> list[Structure] | QuoteFault:
    """The structures `given` asks for, or why not — every refusal before any Provider call (ADR 0027): no
    `spread`, a structure or a leg that is not the grammar, a quantity outside 1–10, an expiry before New
    York's market day (the sweep's own rule for an expired rule), more than `MAX_STRUCTURE_LEGS` in a
    structure, more than `MAX_PROBE_LEGS` in all."""
    if not given:
        return _refuse(f"give at least one spread: ?spread=<expiry>:<legs>, {_EXAMPLE}")
    today = market_date(now)
    out: list[Structure] = []
    for i, raw in enumerate(given):
        which = f"spread {i + 1}"
        whole = _STRUCTURE.fullmatch(raw)
        if whole is None:
            return _refuse(f'{which} "{raw}" is not <expiry>:<legs>[@<entry>], e.g. 20261218:-P6800,+P6750@1.25')
        date, leg_text, entry_text = whole.group(1), whole.group(2), whole.group(3)
        try:
            expiry = normalize_strike_date(date)
        except ValueError:
            return _refuse(f"{which}: invalid expiry '{date}': use YYYYMMDD or YYYY-MM-DD")
        legs: list[PricedLeg] = []
        for j, text in enumerate(leg_text.split(",")):
            m = _LEG.fullmatch(text)
            if m is None:
                return _refuse(f'{which}, leg {j + 1} "{text}" is not ±<C|P><strike>[x<qty>], e.g. -P6800 or +C7350x2')
            qty = 1 if m.group(4) is None else int(m.group(4))
            if qty < 1 or qty > MAX_LEG_QTY:
                return _refuse(f"{which}, leg {j + 1}: a quantity is 1 to {MAX_LEG_QTY}, not {m.group(4)}")
            legs.append(
                {
                    "side": "short" if m.group(1) == "-" else "long",
                    "option_type": "CALL" if m.group(2) == "C" else "PUT",
                    "strike": float(m.group(3)),
                    "qty": qty,
                }
            )
        if len(legs) > MAX_STRUCTURE_LEGS:
            return _refuse(f"{which} has {len(legs)} legs: at most {MAX_STRUCTURE_LEGS} in a spread")
        if expiry < today:
            return _refuse(f"{which}: {date} has expired")
        out.append(Structure(expiry=expiry, legs=legs, entry=None if entry_text is None else float(entry_text)))
    leg_count = sum(len(s.legs) for s in out)
    if leg_count > MAX_PROBE_LEGS:
        return _refuse(f"this request has {leg_count} legs: at most {MAX_PROBE_LEGS} in one request")
    return out


def _leg_code(expiry: str, leg: PricedLeg) -> str:
    return build_spx_code(expiry, leg["option_type"], leg["strike"])


def normalised(structures: list[Structure]) -> str:
    """The key a request is shared under: each structure's expiry, legs and entry in a fixed order, and the
    structures in a fixed order — so the same structures asked another way round are one key."""
    keys = []
    for s in structures:
        legs = ",".join(sorted(f"{lg['side']} {lg['option_type']} {lg['strike']} x{lg['qty']}" for lg in s.legs))
        keys.append(f"{s.expiry} {legs} @{'' if s.entry is None else s.entry}")
    return "|".join(sorted(keys))


def _figure(value: object) -> float | None:
    """A figure from the wire, or None for anything that is not a finite number (a bool is not one)."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    try:
        number = float(value)
    except OverflowError:
        # an int past a double's range, which JavaScript reads as Infinity: not a figure
        return None
    return number if math.isfinite(number) else None


def last_known_closes(db: sqlite3.Connection, codes: list[str], tz: str, now: datetime) -> dict[str, LastClose | None]:
    """Each contract's last stored REGULAR-SESSION close, from any watched set holding it (`watch_samples`,
    the one table that stores a contract's own mid), chosen as `last_closes` chooses a rule's: by
    `close_sample` over the latest `LAST_CLOSE_DAYS` priced days, today's left out while the session runs,
    since it is the session so far. None where no such row has one."""
    today = market_date(now) if in_session(now) else None
    out: dict[str, LastClose | None] = {}
    for code in codes:
        days = [
            {**s, "cost_to_close": (stored_leg_map(s["legs_mid"]) or {}).get(code)}
            for s in priced_watch_samples_holding(db, code, LAST_CLOSE_DAYS)
            if s["observed_on"] != today
        ]
        close = close_sample(days)  # type: ignore[type-var]
        if close is None or close["cost_to_close"] is None:
            out[code] = None
            continue
        timing = valued_timing(close["observed_at"])
        out[code] = {
            "price": close["cost_to_close"],
            "observed_on": close["observed_on"],
            "observed_at": None if timing == "unrecorded" else display_stored(close["observed_at"], tz),
            "timing": timing,
        }
    return out


def price_structures(
    structures: list[Structure], batch: Batch, at: datetime, display_tz: str, last_known: dict[str, LastClose | None]
) -> dict[str, Any]:
    """The structures valued from one batch fetched at `at`, in the order asked (ADR 0027)."""
    by_code = display_records(batch.records, display_tz, at)
    # every leg's mid by the one rule, from its own two sides, whatever the vendor sent beside them
    with_mids: ByCode = {
        code: {**r, "mid_price": mid_price(r.get("bid_price"), r.get("ask_price"))} for code, r in by_code.items()
    }
    unknown = set(batch.unknown)
    # once for the batch: every structure was priced by it, as every row of /quotes is
    spx = session_spx(at, derived_spx(batch.records))

    spreads: list[dict[str, Any]] = []
    for s in structures:
        codes = [_leg_code(s.expiry, lg) for lg in s.legs]
        dte = days_to_expiry(s.expiry, at)
        legs = []
        for lg, code in zip(s.legs, codes, strict=True):
            record = by_code.get(code)
            mid = with_mids[code]["mid_price"] if code in with_mids else None
            error = (
                "unknown contract"
                if code in unknown
                else "no quote returned"
                if record is None
                else "no two-sided quote"
                if mid is None
                else None
            )
            r = record or {}
            legs.append(
                {
                    **lg,
                    "code": code,
                    "bid_price": _figure(r.get("bid_price")),
                    "ask_price": _figure(r.get("ask_price")),
                    "mid_price": mid,
                    "option_implied_volatility": _figure(r.get("option_implied_volatility")),
                    "option_delta": _figure(r.get("option_delta")),
                    "option_gamma": _figure(r.get("option_gamma")),
                    "option_theta": _figure(r.get("option_theta")),
                    "option_vega": _figure(r.get("option_vega")),
                    "option_contract_size": _figure(r.get("option_contract_size")),
                    "fetched_at": None if record is None else record.get("fetched_at"),
                    "error": error,
                    "last_known": last_known.get(code),
                }
            )
        signed = [
            MonitorLeg(
                sign=-1 if lg["side"] == "short" else 1,
                option_type=lg["option_type"],
                strike=lg["strike"],
                qty=lg["qty"],
            )
            for lg in s.legs
        ]
        combo = Monitor(
            code="",
            strike_date=s.expiry,
            option_type="CMB",
            strike=0,
            field="mid_price",
            threshold=0,
            direction="above",
            compare="abs",
            legs=tuple(signed),
        )
        short_codes = [c for c, lg in zip(codes, s.legs, strict=True) if lg["side"] == "short"]
        short_strikes = [d.model_dump() for d in strike_distances(short_codes, with_mids, spx.price, dte)]
        missing = list(dict.fromkeys(c for c in codes if c in unknown))
        common: dict[str, Any] = {
            "expiry": s.expiry,
            "dte": dte,
            "entry": s.entry,
            "legs": legs,
            "spx": spx.price,
            "spx_reason": spx.reason,
            "short_strikes": short_strikes,
        }
        if missing:
            spreads.append(
                {
                    **common,
                    "value": None,
                    "natural": None,
                    "greeks": {f: None for f in COMBO_GREEK_FIELDS},
                    "payoff": None,
                    "payoff_basis": None,
                    "error": f"unknown contract: {', '.join(missing)}",
                }
            )
            continue
        value = combo_field_sum(combo, with_mids, "mid_price")
        as_legs = [
            Leg(side=lg["side"], option_type=lg["option_type"], strike=lg["strike"], qty=lg["qty"]) for lg in s.legs
        ]
        if s.entry is not None:
            payoff, basis = payoff_at_expiry(as_legs, s.entry, 1).model_dump(), "entry"
        elif value is not None:
            # opening at the mid: a long's mid is paid, so the Entry it would be is the value's negative
            payoff, basis = payoff_at_expiry(as_legs, -value, 1).model_dump(), "mid"
        else:
            # no price paid, so no P&L: the legs' own value at expiry, and nothing said of breaking even
            shape = payoff_at_expiry(as_legs, 0, 1).model_dump()
            payoff, basis = {**shape, "breakevens": None, "max_profit": None, "max_loss": None}, "shape"
        natural = natural_price(
            [FillLeg(code=c, sign=leg.sign, qty=leg.qty) for c, leg in zip(codes, signed, strict=True)], with_mids
        )
        spreads.append(
            {
                **common,
                "value": value,
                "natural": None if natural is None else natural.model_dump(),
                "greeks": {f: combo_field_sum(combo, with_mids, f) for f in COMBO_GREEK_FIELDS},
                "payoff": payoff,
                "payoff_basis": basis,
                "error": None,
            }
        )
    phase: MarketPhase = market_phase(at)
    return {"phase": phase, "fetched_at": display_time(at, display_tz), "spreads": spreads}


@dataclass(frozen=True)
class PricerDeps:
    db: sqlite3.Connection
    fetch_quotes: QuoteFetcher
    now: Any
    display_tz: str
    #: `SPREAD_QUOTE_CALLS_PER_30S`
    calls_per_30s: int


@dataclass(frozen=True)
class _Reading:
    """A batch asked for at `at`: shared until it is `SHARED_FOR_MS` old, failed or not."""

    at: datetime
    batch: "asyncio.Task[Batch]"


@dataclass(frozen=True)
class Priced:
    """What a request comes to: an answer, a refusal, or the Provider's failure for the route to word."""

    answer: dict[str, Any] | None = None
    refused: QuoteFault | None = None
    failed: Exception | None = None


_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def _ms(when: datetime) -> int:
    """`Date.getTime`: whole milliseconds since the epoch."""
    return (when - _EPOCH) // timedelta(milliseconds=1)


def _ceil_div(a: int, b: int) -> int:
    return -(-a // b)


@dataclass
class SpreadPricer:
    """The budget and the cache, one per app: every caller of `GET /spreads/quote` shares them."""

    deps: PricerDeps
    #: batches by normalised request, each until it is `SHARED_FOR_MS` old
    _shared: dict[str, _Reading] = field(default_factory=dict)
    #: when each Provider call was made, the oldest first, for as long as it counts
    _calls: list[int] = field(default_factory=list)

    async def price(self, given: list[str]) -> Priced:
        now: datetime = self.deps.now()
        structures = parse_spreads(given, now)
        if isinstance(structures, QuoteFault):
            return Priced(refused=structures)
        key = normalised(structures)
        t = _ms(now)
        # forget what can no longer be shared or counted; a clock that went BACK trusts nothing old
        for k, r in list(self._shared.items()):
            age = t - _ms(r.at)
            if age < 0 or age >= SHARED_FOR_MS:
                del self._shared[k]
        while self._calls and t - self._calls[0] >= CAP_WINDOW_MS:
            self._calls.pop(0)

        reading = self._shared.get(key)
        if reading is None:
            cap = self.deps.calls_per_30s
            if len(self._calls) >= cap:
                wait = max(1, _ceil_div(min(self._calls) + CAP_WINDOW_MS - t, 1000))
                return Priced(
                    refused=_refuse(
                        f"spread quotes are capped at {cap} Provider calls in 30 seconds: the next is allowed in {wait}s",
                        429,
                    )
                )
            codes = sorted({_leg_code(s.expiry, lg) for s in structures for lg in s.legs})
            self._calls.append(t)
            task = asyncio.Task(self.deps.fetch_quotes(codes), loop=asyncio.get_running_loop(), eager_start=True)
            # a failure is shared like an answer, so a Provider that is down is asked once per window;
            # retrieved here, since a caller may never come back for it
            task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
            reading = _Reading(at=now, batch=task)
            self._shared[key] = reading
        try:
            batch = await asyncio.shield(reading.batch)
        except Exception as err:  # noqa: BLE001 — the TypeScript's bare catch: the route words it as the 502
            return Priced(failed=err)
        codes = list(dict.fromkeys(_leg_code(s.expiry, lg) for s in structures for lg in s.legs))
        last_known = last_known_closes(self.deps.db, codes, self.deps.display_tz, reading.at)
        return Priced(answer=price_structures(structures, batch, reading.at, self.deps.display_tz, last_known))
