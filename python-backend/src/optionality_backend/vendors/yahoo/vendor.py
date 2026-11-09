"""Yahoo as a vendor (ADR 0019, track D). Port of backend/src/vendors/yahoo/vendor.ts.

Reference-only, and that is a statement about what it can price rather than about trust: it quotes
index levels and no option, so nothing the alarm engine evaluates could be read from it.
`ReferenceVendor` is therefore what keeps `OPTIONALITY_PROVIDER=yahoo` fatal at boot instead of
producing a watchlist of dashes, and it is why this client owes no `reachable` — that question is
only ever asked of the Provider.

It needs no configuration: no host, no key, no login. So it is always available and costs nothing
until a Reference names it — one bounded call per source IN USE. Deleting the row is the off switch;
a setting would be a second thing to remember.

**Where the Python differs, and why.** The library's port, `optionality.yahoo.quotes`, is built on
yfinance, which BLOCKS where `yahoo-finance2` does not — chosen library for library with the
TypeScript, because a bare fetch is refused with 429 (ADR 0019). So it runs on this vendor's one
worker thread (`vendors.Worker`), and that thread is what `close` hangs up: the TypeScript has a
cookie jar and no socket, and nothing at all to close. No deadline is added, because the TypeScript
sets none either; yfinance bounds each of its own requests. yfinance is imported by the library on
the first call that needs it, so a build with no Yahoo Reference never loads it.
"""

from collections.abc import Callable

from optionality import yahoo
from optionality.quote import Batch

from ...env import Settings
from .. import ReferenceVendor, Worker


class YahooClient:
    """Yahoo, opened. `fetch` is the library's synchronous port, and a test's fake."""

    name = "yahoo"

    def __init__(self, fetch: Callable[[list[str]], Batch] = yahoo.quotes) -> None:
        self._fetch = fetch
        self._worker = Worker("yahoo")

    async def fetch_quotes(self, codes: list[str]) -> Batch:
        """One bounded call: figures for these codes, and which of them Yahoo does not carry."""
        if not codes:
            return Batch(records=[], unknown=[])
        return await self._worker.submit(self._fetch, list(codes))

    def close(self) -> None:
        self._worker.close()


def _open(_settings: Settings) -> YahooClient:
    return YahooClient()


yahoo_vendor = ReferenceVendor(name="yahoo", open=_open)
