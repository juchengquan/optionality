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
needs no worker thread: it runs on the loop with the routes, the sweep and the bot. And the descriptor
hands back the client itself, where the TypeScript's hands back an object of closures — a Python bound
method keeps its receiver — so the one thing a Provider owes that the library's client does not have,
`quote_grade`, is added by a subclass here rather than a closure — and so is the account's read
(ADR 0030, #470), `read_account`, which the TypeScript's object carries as `readAccount`.
"""

from optionality.ibkr import (
    CONNECT_TIMEOUT_MS,
    DEFAULT_HOST,
    QUIET_MS,
    REQUEST_TIMEOUT_MS,
    IbkrAccountRefused,
    IbkrClient,
    IbkrUnreachable,
)

from ...env import Settings
from ...ports import (
    AccountFailed,
    AccountRead,
    AccountReading,
    AccountRefused,
    AccountUnreachable,
    QuoteGradeReading,
    ReadAccount,
)
from .. import ProviderVendor


def account_reader(client: IbkrClient) -> ReadAccount:
    """The account's one read over `client` (ADR 0030, #470), every way it ends sorted for the route: the
    library's `IbkrUnreachable` — no session at all, in the connect's own words — apart from a read that
    failed once it began (a plain ConnectionError: its deadline, or its connection closing under it)
    and from `IbkrAccountRefused`. One connect, made by `account` itself, so the words of a refused
    session reach the route rather than a probe's yes or no.

    **Where the Python differs, and why.** `IbkrUnreachable` is a ConnectionError, as a failed read is,
    so it is caught first; the TypeScript's are unrelated `Error`s and the order there is free."""

    async def read(wanted: str | None) -> AccountReading:
        try:
            return AccountRead(await client.account(wanted))
        except IbkrUnreachable as err:
            return AccountUnreachable(str(err))
        except IbkrAccountRefused as err:
            return AccountRefused(str(err))
        except Exception as err:  # noqa: BLE001 — every other way the read ends is its failure, in its words
            return AccountFailed(str(err))

    return read


class IbkrProvider(IbkrClient):
    """The library's client as a Provider, and the account's one read over it."""

    def __init__(
        self,
        host: str = DEFAULT_HOST,
        *,
        port: int,
        client_id: int,
        connect_timeout_ms: int = CONNECT_TIMEOUT_MS,
        request_timeout_ms: int = REQUEST_TIMEOUT_MS,
        quiet_ms: int = QUIET_MS,
    ) -> None:
        # everything the library's client takes, with its defaults, so a Provider is built as one is
        super().__init__(
            host,
            port=port,
            client_id=client_id,
            connect_timeout_ms=connect_timeout_ms,
            request_timeout_ms=request_timeout_ms,
            quiet_ms=quiet_ms,
        )
        #: over the same client, so the account is read on the session the prices are
        self.read_account: ReadAccount = account_reader(self)

    def quote_grade(self) -> QuoteGradeReading | None:
        """None: IB Gateway grades each REQUEST, which a Reference row carries as `delayed`; it states no
        grade for the account, and passing a request's through as one is out of scope (#464)."""
        return None


def _open(settings: Settings) -> IbkrProvider | None:
    if not settings.ibkr_host:
        return None
    # Held for the life of the process, not opened per ask: a handshake and a session start on every
    # dashboard refresh is 5,760 of them a day to read two numbers, which is the waste the OpenD
    # client already rejected for websockets.
    return IbkrProvider(settings.ibkr_host, port=settings.ibkr_port, client_id=settings.ibkr_client_id)


#: Why `IBKR_HOST`: the gateway runs wherever the owner logs in, and there is no default worth
#: guessing — 4001 vs 4002 already depends on whether that login is live or paper.
ibkr_vendor = ProviderVendor(name="ibkr", configured_by="IBKR_HOST", open=_open)
