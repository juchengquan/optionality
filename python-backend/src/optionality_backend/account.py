"""The IBKR account, read on demand and shared (ADR 0030, #470): the service behind `GET /account`,
paired with `routes/account.py`. Port of backend/src/account.ts.

The read itself is the library's (`IbkrClient.account`), reached through the IB vendor's descriptor as
a `ReadAccount`, which has already sorted every way a read can end. What is decided here is the rest:

- **which account**: `.env`'s `IBKR_ACCOUNT`, blank meaning unset, handed to the library as its
  `wanted` — the library chooses, and refuses where it cannot, every id masked;
- **the sharing**: ONE read for every caller for `ACCOUNT_SHARED_FOR_MS`, counted from when it came
  back; a read in flight is joined, and a failure is shared like an answer, so a page refreshing often
  — or a gateway that is down — costs IB Gateway one read per window. Never polled by the service and
  never read by the sweep: a request is the only thing that reads;
- **the answer**: the library's, stocks (`STK`) and options (`OPT`) apart and everything else under
  `other` with only what the page lists of it (the owner's decision on #470), and when the service
  read it;
- **the status** each failure is: a vendor not configured 503 (the owner's decision on #473), a vendor
  down or refusing the session 502, a refusal to choose an account 422.

Nothing is stored: the answer lives in this object for the window and is gone.

**Where the Python differs, and why.** The shared read is an asyncio task, started eagerly as the
TypeScript's promise starts, and awaited through `asyncio.shield` so that one caller giving up does not
cancel it under the others. The library's answer is a mapping (`ports.AccountRead`). A reader that raises (a bug: `ReadAccount` never raises) is not shared, as
the TypeScript's rejected promise is dropped. `IBKR_ACCOUNT` is trimmed with `JS_WHITESPACE`, as
`trim()` trims: `str.strip()` also takes the C0 separators (`\x1c`–`\x1f`), so a value JavaScript asks
for would have read as blank here.
"""

import asyncio
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from optionality.timefmt import display_time

from .ports import AccountRead, AccountReading, AccountRefused, AccountUnreachable, ReadAccount
from .schemas.zod import JS_WHITESPACE

log = logging.getLogger(__name__)

#: How long one read is shared by every caller, from when it came back: 10 s, the owner's decision on
#: #470 — under the page's 15 s refresh, so each refresh reads afresh, while two tabs, or a refresh
#: beside a write's re-read, share one.
ACCOUNT_SHARED_FOR_MS = 10_000

#: The words for a build with no IB Gateway (`IBKR_HOST` blank).
NOT_CONFIGURED = "IB Gateway is not configured"
#: The words for a gateway that could not be reached: down, or at its login screen, where its API port
#: is shut. The connect's own words go to the log, not to the page.
NOT_ANSWERING = "IB Gateway did not answer — is it running and logged in?"
#: How the library begins the words for a session the gateway refused (`socket.ts`, `ibkr.py`): it
#: answered, and said why — a client id already in use is the one met — so the page is told that, in
#: those words, rather than to start a gateway that is running. Held to the library's own words by the
#: TypeScript's `vendors/ibkr/vendor.test.ts`, against its `client-id-in-use` recording, and to the
#: Python library's by its own suite against the same recording.
REFUSED_SESSION = "IB Gateway refused the session:"

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def _ms(when: datetime) -> int:
    """`Date.getTime`: whole milliseconds since the epoch."""
    return (when - _EPOCH) // timedelta(milliseconds=1)


@dataclass(frozen=True)
class AccountFault:
    status: Literal[422, 502, 503]
    message: str


@dataclass(frozen=True)
class AccountResult:
    """`{ answer }` or `{ fault }`: exactly one is set."""

    answer: dict[str, Any] | None = None
    fault: AccountFault | None = None


@dataclass(frozen=True)
class AccountDeps:
    #: None where IB Gateway is not configured
    read: ReadAccount | None
    #: `.env`'s `IBKR_ACCOUNT`, as written: blank is unset
    wanted: str
    now: Callable[[], datetime]
    display_tz: str


def account_answer(account: Mapping[str, Any], at: datetime, display_tz: str) -> dict[str, Any]:
    """The library's answer as the route serves it, read at `at`."""
    holdings = account["holdings"]
    return {
        "account": account["account"],
        "paper": account["paper"],
        "base_currency": account["base_currency"],
        "updated_at": account["updated_at"],
        "totals": account["totals"],
        "exchange_rates": account["exchange_rates"],
        "read_at": display_time(at, display_tz),
        "stocks": [h for h in holdings if h["sec_type"] == "STK"],
        "options": [h for h in holdings if h["sec_type"] == "OPT"],
        "other": [
            {
                "sec_type": h["sec_type"],
                "symbol": h["symbol"],
                "position": h["position"],
                "market_value": h["market_value"],
                "currency": h["currency"],
            }
            for h in holdings
            if h["sec_type"] not in ("STK", "OPT")
        ],
    }


def _fault_of(reading: AccountReading) -> AccountFault:
    """What a reading that is not an account says, and with which status. Where no session was had, the
    connect's own words are logged, once per read; the page is told a refused session in the gateway's
    words and anything else as a gateway that did not answer. Neither carries an account id: none is
    known before a session."""
    if isinstance(reading, AccountUnreachable):
        log.error("IBKR account: %s", reading.words)
        refused = reading.words.startswith(REFUSED_SESSION)
        return AccountFault(502, reading.words if refused else NOT_ANSWERING)
    if isinstance(reading, AccountRefused):
        return AccountFault(422, reading.words)
    assert not isinstance(reading, AccountRead)
    return AccountFault(502, reading.words)


@dataclass
class _Shared:
    """The read shared now: in flight while `at` is None, then its result until the window passes."""

    result: "asyncio.Task[AccountResult] | None" = None
    at: int | None = None


@dataclass
class AccountBook:
    """One per app, so every caller — today the page alone — shares its read."""

    deps: AccountDeps
    _shared: _Shared | None = field(default=None)

    async def read(self) -> AccountResult:
        deps = self.deps
        if deps.read is None:
            return AccountResult(fault=AccountFault(503, NOT_CONFIGURED))
        t = _ms(deps.now())
        held = self._shared
        if held is not None and held.at is not None:
            # a clock that went BACK trusts nothing old
            age = t - held.at
            if age < 0 or age >= ACCOUNT_SHARED_FOR_MS:
                self._shared = None
        shared = self._shared or self._start(deps.read)
        assert shared.result is not None
        return await asyncio.shield(shared.result)

    def _start(self, read: ReadAccount) -> _Shared:
        """The read, shared from now: held BEFORE it starts, because an eager task can finish — and
        drop itself — before the line that would otherwise hold it."""
        deps = self.deps
        entry = _Shared()
        self._shared = entry

        async def run() -> AccountResult:
            try:
                reading = await read(deps.wanted.strip(JS_WHITESPACE) or None)
            except Exception:
                # a reader that raises breaks its own promise (`ReadAccount`): that is a bug, a 500, and
                # never shared — the next caller reads again
                if self._shared is entry:
                    self._shared = None
                raise
            at = deps.now()
            entry.at = _ms(at)
            if isinstance(reading, AccountRead):
                return AccountResult(answer=account_answer(reading.account, at, deps.display_tz))
            return AccountResult(fault=_fault_of(reading))

        entry.result = asyncio.Task(run(), loop=asyncio.get_running_loop(), eager_start=True)
        # retrieved here, since a caller may never come back for it
        entry.result.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        return entry
