"""Yahoo as a vendor: the library's Yahoo port, asked from a worker thread.

backend/src/vendors/yahoo/vendor.ts has no test of its own. Its callers' tests rely on what
`vendors/index.test.ts` says of it — a Reference-only vendor that needs no configuration and so is
always among the sources — and the Reference path reads from it a batch with Yahoo's unknown symbols
in `unknown`. The mapping itself is the library's, held to the TypeScript by `testdata/vendors/`.

The rest is the Python's own: yfinance blocks, where `yahoo-finance2` does not, so the call runs off
the loop. yfinance is never reached — every test passes `fetch`, because a suite that reached Yahoo
would fail when a company it does not control changes something.
"""

import asyncio
import threading

import pytest
from optionality.quote import Batch

from optionality_backend.env import settings_for
from optionality_backend.ports import ProviderClient, VendorClient
from optionality_backend.vendors import ReferenceVendor
from optionality_backend.vendors.yahoo.vendor import YahooClient, yahoo_vendor


class TestTheDescriptor:
    def test_is_reference_only_and_needs_no_configuration(self):
        # it prices no option, so naming it as the Provider is fatal at boot (vendors/index.ts); and
        # there is no host, key or login, so it opens for any settings at all
        assert isinstance(yahoo_vendor, ReferenceVendor)
        assert yahoo_vendor.name == "yahoo"
        assert yahoo_vendor.configured_by is None
        client = yahoo_vendor.open(settings_for())
        assert isinstance(client, VendorClient)
        assert not isinstance(client, ProviderClient)
        assert client.name == "yahoo"
        client.close()


class TestAsking:
    async def test_answers_what_the_port_answers(self):
        asked: list[list[str]] = []

        def fetch(codes: list[str]) -> Batch:
            asked.append(codes)
            return Batch(records=[{"code": "^GSPC", "last_price": 7376.86}], unknown=["NOTATICKER"])

        batch = await YahooClient(fetch).fetch_quotes(["^GSPC", "NOTATICKER"])
        assert batch == Batch(records=[{"code": "^GSPC", "last_price": 7376.86}], unknown=["NOTATICKER"])
        # one bounded call for the whole list, as the invariant counts calls
        assert asked == [["^GSPC", "NOTATICKER"]]

    async def test_asks_nothing_for_nothing(self):
        asked: list[list[str]] = []
        assert await YahooClient(lambda codes: asked.append(codes) or Batch([], [])).fetch_quotes([]) == ([], [])
        assert asked == []

    async def test_raises_what_the_port_raises(self):
        def fetch(codes: list[str]) -> Batch:
            raise RuntimeError("Too Many Requests")

        # a refusal reaches the Reference path as a raise, which it shows as a dash with its reason
        with pytest.raises(RuntimeError, match="^Too Many Requests$"):
            await YahooClient(fetch).fetch_quotes(["^VIX"])


class TestWhatOnlyThePythonCanGetWrong:
    async def test_never_blocks_the_loop(self):
        # yfinance waits on the network; on the loop's thread that would stop the sweep and the bot
        threads: list[str] = []

        def fetch(codes: list[str]) -> Batch:
            threads.append(threading.current_thread().name)
            return Batch([], list(codes))

        await YahooClient(fetch).fetch_quotes(["^VIX"])
        assert threads and threads[0] != threading.main_thread().name

    async def test_a_slow_yahoo_does_not_hold_the_loop_while_it_answers(self):
        release = threading.Event()

        def fetch(codes: list[str]) -> Batch:
            release.wait(5)
            return Batch([], list(codes))

        client = YahooClient(fetch)
        pending = asyncio.ensure_future(client.fetch_quotes(["^VIX"]))
        try:
            # the loop is free to do something else while Yahoo is asked
            await asyncio.sleep(0.01)
            assert not pending.done()
        finally:
            release.set()
        assert (await pending).unknown == ["^VIX"]
        client.close()
