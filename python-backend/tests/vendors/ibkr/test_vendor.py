"""IB Gateway as a vendor: the library's `IbkrClient`, opened from Settings.

backend/src/vendors/ibkr/vendor.ts has no test of its own. Its callers' tests rely on three things
it promises, and these hold them: `vendors/index.test.ts`'s "refuses a candidate this build cannot
reach" and "adds a candidate vendor as a Reference source once it is configured" need it to open to
nothing with `IBKR_HOST` blank and to a client with it set, and "opens no connection while opening a
vendor" needs opening to be inert. The client itself is the library's, held to the TypeScript's by
the recorded gateway conversations (`python/tests/test_ibkr_gateway.py`).

No test here reaches IB Gateway: nothing connects until a fetch is asked, and none is.
"""

from optionality.ibkr import IbkrClient

from optionality_backend.env import settings_for
from optionality_backend.ports import ProviderClient
from optionality_backend.vendors import ProviderVendor
from optionality_backend.vendors.ibkr.vendor import ibkr_vendor


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
