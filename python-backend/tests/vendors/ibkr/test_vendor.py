"""IB Gateway as a vendor: the library's `IbkrClient`, opened from Settings.

backend/src/vendors/ibkr/vendor.ts has no test of its own. Its callers' tests rely on three things
it promises, and these hold them: `vendors/index.test.ts`'s "refuses a candidate this build cannot
reach" and "adds a candidate vendor as a Reference source once it is configured" need it to open to
nothing with `IBKR_HOST` blank and to a client with it set, and "opens no connection while opening a
vendor" needs opening to be inert. The client itself is the library's, held to the TypeScript's by
the recorded gateway conversations (`python/tests/test_ibkr_gateway.py`).

No test here reaches IB Gateway: nothing connects until a fetch is asked, and none is but one against
a port nothing listens on. Since ADR 0030 it has a test of its own, the account's (since ADR 0031 its
watch), which these port at the end.
"""

import logging
from datetime import UTC, datetime
from typing import Any, cast

import pytest
from optionality.ibkr import IbkrAccountRefused, IbkrClient, IbkrUnreachable
from optionality.quote import Batch

from optionality_backend.account import NOT_ANSWERING, AccountBook, AccountDeps, AccountFault, AccountResult
from optionality_backend.env import settings_for
from optionality_backend.ports import (
    AccountFailed,
    AccountRefused,
    AccountSource,
    AccountUnreachable,
    AccountWatched,
    ProviderClient,
)
from optionality_backend.vendors import ProviderVendor
from optionality_backend.vendors.ibkr.vendor import IbkrAccountSource, IbkrProvider, ibkr_vendor


def test_is_a_provider_candidate_turned_on_by_its_host():
    assert isinstance(ibkr_vendor, ProviderVendor)
    assert ibkr_vendor.name == "ibkr"
    # quoted by the fatal error when it is named the Provider and nothing configures it
    assert ibkr_vendor.configured_by == "IBKR_HOST"


def test_opens_to_nothing_while_its_host_is_blank():
    # a Reference naming `ibkr` then gets a dash saying so, and naming it the Provider is fatal
    assert ibkr_vendor.open(settings_for(ibkr_host="")) is None


def test_opens_the_gateway_the_settings_name_on_the_services_client_id():
    client = ibkr_vendor.open(settings_for(ibkr_host="10.0.0.7", ibkr_port=4002, ibkr_client_id=31417))
    assert isinstance(client, IbkrClient)
    assert isinstance(client, ProviderClient)
    # IB Gateway allows ONE connection per client id; the id is the owning process's port
    assert (client.name, client.host, client.port, client.client_id) == ("ibkr", "10.0.0.7", 4002, 31417)
    client.close()


def test_opening_connects_nothing():
    # Held for the life of the process once it connects — a handshake per dashboard refresh would be
    # 5,760 a day — but opening only constructs. This test runs with no event loop at all, and the
    # client is asyncio from end to end, so nothing here can have begun to connect.
    client = ibkr_vendor.open(settings_for(ibkr_host="127.0.0.1"))
    assert client is not None
    client.close()


# --- the account's watch (ADR 0031, #477) ----------------------------------------------------------
#
# **Where the Python differs, and why.** `vendor.test.ts` drives the library's real client against the
# library's fake gateway, its `client-id-in-use` recording included; the Python's fake gateway is the
# library's own test support (`python/tests/fake_gateway.py`), outside any package the backend may
# import. So the client is stood in for here by one that raises what the library's raises —
# `IbkrUnreachable` with `client-id-in-use`'s words, the deadline's, a refusal's — which
# `python/tests/test_ibkr_gateway.py` and `test_ibkr_client.py` hold the library's watch to against the same
# recordings the TypeScript's real-client tests replay (`client-id-in-use`, `watch-never-ends`,
# `watch-several`); and the real client is driven against a port nothing listens on.
# The route's answer to a refused session is held identically in both backends by the door scenario
# "GET /account says the gateway refused the session, in its words".

#: the library's words for its `client-id-in-use` recording
REFUSED = (
    "IB Gateway refused the session: 326 Unable to connect as the client id is already in use. "
    "Retry with a unique client id."
)


class _Watch:
    def picture(self) -> dict[str, Any]:
        return {"account": "masked"}

    lost = None

    def on_lost(self, listener: Any) -> None:
        pass

    async def stop(self) -> None:
        pass


WATCH = _Watch()


class _Client:
    """The library client's one call the account's source makes, answering as told."""

    def __init__(self, *, raises: Exception | None = None) -> None:
        self.raises = raises
        self.asked: list[str | None] = []

    async def watch_account(self, wanted: str | None = None) -> Any:
        self.asked.append(wanted)
        if self.raises is not None:
            raise self.raises
        return WATCH


