"""Every market-data vendor this build carries, and the one seam they are reached through.
Port of backend/src/vendors/index.ts.

## Why this exists

There were three vendors and three shapes. moomoo was a factory returning a Provider; IBKR was a
function returning `{ sources, close }`; Yahoo was a bare `Sources` with nothing to hang up. The
TypeScript's `main.ts` merged the three by hand and `routes/references.ts` merged two of them again.
Nothing was wrong with the service that produced; what was wrong is what it cost to change. A fourth
vendor meant editing both merges, and a vendor that later grew a `close` would have been hung up in
one place and leaked in the other, because the merge named `ibkr.close` specifically.

So a vendor is a DESCRIPTOR, and adding one is a descriptor in a folder here plus a line in the list
below — and its client in the library, `optionality`. Nothing else in the service learns its name.

## The two kinds, and why they are two classes rather than a flag

A vendor that may be the Provider must answer `reachable` — `/health` asks it while nothing has been
fetched yet. A Reference-only vendor must not have to: Yahoo has no gateway to probe, and a
`reachable` that always says yes, written to satisfy an interface, is a lie the dashboard would
print. So each kind is its own class, and `can_be_provider` belongs to the class rather than to
whoever builds one.

Reference-only is a statement about PRICING, not about trust: Yahoo quotes index levels and no
option, so nothing the engine evaluates could come from it. ADR 0019 allows it for a Reference
precisely because a Reference alarms on nothing.

## What is NOT here

Anything about the fields a vendor supplies. That depends on the account it speaks for rather than
on its code, so it is observed and never declared — a silent figure is found by the sweep and
quarantined (ADR 0015, #167).

**Where the Python differs, and why.**

- A descriptor is a frozen dataclass, `ProviderVendor` or `ReferenceVendor`, where the TypeScript
  has a discriminated union of object types; `can_be_provider` is a `ClassVar`, so it cannot be set
  wrong on one, as `canBeProvider: true as const` cannot be typed wrong there. Each descriptor
  module imports its class from here — a type-only import in the TypeScript, the class itself in
  Python — so the classes are defined BEFORE the descriptors are imported, below them.
- The registry holds `client.fetch_quotes` as it is. The TypeScript wraps it, because extracting a
  method unbinds `this` and a class-shaped client then failed on its first call; a Python bound
  method keeps its receiver, so that reason is gone. Its test is kept.
- `Worker` is the Python's own. Two of the three clients the library has for this door BLOCK — the
  moomoo SDK and yfinance — and the service runs on one asyncio loop (ADR 0021, Decision 6), where a
  blocking call would stop the routes, the sweep and the bot together. So each blocking vendor
  gets one thread of its own. One PER VENDOR, so a dead OpenD cannot hold up Yahoo's figures — the
  containment between sources of ADR 0019, Decision 5. ONE and not a pool, so a dead OpenD costs a
  thread rather than one per sweep and poll. And never the loop's default executor, which name
  lookups share: Telegram's would queue behind a stuck vendor. IB Gateway's client is asyncio
  already and needs none.
- `open_vendors` answers `OpenVendors`, a name for the TypeScript's anonymous object type.
"""

import asyncio
import logging
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import ClassVar, Literal

from ..env import Settings
from ..ports import ProviderClient, QuoteFetcher, VendorClient

log = logging.getLogger(__name__)


@dataclass(frozen=True, kw_only=True)
class ProviderVendor:
    """A vendor that may be the one Provider: its client can also say whether its gateway is there."""

    can_be_provider: ClassVar[Literal[True]] = True
    #: The vendor's own name. A Reference's `source` column holds this, `schemas/reference.ts`
    #: validates against it, and `/health` prints it for the Provider.
    name: str
    #: The client, or None where this build cannot reach the vendor — a blank `IBKR_HOST`. Must open
    #: nothing: a client that connected when it was built could not be named in a test, and a dead
    #: port blocks indefinitely (the moomoo SDK retries one for ever).
    open: Callable[[Settings], ProviderClient | None]
    #: The variable that turns this vendor on, where one is needed — quoted when the Provider is named
    #: and cannot be reached, so the log says what to set rather than that something is missing. None
    #: for a vendor that needs no configuration.
    configured_by: str | None = None


@dataclass(frozen=True, kw_only=True)
class ReferenceVendor:
    """A vendor that can only ever serve a Reference. Owes no `reachable`, because nothing asks."""

    can_be_provider: ClassVar[Literal[False]] = False
    name: str
    open: Callable[[Settings], VendorClient | None]
    configured_by: str | None = None


type Vendor = ProviderVendor | ReferenceVendor


