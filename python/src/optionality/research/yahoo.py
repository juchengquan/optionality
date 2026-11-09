"""Option chains and historical bars from Yahoo Finance, through yfinance. Needs the `research` extra.

    for expiry in expirations("^SPX"):        # the dates Yahoo lists, soonest first
        chain = option_chain("^SPX", expiry)  # both sides, as rows
    bars = daily_bars("^SPX", period="1mo")   # OHLCV, one row per market day

Nothing holds any of this to a second implementation — see `research/__init__.py`. The service
fetches no chain and no bar, so there is no TypeScript to mirror and no golden case to compare.

yfinance is imported INSIDE the function that needs it, the way `optionality.opend` reaches the
moomoo SDK: it pulls in pandas and numpy, and a notebook that only wants the maths should not pay
for them. So this module IMPORTS without the extra and only asking it a question fails, with the
words to install.

The returned rows are dataclasses rather than DataFrames on purpose. A DataFrame crossing this seam
would make every caller a pandas caller, and the one figure that matters — a bid Yahoo has not got —
arrives as NaN, which propagates through arithmetic in silence and prints as "nan" in a table.
Absent is None here.
"""

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

#: what yfinance names each column. Spelled out rather than read positionally: Yahoo adds columns,
#: and `_options2df` reindexes to a fixed list that a yfinance release may extend
_CODE, _STRIKE = "contractSymbol", "strike"
_BID, _ASK, _LAST = "bid", "ask", "lastPrice"
_VOLUME, _OPEN_INTEREST, _IV = "volume", "openInterest", "impliedVolatility"

_MISSING = "optionality.research.yahoo needs yfinance: uv add 'optionality[research]'"


@dataclass(frozen=True, slots=True)
class ChainRow:
    """One contract on one side of one expiry, as Yahoo reports it."""

    code: str
    """Yahoo's own contract symbol (`SPXW261218C08100000`), NOT a moomoo code: no market prefix and
    its own strike padding. Nothing in this package translates between the two."""
    side: str  # "call" | "put" — the frame it came out of, not a column Yahoo sends
    strike: float
    bid: float | None
    ask: float | None
    last: float | None
    volume: int | None
    open_interest: int | None
    implied_vol: float | None


@dataclass(frozen=True, slots=True)
class Chain:
    symbol: str
    expiry: str
    calls: list[ChainRow]
    puts: list[ChainRow]


@dataclass(frozen=True, slots=True)
class Bar:
    date: str  # the market date of the row, from the frame's own index
    open: float
    high: float
    low: float
    close: float
    volume: int | None


def _yfinance_ticker(symbol: str) -> Any:
    try:
        # imported here, not at the top: it carries pandas and numpy and is only wanted when asked for
        import yfinance
    except ModuleNotFoundError as err:
        raise ImportError(_MISSING) from err
    return yfinance.Ticker(symbol)


#: replaced in tests. Unlike `opend._sdk_connect` there is no None standing for "not installed":
#: the failed import above is the only way the extra can be absent, and a second spelling of the
#: same state would be a branch nothing could tell from it — a mutation sweep found exactly that,
#: surviving because both paths raise the same ImportError.
_ticker: Callable[[str], Any] = _yfinance_ticker


def _open(symbol: str, ticker: Callable[[str], Any] | None) -> Any:
    return (ticker or _ticker)(symbol)


def _number(value: object) -> float | None:
    """A figure, or None where Yahoo has none. NaN is how a DataFrame spells absent, and it must not
    get past here: it propagates through arithmetic in silence and prints as "nan"."""
    if value is None:
        return None
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return None if math.isnan(number) else number


def _count(value: object) -> int | None:
    number = _number(value)
    return None if number is None else int(number)


def _rows(frame: Any, side: str) -> list[ChainRow]:
    if frame is None:
        return []
    return [
        ChainRow(
            code=str(row[_CODE]),
            side=side,
            strike=float(row[_STRIKE]),
            bid=_number(row.get(_BID)),
            ask=_number(row.get(_ASK)),
            last=_number(row.get(_LAST)),
            volume=_count(row.get(_VOLUME)),
            open_interest=_count(row.get(_OPEN_INTEREST)),
            implied_vol=_number(row.get(_IV)),
        )
        for row in frame.to_dict("records")
    ]


def expirations(symbol: str, ticker: Callable[[str], Any] | None = None) -> list[str]:
    """Every expiry Yahoo lists for `symbol`, as `YYYY-MM-DD`."""
    return list(_open(symbol, ticker).options)


def option_chain(symbol: str, expiry: str, ticker: Callable[[str], Any] | None = None) -> Chain:
    """Both sides of one expiry. `expiry` must be one `expirations` gave: yfinance refuses anything
    else with a ValueError naming the dates it has."""
    chain = _open(symbol, ticker).option_chain(expiry)
    if chain.calls is None and chain.puts is None:
        # yfinance answers an empty tuple rather than raising when Yahoo serves nothing — a symbol
        # with no options, a throttled request. An empty Chain would read as "no contracts exist"
        raise RuntimeError(f"no chain from Yahoo for {symbol} {expiry}")
    return Chain(symbol, expiry, _rows(chain.calls, "call"), _rows(chain.puts, "put"))


def daily_bars(
    symbol: str, period: str = "1mo", interval: str = "1d", ticker: Callable[[str], Any] | None = None
) -> list[Bar]:
    """OHLCV, one row per market day. `period` and `interval` are yfinance's own vocabulary
    (`1d,5d,1mo,3mo,6mo,1y,2y,5y,10y,ytd,max` and `1m,…,1h,1d,1wk,1mo`).

    `auto_adjust=False` rather than yfinance's default: an index and its options are quoted at the
    price that traded, and a back-adjusted close would not match the strike a position was opened
    against.
    """
    frame = _open(symbol, ticker).history(period=period, interval=interval, auto_adjust=False)
    rows = frame.to_dict("records")
    # strict: the date comes from the index and the figures from the rows, so a frame whose two
    # halves disagree would date every bar after the gap wrongly rather than fail. `zip(strict=False)`
    # dropping what it could not pair is the silence that let a parameter go missing from the golden
    # harness with every case still green.
    return [
        Bar(
            date=str(stamp)[:10],
            open=float(row["Open"]),
            high=float(row["High"]),
            low=float(row["Low"]),
            close=float(row["Close"]),
            volume=_count(row.get("Volume")),
        )
        for stamp, row in zip(list(frame.index), rows, strict=True)
    ]
