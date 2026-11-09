"""IB Gateway as a vendor (ADR 0019, track C). Port of backend/src/vendors/ibkr/vendor.ts.

Reached as a Reference source whether or not it is the Provider, because a Reference alarms on
nothing and nothing is derived from one — the only reason the one-Provider rule does not reach it.
It is a `ProviderVendor` because this client can answer everything a Provider must: whether this
deployment SHOULD read its alarms from IBKR is `OPTIONALITY_PROVIDER`'s answer, not this file's.

One client either way. Two connections to one gateway for the same data, each with its own client
id and handshake, is the trap ADR 0019 closed before it existed — and IB Gateway allows one
connection per client id, so the second would displace the first in silence. The vendor door opens
each vendor once and shares it, which is what makes that structural rather than remembered.

Off unless `IBKR_HOST` is set: `open` answers None, a Reference naming `ibkr` gets a dash saying "no
ibkr client in this build", and naming it as the Provider is fatal at boot.

**Where the Python differs, and why.** The client is the library's `optionality.ibkr.IbkrClient`, on
`ib_async` rather than a port of the TypeScript's hand-written one (ADR 0021, Decision 7), and held
to the same recorded gateway conversations. It is asyncio already, so unlike moomoo and Yahoo it
needs no worker thread: it runs on the loop with the routes, the sweep and the bot.
"""

from optionality.ibkr import IbkrClient

from ...env import Settings
from .. import ProviderVendor


def _open(settings: Settings) -> IbkrClient | None:
    if not settings.ibkr_host:
        return None
    # Held for the life of the process, not opened per ask: a handshake and a session start on every
    # dashboard refresh is 5,760 of them a day to read two numbers, which is the waste the OpenD
    # client already rejected for websockets.
    return IbkrClient(settings.ibkr_host, port=settings.ibkr_port, client_id=settings.ibkr_client_id)


#: Why `IBKR_HOST`: the gateway runs wherever the owner logs in, and there is no default worth
#: guessing — 4001 vs 4002 already depends on whether that login is live or paper.
ibkr_vendor = ProviderVendor(name="ibkr", configured_by="IBKR_HOST", open=_open)
