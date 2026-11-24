"""IB Gateway as a vendor: the library's `IbkrClient`, opened from Settings.

backend/src/vendors/ibkr/vendor.ts has no test of its own. Its callers' tests rely on three things
it promises, and these hold them: `vendors/index.test.ts`'s "refuses a candidate this build cannot
reach" and "adds a candidate vendor as a Reference source once it is configured" need it to open to
nothing with `IBKR_HOST` blank and to a client with it set, and "opens no connection while opening a
vendor" needs opening to be inert. The client itself is the library's, held to the TypeScript's by
the recorded gateway conversations (`python/tests/test_ibkr_gateway.py`).

No test here reaches IB Gateway: nothing connects until a fetch is asked, and none is but one against
a port nothing listens on. Since ADR 0030 it has a test of its own, the account's read, which these
port at the end.
"""

from typing import Any, cast

from optionality.ibkr import IbkrAccountRefused, IbkrClient, IbkrUnreachable

from optionality_backend.env import settings_for
from optionality_backend.ports import AccountFailed, AccountRead, AccountRefused, AccountUnreachable, ProviderClient
from optionality_backend.vendors import ProviderVendor
from optionality_backend.vendors.ibkr.vendor import account_reader, ibkr_vendor


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


# --- the account's read (ADR 0030, #470) ------------------------------------------------------------
#
# **Where the Python differs, and why.** `vendor.test.ts` drives the library's real client against the
# library's fake gateway, its `client-id-in-use` recording included; the Python's fake gateway is the
# library's own test support (`python/tests/fake_gateway.py`), outside any package the backend may
# import. So the client is stood in for here by one that raises what the library's raises —
# `IbkrUnreachable` with `client-id-in-use`'s words, which `python/tests/test_ibkr_gateway.py` holds the
# library to against that recording — and the real client is driven against a port nothing listens on.
# The route's answer to a refused session is held identically in both backends by the door scenario
# "GET /account says the gateway refused the session, in its words".

#: the library's words for its `client-id-in-use` recording
REFUSED = (
    "IB Gateway refused the session: 326 Unable to connect as the client id is already in use. "
    "Retry with a unique client id."
)


class _Client:
    """The library client's one call the account's read makes, answering as told."""

    def __init__(self, *, answer: Any = None, raises: Exception | None = None) -> None:
        self.answer, self.raises = answer, raises
        self.asked: list[str | None] = []

    async def account(self, wanted: str | None = None) -> Any:
        self.asked.append(wanted)
        if self.raises is not None:
            raise self.raises
        return self.answer


def _reader(client: _Client) -> Any:
    return account_reader(cast(IbkrClient, client))


async def test_the_account_read_answers_the_librarys_account_for_the_account_asked_for():
    client = _Client(answer={"account": "masked"})
    assert await _reader(client)("U0000001") == AccountRead({"account": "masked"})
    assert client.asked == ["U0000001"]


async def test_the_account_read_is_a_refusal_in_the_librarys_words():
    words = "several accounts on this login; set IBKR_ACCOUNT to one of …"
    assert await _reader(_Client(raises=IbkrAccountRefused(words)))(None) == AccountRefused(words)


async def test_the_account_read_is_unreachable_in_the_gateways_words_where_it_refuses_the_session():
    assert await _reader(_Client(raises=IbkrUnreachable(REFUSED)))(None) == AccountUnreachable(REFUSED)


async def test_the_account_read_is_a_failure_in_the_librarys_words_where_it_does_not_finish():
    # a plain ConnectionError is a read that failed once it began: never "unreachable", though
    # `IbkrUnreachable` is one too
    words = "IB Gateway did not finish sending the account within 8000ms"
    assert await _reader(_Client(raises=ConnectionError(words)))(None) == AccountFailed(words)


async def test_the_account_read_is_unreachable_in_the_connects_words_against_a_port_nothing_listens_on():
    # the real client, reaching nothing: unreachable, never a failure, in the connect's own words
    client = IbkrClient("127.0.0.1", port=1, client_id=31419, connect_timeout_ms=500)
    try:
        reading = await account_reader(client)(None)
    finally:
        client.close()
    assert isinstance(reading, AccountUnreachable)
    assert reading.words.startswith("could not reach IB Gateway at 127.0.0.1:1: ")


def test_the_provider_carries_the_account_read():
    client = ibkr_vendor.open(settings_for(ibkr_host="127.0.0.1", ibkr_port=1))
    assert client is not None
    assert callable(client.read_account)
    client.close()
