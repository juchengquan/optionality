"""Live figures from Yahoo, through yfinance. Needs the `yahoo` extra.

A PORT, not a reimplementation. It mirrors `backend/src/vendors/yahoo/fields.ts` and
`yahoo/client.ts`, and `tests/test_yahoo.py` holds it there against `testdata/vendors/`, which
records what the TypeScript computes for every one of those cases. A wrong answer turns `make test`
red — which is the whole difference between this half of the package and `research/`.

Library-for-library with the service, deliberately. `yahoo/client.ts` uses `yahoo-finance2` rather
than plain `fetch`, because a bare Node fetch is refused with `429 Too Many Requests` (measured
2026-11-08); this uses `yfinance` for the same reason. Both surface Yahoo's OWN field names, so the
mapping below is the same mapping and the corpus compares exactly.

    from optionality.yahoo import quotes
    records, unknown = quotes(["^GSPC", "^VIX"])

It answers `quotes.QuoteFetcher`, as `opend` does: the records it has AND the codes it does not
know, raising only when it could not answer at all. A raise is an outage, and an outage must never
read as a watchlist full of unknown contracts.

## What it does NOT carry, and why that is the point

No bid, no ask, and therefore no mid. Measured on 2026-11-08: `^GSPC` came back with
`regularMarketPrice: 7376.86` — correct, and equal to Cboe's own published close — beside
`bid: 7524.56` and `ask: 7624.67`. An index has no order book, so those are not a book; they are
some other figure under a familiar name, wrong by about 150 points with a 100-point spread.

Carrying them faithfully would be WORSE than ignoring them, because `reference.FIELDS` prefers the
mid: the strip would have shown 7,574 instead of 7,376, entirely plausibly. `^VIX` returned
`bid: 0, ask: 0`, which ADR 0018's positivity guard would have rejected anyway — `^GSPC`'s are
positive and wrong, which is the case no guard can catch.
"""

from collections.abc import Callable
from typing import Any

from optionality.quote import Batch, Quote

_MISSING = "optionality.yahoo needs yfinance: uv add 'optionality[yahoo]'"

#: the sessions in which an index is actually being calculated. Anything else — closed, pre- and
#: post-market — means the figure is the last one Yahoo holds.
UPDATING = frozenset({"REGULAR"})


def to_record(code: str, row: dict[str, Any]) -> Quote:
    """One row of Yahoo's answer, under the service's names.

    Pure, and cased: every branch below is a row in `testdata/vendors/yahoo-fields.json`, recorded
    from what the TypeScript computes. The `isinstance` checks are the port of `typeof x ===
    "number"` — an absent field and a field of the wrong type are both "Yahoo did not say", and a
    bool is not a number in this mapping even though Python says it is.
    """
    record: Quote = {"code": code}
    name = row.get("shortName")
    if isinstance(name, str):
        record["name"] = name
    price = row.get("regularMarketPrice")
    if _is_number(price):
        record["last_price"] = price
    close = row.get("regularMarketPreviousClose")
    if _is_number(close):
        record["prev_close_price"] = close

    # the two flags ADR 0019 settled, from what Yahoo said rather than from configuration
    minutes = row.get("exchangeDataDelayedBy")
    if _is_number(minutes):
        record["delayed"] = minutes > 0
        # only where the source STATES a duration. IBKR reports a tier and no number, so the strip
        # says "delayed" for one vendor and "15m late" for the other — each what its vendor said.
        if minutes > 0:
            record["delayed_by_minutes"] = minutes
    state = row.get("marketState")
    if isinstance(state, str):
        record["last_known"] = state not in UPDATING
    return record


def _is_number(value: object) -> bool:
    """`typeof value === "number"`, ported. A bool passes `isinstance(x, int)` in Python and would
    make `delayed_by_minutes: True` a duration, so it is excluded explicitly."""
    return isinstance(value, int | float) and not isinstance(value, bool)


def _yahoo_tickers(codes: list[str]) -> Any:
    try:
        # imported here, not at the top: it pulls pandas and numpy, and is only wanted when asked
        # for. `opend._moomoo_connect` defers its SDK the same way and for the same reason.
        from yfinance import Tickers
    except ModuleNotFoundError as err:
        raise ImportError(_MISSING) from err
    return Tickers(" ".join(codes))


#: replaced in tests, so the mapping above can be driven without a network
_fetch_rows: Callable[[list[str]], dict[str, dict[str, Any]]] | None = None


def quotes(codes: list[str]) -> Batch:
    """One bounded call for these codes: the records Yahoo had, and the codes it did not know.

    Bounded in the invariant's sense — ONE call for the whole list, not one per code (CLAUDE.md).
    A code Yahoo answers with no price at all is `unknown`: that is a symbol it does not carry,
    which is a different thing from a figure that has not arrived.
    """
    if not codes:
        return Batch(records=[], unknown=[])
    rows = (_fetch_rows or _rows_from_yahoo)(codes)
    records: list[Quote] = []
    unknown: list[str] = []
    for code in codes:
        row = rows.get(code)
        if row is None:
            unknown.append(code)
            continue
        record = to_record(code, row)
        # a row with no price is a symbol Yahoo does not carry. `hasFigures`'s distinction on the
        # IBKR side is between "subscribed, nothing yet" and "no such contract"; Yahoo answers in
        # one shot, so there is no "nothing yet" to tell apart.
        if "last_price" in record or "prev_close_price" in record:
            records.append(record)
        else:
            unknown.append(code)
    return Batch(records=records, unknown=unknown)


def _rows_from_yahoo(codes: list[str]) -> dict[str, dict[str, Any]]:
    tickers = _yahoo_tickers(codes)
    rows: dict[str, dict[str, Any]] = {}
    for code in codes:
        ticker = tickers.tickers.get(code)
        if ticker is None:
            continue                            # yfinance made no ticker for it: nothing to ask
        row = _info_or_none(ticker)
        if row is not None:
            rows[code] = row
    return rows


def _info_or_none(ticker: Any) -> dict[str, Any] | None:
    """Yahoo's row for one symbol, or None where it would not give one.

    Contained per SYMBOL, and not logged, because the information is not lost: a code with no row
    comes back in `unknown`, which is this contract's way of saying Yahoo does not carry it. The
    rule `opend.OpenD.quotes` follows is the same one — a failure must reach the caller as either a
    named unknown or an outage, never as silence — and it re-raises precisely what it cannot
    attribute. Here every failure IS attributable, because it is asked one symbol at a time.

    The catch is broad because it has to be: naming yfinance's own exception type would mean
    importing yfinance at module level, which is the thing this module defers.
    """
    try:
        return dict(ticker.info)
    except Exception:  # noqa: BLE001 — see above: broad by necessity, attributed by the caller
        return None