async def test_a_start_answers_the_librarys_watch_asking_for_the_account_named_or_none():
    client = _Client()
    source = IbkrAccountSource(client)
    assert await source.watch("U0000001") == AccountWatched(cast(Any, WATCH))
    assert await source.watch(None) == AccountWatched(cast(Any, WATCH))
    assert client.asked == ["U0000001", None]


async def test_a_start_is_a_refusal_in_the_librarys_words():
    words = "several accounts on this login; set IBKR_ACCOUNT to one of …"
    assert await IbkrAccountSource(_Client(raises=IbkrAccountRefused(words))).watch(None) == AccountRefused(words)


async def test_a_start_is_unreachable_in_the_gateways_words_where_it_refuses_the_session():
    assert await IbkrAccountSource(_Client(raises=IbkrUnreachable(REFUSED))).watch(None) == AccountUnreachable(REFUSED)


async def test_a_start_is_a_failure_in_the_librarys_words_where_the_first_picture_does_not_come():
    # a plain ConnectionError is a start that failed once it began: never "unreachable", though
    # `IbkrUnreachable` is one too
    words = "IB Gateway did not finish sending the account within 8000ms"
    assert await IbkrAccountSource(_Client(raises=ConnectionError(words))).watch(None) == AccountFailed(words)


async def test_a_start_is_unreachable_in_the_connects_words_against_a_port_nothing_listens_on():
    # the real client and its real watch, reaching nothing: unreachable, never a failure, in the
    # connect's own words — and the route says the gateway did not answer
    client = IbkrClient("127.0.0.1", port=1, client_id=31419, connect_timeout_ms=500)
    try:
        started = await IbkrAccountSource(client).watch(None)
        assert isinstance(started, AccountUnreachable)
        assert started.words.startswith("could not reach IB Gateway at 127.0.0.1:1: ")
        book = AccountBook(
            AccountDeps(
                source=IbkrAccountSource(client),
                wanted="",
                now=lambda: datetime(2026, 11, 23, 15, tzinfo=UTC),
                display_tz="",
                wake=lambda _ms, _fn: lambda: None,
            )
        )
        assert await book.read() == AccountResult(fault=AccountFault(502, NOT_ANSWERING))
    finally:
        client.close()


def test_the_client_answering_tells_every_listener_and_a_listener_that_raises_is_logged(caplog):
    source = IbkrAccountSource(_Client())
    heard: list[str] = []

    def bug() -> None:
        raise RuntimeError("a bug")

    source.on_answered(bug)
    source.on_answered(lambda: heard.append("second"))
    with caplog.at_level(logging.ERROR, logger="optionality_backend.vendors.ibkr.vendor"):
        source.answered()
    assert heard == ["second"]
    assert [r.getMessage() for r in caplog.records] == ["IBKR account: a bug"]


def test_the_provider_carries_the_accounts_source():
    client = ibkr_vendor.open(settings_for(ibkr_host="127.0.0.1", ibkr_port=1))
    assert isinstance(client, IbkrProvider)
    assert isinstance(client.account_source, AccountSource)
    client.close()


def _provider_heard(port: int = 1) -> tuple[IbkrProvider, list[int]]:
    client = ibkr_vendor.open(settings_for(ibkr_host="127.0.0.1", ibkr_port=port))
    assert isinstance(client, IbkrProvider)
    heard: list[int] = []
    client.account_source.on_answered(lambda: heard.append(1))
    return client, heard


async def test_says_the_client_answered_after_a_price_read_that_worked_and_not_after_one_that_asked_nothing(
    monkeypatch,
):
    async def answers(self: IbkrClient, codes: list[str]) -> Batch:
        return Batch(records=[], unknown=list(codes))

    monkeypatch.setattr(IbkrClient, "fetch_quotes", answers)
    client, heard = _provider_heard()
    await client.fetch_quotes([])
    assert heard == []
    await client.fetch_quotes(["US.SPXW261218C8100000"])
    assert heard == [1]
    client.close()


async def test_does_not_say_the_client_answered_after_a_price_read_that_failed():
    client, heard = _provider_heard()
    try:
        with pytest.raises(Exception):  # noqa: B017 — whatever the connect raises
            await client.fetch_quotes(["US.SPXW261218C8100000"])
    finally:
        client.close()
    assert heard == []


async def test_says_the_client_answered_after_a_handshake_for_health_and_not_after_one_that_failed(monkeypatch):
    client, heard = _provider_heard()
    assert await client.reachable() is False
    assert heard == []

    async def up(self: IbkrClient) -> bool:
        return True

    monkeypatch.setattr(IbkrClient, "reachable", up)
    assert await client.reachable() is True
    assert heard == [1]
    client.close()
