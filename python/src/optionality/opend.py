"""Live quotes from moomoo's OpenD, through the Python SDK. Needs the `opend` extra.

    with OpenD() as od:              # one connection for the whole block, closed even on error
        records, bad = od.quotes([code, ...])
        problem = od.verify([code])

    records, bad = quotes([code])    # one-shot: opens, asks, closes

The connection is ALWAYS closed on the way out. The TypeScript client learned that the hard way
(#128): every OpenD failure leaked a connection that reconnected for ever. This speaks the SDK's TCP
protocol (port 11111 by default); the service's own client speaks the websocket one.
"""

from collections.abc import Callable
from typing import Any, Self

from optionality.quote import Quote
from optionality.quotes import Batch, fetch_resilient, verify_contracts

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
    # the mid is derived, not reported, and only when BOTH sides are there
    bid, ask = record.get("bid_price"), record.get("ask_price")
    if isinstance(bid, (int, float)) and isinstance(ask, (int, float)):
        record["mid_price"] = (bid + ask) / 2
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
        """Every quote moomoo has, and the codes it refused as unknown."""
        return fetch_resilient(codes, self.fetch)

    def verify(self, codes: list[str]) -> str | None:
        """Why these contracts cannot be trusted to exist, or None."""
        return verify_contracts(codes, self.fetch)


def quotes(codes: list[str], host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> Batch:
    """One-shot: connect, ask, close."""
    with OpenD(host, port) as od:
        return od.quotes(codes)