class Worker:
    """One thread for one vendor whose client blocks, so that asking it never stops the loop.

    Python's own; the module docstring says why. The thread is started by the first call, never by
    constructing — opening a vendor must hold nothing — and a call that is still QUEUED when its
    caller stops waiting is dropped rather than run for nobody. One that is already running cannot be
    stopped: it finishes on the thread, which is why each client here closes what it opened on that
    thread rather than leaving it to the caller.
    """

    def __init__(self, name: str) -> None:
        self._name = name
        self._pool: ThreadPoolExecutor | None = None

    def submit[T](self, fn: Callable[..., T], /, *args: object) -> asyncio.Future[T]:
        """Run `fn(*args)` on this vendor's thread; the answer is awaited on the loop."""
        if self._pool is None:
            self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix=self._name)
        return asyncio.get_running_loop().run_in_executor(self._pool, fn, *args)

    def close(self) -> None:
        """Drop what is queued, and start a new thread for whatever is asked next. What is running
        finishes on its own."""
        pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)


# The descriptors import the classes above from this module, so they are imported only now.
from .ibkr.vendor import ibkr_vendor
from .opend.vendor import moomoo_vendor
from .yahoo.vendor import yahoo_vendor

#: Every vendor this build carries. Adding one is a line here and a descriptor beside this file.
#:
#: Held to `schemas/reference.ts`'s `SOURCES` by a test: a name a Reference may be created with and no
#: vendor to serve it is a row that validates and then shows a dash for ever, and a vendor no
#: Reference may name is unreachable from the API.
VENDORS: tuple[Vendor, ...] = (moomoo_vendor, ibkr_vendor, yahoo_vendor)

#: The names `OPTIONALITY_PROVIDER` accepts, derived rather than listed twice.
#:
#: This was its own array, which is the shape of the bug it cannot now have: a vendor added to the
#: switch and not to the list was unannounceable, and the reverse was a name the error message
#: offered and nothing could build.
PROVIDERS: tuple[str, ...] = tuple(v.name for v in VENDORS if v.can_be_provider)


def make_provider(settings: Settings, vendors: Sequence[Vendor] = VENDORS) -> ProviderClient:
    """The Provider this deployment names, opened, or a fatal error.

    Fatal on purpose, like every other mistyped setting (`env.py`): a service that starts with no
    Provider has no market data, no alarms and a dashboard full of dashes, which is worse than one
    that does not start. launchd keeps trying and the log says what was wrong with the name.

    Two different faults, and the message distinguishes them. A name nothing carries is a typo, so
    the known names are quoted. A name this build carries but cannot REACH is a missing setting, so
    the variable is quoted instead — "unknown provider 'ibkr'" would send the owner looking for a
    feature that is already here.
    """
    vendor = next((v for v in vendors if v.name == settings.provider), None)
    # ONE guard. Written twice at first in the TypeScript — in the find and here — and a mutation
    # sweep showed removing either left every test passing, which is what a redundant check looks
    # like from the outside. A RuntimeError, as every fatal setting is (the TypeScript's `Error`),
    # though the guard reads the vendor's class: the fault is a name, not a type.
    if not isinstance(vendor, ProviderVendor):
        known = ", ".join(v.name for v in vendors if v.can_be_provider)
        raise RuntimeError(  # noqa: TRY004 — see above
            f"OPTIONALITY_PROVIDER: unknown provider '{settings.provider}' (known: {known})"
        )
    client = vendor.open(settings)
    if client is None:
        raise RuntimeError(
            f"OPTIONALITY_PROVIDER: {vendor.name} is this deployment's Provider but nothing configures "
            f"it — set {vendor.configured_by or 'its connection'}"
        )
    return client


@dataclass(frozen=True)
class OpenVendors:
    """Everything this build can reach, opened: the Provider, every source, one way out."""

    provider: ProviderClient
    #: Every vendor that opened, by name — the Provider among them.
    sources: Mapping[str, QuoteFetcher] = field(repr=False)
    #: Hang up everything that opened. One loop, so a vendor cannot be forgotten by growing a `close`
    #: after the fact.
    close: Callable[[], None] = field(repr=False)


def open_vendors(settings: Settings, vendors: Sequence[Vendor] = VENDORS) -> OpenVendors:
    """Everything this build can reach, opened once: the Provider, every source, one way out.

    The Provider is opened as a vendor like any other and then named, so its Reference rows are
    served by the SAME client the alarms read from. That is the half of ADR 0019 that cannot be left
    to memory: IB Gateway allows one connection per client id and the second displaces the first in
    silence, so a second client for the same vendor would not fail — it would quietly break the
    first.
    """
    opened: list[VendorClient] = []
    sources: dict[str, QuoteFetcher] = {}

    def register(client: VendorClient) -> None:
        opened.append(client)
        sources[client.name] = client.fetch_quotes

    provider = make_provider(settings, vendors)
    register(provider)

    for vendor in vendors:
        # the Provider is already open, and opening it twice is the thing this function exists to
        # prevent rather than something to tidy afterwards
        if vendor.name == provider.name:
            continue
        client = vendor.open(settings)
        if client is None:
            continue  # not configured: a Reference naming it gets a dash saying so
        register(client)

    def close() -> None:
        for client in opened:
            # one vendor's refusal must not strand the rest: this is on every way out of the process
            # (main), and the database is closed after it
            try:
                client.close()
            except Exception:
                log.exception("hanging up %s failed:", client.name)

    return OpenVendors(provider=provider, sources=sources, close=close)
