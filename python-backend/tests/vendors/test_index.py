"""The vendor registry: which market-data vendors this build carries, and how one is reached.

Port of backend/src/vendors/index.test.ts. What is tested here is the SEAM rather than any vendor.
Three of them existed before the TypeScript's file and each was wired its own way — a Provider
factory, a `{ sources, close }` pair, a bare `Sources` with nothing to hang up — and `main.ts`
hand-merged the three shapes while `routes/references.ts` merged two of them again. A fourth vendor
meant touching both, and a vendor that later grew a `close` would have been hung up in one place and
leaked in the other.

So the rules below are about the registry keeping its own promises: every vendor opens at most once,
a vendor this build cannot reach opens nothing, the Provider is the SAME client when it also serves a
Reference, and closing closes all of them.

One test waits: "agrees with the source names the API accepts" reads `schemas/reference.ts`'s
`SOURCES`, and `schemas/` is still on the module map's backlog — it joins this file in the change
that ports it. What only the Python can get wrong is at the end.
"""

import logging
import threading

import pytest
from optionality.ibkr import IbkrClient
from optionality.quote import Batch

from optionality_backend.env import settings_for
from optionality_backend.ports import ProviderClient, VendorClient
from optionality_backend.vendors import (
    PROVIDERS,
    VENDORS,
    ProviderVendor,
    ReferenceVendor,
    make_provider,
    open_vendors,
)

LOG = "optionality_backend.vendors"


async def nothing(codes: list[str]) -> Batch:
    return Batch(records=[], unknown=[])


class Fake:
    """An opened vendor that may be the Provider, as the TypeScript's object literals are."""

    def __init__(self, name: str, *, closed: list[str] | None = None, refuses_to_close: bool = False) -> None:
        self.name = name
        self.fetch_quotes = nothing
        self._closed = closed
        self._refuses = refuses_to_close

    async def reachable(self) -> bool:
        return True

    def close(self) -> None:
        if self._refuses:
            raise RuntimeError(f"{self.name} refused to close")
        if self._closed is not None:
            self._closed.append(self.name)


class TestTheRegistry:
    def test_names_every_vendor_once(self):
        names = [v.name for v in VENDORS]
        assert names == list(dict.fromkeys(names))
        assert "moomoo" in names
        assert "ibkr" in names
        assert "yahoo" in names

    def test_derives_the_provider_names_from_the_vendors_that_can_be_one(self):
        # the list the error message quotes and /health's name comes from, not a second list that can
        # disagree with the descriptors
        assert list(PROVIDERS) == [v.name for v in VENDORS if v.can_be_provider]

    def test_says_yahoo_is_not_a_candidate_because_a_reference_only_vendor_cannot_carry_the_alarms(self):
        # It prices no option, so nothing the engine evaluates could be read from it. ADR 0019 allows
        # it for a Reference precisely because nothing alarms on one.
        assert next(v for v in VENDORS if v.name == "yahoo").can_be_provider is False
        assert "yahoo" not in PROVIDERS


class TestChoosingTheProvider:
    def test_builds_moomoo_without_reaching_for_a_socket(self):
        # constructing must be inert: the SDK is reached only when a fetch runs, in a worker thread
        # that does not exist yet, which is what lets a test name a Provider at all
        provider = make_provider(settings_for(provider="moomoo", moomoo_ws_key="k"))
        assert provider.name == "moomoo"
        assert callable(provider.fetch_quotes)

    def test_refuses_a_name_it_does_not_know_naming_the_ones_it_does(self):
        # fatal on purpose, as a mistyped MONITOR_INTERVAL_SECONDS is: a service that starts with no
        # Provider has no market data, no alarms, and a dashboard full of dashes
        with pytest.raises(RuntimeError, match=r"unknown provider 'ibkr-maybe'.*moomoo"):
            make_provider(settings_for(provider="ibkr-maybe"))

    def test_refuses_a_name_set_to_nothing_rather_than_falling_back(self):
        with pytest.raises(RuntimeError, match="unknown provider"):
            make_provider(settings_for(provider=""))

    def test_refuses_a_vendor_that_exists_but_may_not_be_the_provider(self):
        # yahoo is in VENDORS and reachable as a Reference source; naming it here must fail with the
        # same fatal error rather than booting an engine that cannot price an option
        with pytest.raises(RuntimeError, match="unknown provider 'yahoo'"):
            make_provider(settings_for(provider="yahoo"))

    def test_refuses_a_candidate_this_build_cannot_reach(self):
        # `IBKR_HOST` unset. The vendor can be a Provider and this deployment has not configured it,
        # which is a different fault from an unknown name and must still stop the service: the
        # alternative is an engine whose every fetch throws.
        with pytest.raises(RuntimeError, match="IBKR_HOST"):
            make_provider(settings_for(provider="ibkr", ibkr_host=""))

    def test_names_every_provider_it_can_build(self):
        configured = {"moomoo_ws_key": "k", "ibkr_host": "127.0.0.1"}
        for name in PROVIDERS:
            assert make_provider(settings_for(provider=name, **configured)).name == name


