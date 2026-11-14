"""Live quotes from moomoo's OpenD, through the Python SDK. Needs the `opend` extra.

    with OpenD() as od:                   # one connection for the whole block, closed even on error
        records, unknown = od.quotes([code, ...])
        problem = od.verify([code])

    records, unknown = quotes([code])     # one-shot: opens, asks, closes

The connection is ALWAYS closed on the way out. The TypeScript client learned that the hard way
(#128): every OpenD failure leaked a connection that reconnected for ever. This speaks the SDK's TCP
protocol (port 11111 by default); the service's own client speaks the websocket one.
"""

import re
from collections.abc import Callable
from typing import Any, Self

from optionality.quote import Batch, Quote, mid_price
from optionality.quotes import verify_contracts

#: moomoo rejects the WHOLE batch when any code is unknown, naming the culprit in its error text —
#: without the market prefix. Reading that prose is moomoo's business and so it is done HERE, inside
#: the provider: the port carries the ANSWER, which codes could not be priced (ADR 0015, #168). It
#: lived above the port in `quotes.fetch_resilient` until ADR 0017 noticed the TypeScript had moved.
_UNKNOWN_CODE = re.compile(r"Unknown stock\.?\s+([A-Z0-9.]+)")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 11111
_MISSING = "optionality.opend needs the moomoo SDK: uv add 'optionality[opend]'"


def _moomoo_connect(host: str, port: int) -> Any:
    try:
        # imported here, not at the top: it is heavy and only wanted when asked for
        from moomoo import OpenQuoteContext
    except ModuleNotFoundError as err:
        raise ImportError(_MISSING) from err
    return OpenQuoteContext(host=host, port=port)


# replaced in tests; None stands for "the SDK is not installed"
_sdk_connect: Callable[[str, int], Any] | None = _moomoo_connect


def _with_mid(record: Quote) -> Quote:
    # the mid is derived, not reported, and only where there is a two-sided quote: both sides and an
    # offer above zero. Out of hours moomoo quotes every option 0/0, and a mid of 0 valued the book
    # at 0.00 (#380). The rule is the domain's, shared by every vendor in both languages.
    mid = mid_price(record.get("bid_price"), record.get("ask_price"))
    if mid is not None:
        record["mid_price"] = mid
    return record


class OpenD:
    def __init__(
        self,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        connect: Callable[[str, int], Any] | None = None,
    ) -> None:
        self.host, self.port = host, port
        self._connect = connect
        self._ctx: Any = None

    def __enter__(self) -> Self:
        connect = self._connect or _sdk_connect
        if connect is None:
            raise ImportError(_MISSING)
        self._ctx = connect(self.host, self.port)
        return self

    def __exit__(self, *exc: object) -> None:
        if self._ctx is not None:
            self._ctx.close()
            self._ctx = None

    def fetch(self, codes: list[str]) -> list[Quote]:
        """One batch, as moomoo answers it. Raises with moomoo's own words on a refusal, which is what
        `quotes` reads to drop an unknown contract."""
        ret, data = self._ctx.get_market_snapshot(list(codes))
        if ret != 0:
            raise RuntimeError(f"snapshot API failed: {data}")
        return [_with_mid(r) for r in data.to_dict("records")]

    def quotes(self, codes: list[str]) -> Batch:
        """Every quote moomoo has, and the codes it refused as unknown.

        Drops what moomoo names and asks again, so one bad contract cannot take the rest hostage.
        Any other failure — a dead gateway, a quota — is raised untouched: containment engages only
        on the deterministic named-culprit case, because retrying an outage one code at a time would
        present it as a watchlist full of unknown contracts.
        """
        remaining = list(codes)
        unknown: list[str] = []
        while remaining:
            try:
                return Batch(self.fetch(remaining), unknown)
            except Exception as err:
                match = _UNKNOWN_CODE.search(str(err))
                if not match:
                    raise
                culprit = match.group(1).rstrip(".")
                hits = [c for c in remaining if c == culprit or c.endswith(culprit)]
                if not hits:
                    raise  # cannot map the culprit to a code we asked for: a generic failure
                remaining = [c for c in remaining if c not in hits]
                unknown.extend(hits)
        return Batch([], unknown)

    def verify(self, codes: list[str]) -> str | None:
        """Why these contracts cannot be trusted to exist, or None."""
        return verify_contracts(codes, self.quotes)


def quotes(codes: list[str], host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> Batch:
    """One-shot: connect, ask, close."""
    with OpenD(host, port) as od:
        return od.quotes(codes)