class TestOpeningWhatThisBuildCarries:
    def test_opens_the_provider_and_every_configured_source_and_nothing_else(self):
        opened = open_vendors(settings_for(provider="moomoo", moomoo_ws_key="k"))
        # yahoo needs no configuration, so it is always there; ibkr has no host in these settings
        assert sorted(opened.sources) == ["moomoo", "yahoo"]
        assert opened.provider.name == "moomoo"
        opened.close()

    def test_adds_a_candidate_vendor_as_a_reference_source_once_it_is_configured(self):
        # ADR 0019: IB Gateway is reached as a Reference source whether or not it is the Provider,
        # because a Reference alarms on nothing
        opened = open_vendors(settings_for(ibkr_host="127.0.0.1"))
        assert sorted(opened.sources) == ["ibkr", "moomoo", "yahoo"]
        opened.close()

    async def test_opens_no_connection_while_opening_a_vendor(self):
        # A client that connected when it was built could not be named in a test at all, and a dead
        # port blocks indefinitely — which is why `open` must only construct. Proven against a port
        # nothing listens on: this must return rather than hang, and hanging up must not throw.
        opened = open_vendors(settings_for(ibkr_host="127.0.0.1", ibkr_port=1))
        assert "ibkr" in opened.sources
        opened.close()
        # The MESSAGE, not merely a raise. A bare `pytest.raises(Exception)` is what let the
        # TypeScript's unbound-method bug through: the call failed from inside the client and read as
        # the dead port being reported. A fetch that fails must fail for its own reason.
        with pytest.raises(Exception, match="could not reach IB Gateway"):
            await opened.sources["ibkr"](["SPX"])

    async def test_calls_a_real_vendors_client_with_its_receiver_intact(self):
        # The TypeScript's bug: `sources[name] = client.fetchQuotes` unbinds `this`, so a vendor whose
        # client is a CLASS threw on its first call. A bound method cannot lose its receiver in
        # Python, so this cannot fail the same way — kept because a registry that wrapped or copied
        # the fetch could still lose the instance, and this one is a class on purpose.
        class Counting:
            name = "classy"

            def __init__(self) -> None:
                self.asked = 0

            async def fetch_quotes(self, codes: list[str]) -> Batch:
                # reading `self` is the whole point
                self.asked += len(codes)
                return Batch(records=[{"code": str(self.asked)}], unknown=[])

            async def reachable(self) -> bool:
                return True

            def close(self) -> None:
                pass

        vendor = ProviderVendor(name="classy", open=lambda _settings: Counting())
        opened = open_vendors(settings_for(provider="classy"), [vendor])
        assert (await opened.sources["classy"](["a", "b"])).records[0]["code"] == "2"
        # and the SAME instance answers both doors, which is what "one client either way" means
        assert (await opened.provider.fetch_quotes(["c"])).records[0]["code"] == "3"

    async def test_serves_the_providers_own_reference_rows_from_the_same_client(self):
        # Two connections to one gateway for the same data, each with its own client id and handshake,
        # is the trap ADR 0019 closed before it existed — and IB Gateway allows one connection per
        # client id, so the second would displace the first in silence. Asserted by asking BOTH doors
        # and watching one client count the calls.
        asked: list[list[str]] = []

        class One(Fake):
            def __init__(self) -> None:
                super().__init__("one")

                async def fetch(codes: list[str]) -> Batch:
                    asked.append(codes)
                    return Batch(records=[], unknown=[])

                self.fetch_quotes = fetch

        vendor = ProviderVendor(name="one", open=lambda _settings: One())
        opened = open_vendors(settings_for(provider="one"), [vendor])
        await opened.sources["one"](["from the strip"])
        await opened.provider.fetch_quotes(["from the sweep"])
        assert asked == [["from the strip"], ["from the sweep"]]

    def test_opens_a_vendor_once_even_when_it_is_both_the_provider_and_a_reference_source(self):
        opened_names: list[str] = []

        def open_counted(_settings):
            opened_names.append("counted")
            return Fake("counted")

        vendor = ProviderVendor(name="counted", open=open_counted)
        opened = open_vendors(settings_for(provider="counted"), [vendor])
        assert opened_names == ["counted"]
        # and it is registered as a source rather than skipped along with the second open
        assert list(opened.sources) == ["counted"]

    def test_hangs_up_everything_it_opened(self):
        closed: list[str] = []

        def made(name: str) -> ProviderVendor:
            return ProviderVendor(name=name, open=lambda _settings: Fake(name, closed=closed))

        opened = open_vendors(settings_for(provider="one"), [made("one"), made("two")])
        opened.close()
        assert sorted(closed) == ["one", "two"]

    def test_closes_the_rest_even_when_one_vendor_throws_on_the_way_out(self, caplog):
        # every way out of the process goes through this (main), and a vendor that throws while
        # hanging up must not leave the database open behind it
        closed: list[str] = []
        first = ProviderVendor(name="first", open=lambda _settings: Fake("first", refuses_to_close=True))
        second = ProviderVendor(name="second", open=lambda _settings: Fake("second", closed=closed))
        opened = open_vendors(settings_for(provider="first"), [first, second])
        with caplog.at_level(logging.ERROR, logger=LOG):
            opened.close()
        assert closed == ["second"]
        assert [r.getMessage() for r in caplog.records] == ["hanging up first failed:"]
        assert caplog.records[0].exc_info is not None


class TestWhatOnlyThePythonCanGetWrong:
    """No compiler holds a descriptor to the union, nor an opened vendor to the ports."""

    def test_every_vendor_opens_to_a_client_the_ports_accept(self):
        settings = settings_for(moomoo_ws_key="k", ibkr_host="127.0.0.1")
        for vendor in VENDORS:
            client = vendor.open(settings)
            assert client is not None, vendor.name
            assert client.name == vendor.name
            assert isinstance(client, VendorClient), vendor.name
            # a Provider candidate can be asked `reachable`; a Reference-only vendor owes nothing
            assert isinstance(client, ProviderClient) is vendor.can_be_provider, vendor.name
            client.close()

    def test_the_kind_of_a_vendor_is_its_class_not_a_field_anyone_can_set(self):
        # `canBeProvider: true as const` is a literal the compiler holds; here it is the class's
        assert ProviderVendor(name="p", open=lambda _settings: None).can_be_provider is True
        assert ReferenceVendor(name="r", open=lambda _settings: None).can_be_provider is False
        with pytest.raises(TypeError):
            ProviderVendor(name="p", open=lambda _settings: None, can_be_provider=False)  # type: ignore[call-arg]

    def test_ibkr_as_the_provider_is_the_reference_source_too_not_a_second_client(self):
        # ADR 0019's "one client either way", with the real descriptor: IB Gateway allows one
        # connection per client id, so a second `IbkrClient` here would displace the first in silence
        opened = open_vendors(settings_for(provider="ibkr", ibkr_host="127.0.0.1"))
        assert isinstance(opened.provider, IbkrClient)
        assert opened.sources["ibkr"].__self__ is opened.provider  # type: ignore[attr-defined]
        opened.close()

    def test_opening_starts_no_thread(self):
        # The moomoo SDK and yfinance block, so each runs on a worker thread of its own — started by
        # the first fetch, never by opening: a service that has not asked yet holds nothing.
        before = threading.active_count()
        opened = open_vendors(settings_for(ibkr_host="127.0.0.1"))
        assert threading.active_count() == before
        opened.close()
