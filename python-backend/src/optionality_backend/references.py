"""The reference path: one bounded call of its own, and a degrade the sweep cannot afford (ADR 0018).
Port of backend/src/references.ts.

A Reference is a Security kept on the page to read the market by. It never alarms, nothing is derived
from it, and no rule reads one — so this module reads the database, makes ONE call per source, and
answers. It writes nothing: a Reference is never auto-disabled, never notified and never deleted,
because its absence is not an event.

Why it does not share `/quotes`' batch, though that would cost no extra call: moomoo rejects a whole
batch for one bad code, and the containment loop in the OpenD client drops only a code moomoo NAMES —
a class refusal names no culprit and is re-thrown, deliberately, so that an outage cannot present as a
watchlist full of unknown contracts. `US..SPX` is exactly that refusal and it is the first thing a
reasonable person types. In the sweep's batch it would kill every sweep every fifteen seconds and take
the real alarms dark (#175's shape); in `/quotes`' batch it would blank the whole watchlist. The
watchlist is what the owner acts on, and a backdrop must never be able to blank it.

Which is also why NOTHING here raises. A Provider that is wholly down leaves every Reference a dash
with the Provider's own sentence beside it, and the route answers 200 — the one surface on this
dashboard that cannot fail, because the page it decorates must still draw.

**Where the Python differs, and why.**

- `ReferenceEntry` is a frozen dataclass, the TypeScript's interface; the route turns it into the JSON
  it answers with.
- The sources are asked together with `asyncio.gather`, the TypeScript's `Promise.all`. JavaScript
  starts each source's call the moment `map` runs; a gathered coroutine starts when the loop turns, which
  is still before anything is awaited, and only the order of calls ACROSS vendors could tell the two
  apart — which nothing reads.
- A vendor's freshness claim is a boolean only if it is `bool`, and a minute count a number only if it is
  not one: `typeof x === "boolean"` refuses 1, and `typeof x === "number"` refuses `true`, where Python's
  `isinstance(True, int)` takes it.
- A record is keyed by `str(record.get("code"))`, `String(record.code)`, as `optionality.quote`'s
  `display_records` keys one; and "a quote arrived" is `is not None`, because a JavaScript object is
  truthy however empty it is.
"""

import asyncio
import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass

from optionality.quote import Quote
from optionality.reference import reference_figure

from .db.queries import list_references
from .ports import QuoteFetcher


@dataclass(frozen=True)
class ReferenceEntry:
    """One Reference, ready to draw: no arithmetic left for the client and no reason left unsaid."""

    id: str
    code: str
    #: what to call it, or None for "the code is its own name"
    label: str | None
    #: the vendor that answered, which the strip SHOWS: a figure from outside the Provider is allowed
    #: precisely because it says where it came from (ADR 0019).
    source: str
    #: the Security's own name, as the Provider gives it; None where no quote arrived
    name: str | None
    figure: float | None
    #: which field the figure came from, so the page can say which number it is showing
    field: str | None
    change: float | None
    #: why there is no figure, or None. A dash on the page and nothing more: never a notice, never a
    #: quarantine, never a deletion.
    error: str | None
    #: Whether the figure came from the vendor's DELAYED tier — a fact about the subscription, not about
    #: today. None where the vendor said nothing: moomoo reports no grade at all, and False would read as
    #: "it told us this is live" (ADR 0019).
    delayed: bool | None
    #: Whether the vendor is serving the most recent value it holds rather than an updating one. None for
    #: the same reason.
    last_known: bool | None
    #: How late, in minutes, where the vendor STATES it. Yahoo reports `exchangeDataDelayedBy`; IBKR
    #: reports a tier and no duration, so the strip says "15m late" for one and "delayed" for the other —
    #: each what its vendor actually said.
    delayed_by_minutes: float | None


@dataclass
class _Fetched:
    """What one attempt at the whole list came back with, by code."""

    quotes: dict[str, Quote]
    #: code -> why it has no quote. Three different answers, kept apart because they send a reader to
    #: three different places: a code the Provider does not know is a typo, a refusal is the Provider's
    #: own sentence, and a silent omission is neither.
    faults: dict[str, str]


def _flag(quote: Quote | None, key: str) -> bool | None:
    """A vendor's own claim about freshness, or None where it made none. None and False are different:
    False means the vendor said the figure is live."""
    value = None if quote is None else quote.get(key)
    return value if isinstance(value, bool) else None


def _minutes(quote: Quote | None) -> float | None:
    value = None if quote is None else quote.get("delayed_by_minutes")
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


# Why a Reference has no figure, in the words of the vendor it actually asked.
#
# These said "the Provider" until 2026-11-08, which ADR 0019 had already made untrue: a Reference may
# name a vendor the rest of the service does not use, so a Yahoo symbol Yahoo does not carry reported a
# Provider that was never asked. It is the third time this service has blamed one vendor for another's
# answer — ADR 0018 corrected `verifyContracts`, and the sweeper's degraded default was corrected for the
# same reason — and the fix is the same each time: the sentence takes the name from whoever was asked.
def _unknown_code(source: str) -> str:
    return f"{source} does not know this code"


def _no_quote(source: str) -> str:
    return f"{source} returned no quote for it"


#: The vendors this build can actually reach, by name.
#:
#: Not every name `SOURCES` knows: a source is reachable when a client for it exists, and a Reference
#: naming one that does not gets a dash with that sentence rather than a blank. The registry is assembled
#: by the caller, which is how a Reference can be served by a vendor that is NOT the Provider (ADR 0019)
#: without this module knowing what a Provider is.
type Sources = Mapping[str, QuoteFetcher]


def no_client(source: str) -> str:
    """A source this build cannot reach at all. Public because `routes/references.py` refuses a creation
    with the same sentence, and two copies of one wording drift."""
    return f"no {source} client in this build"


_NO_PRICE = "the quote carries no price"


async def _fetch_all(codes: list[str], fetch: QuoteFetcher, source: str) -> _Fetched:
    """One bounded batch, and on a RAISE one call per Reference.

    Bounded by the number of References, which is the whole reason the retry lives here rather than in
    the shared `batch()`: there a persistently refused code would mean eight calls every fifteen seconds
    — worse than failing, and a risk to the sweep watchdog. This path can afford what the sweep cannot,
    because nothing waits on it.

    A batch that ANSWERED is never retried, however much of it is unknown: an unknown code is an answer,
    and asking again would spend a call to be told the same thing.
    """
    got = _Fetched(quotes={}, faults={})

    def take(records: list[Quote], unknown: list[str]) -> None:
        for record in records:
            got.quotes[str(record.get("code"))] = record
        # the vendor that was asked, which is what the strip shows beside the dash
        for code in unknown:
            got.faults[code] = _unknown_code(source)

    try:
        batch = await fetch(codes)
        take(batch.records, batch.unknown)
    except Exception:  # noqa: BLE001 — the TypeScript's bare `catch`: whatever refused the batch, ask one by one
        for code in codes:
            try:
                one = await fetch([code])
                take(one.records, one.unknown)
            except Exception as err:  # noqa: BLE001 — a dash with its reason, never a failed route
                # the Provider's own sentence, because it is what distinguishes a gateway that could not
                # be reached from one that answered and declined the security — the same distinction
                # ADR 0018 corrected in `verifyContracts`
                got.faults[code] = str(err)
    return got


async def reference_readings(db: sqlite3.Connection, sources: Sources) -> list[ReferenceEntry]:
    """Every Reference with its live figure, in the order they were added.

    Takes the port rather than `Deps` so that it can be exercised without an app, as `watchlist_quotes`
    is.
    """
    rows = list_references(db)
    # no call at all for an empty list: the dashboard polls this every 15 seconds per open tab, and a
    # call that can buy nothing is one ADR 0010 says is not free
    if not rows:
        return []

    # ONE bounded call per source in use, not per Reference — three figures from one vendor are one call
    # (ADR 0019). Grouped and run together rather than in series: the dashboard waits on this, and a
    # logged-out gateway's timeout should not be added to a healthy vendor's latency.
    by_source: dict[str, list[str]] = {}
    for row in rows:
        by_source.setdefault(row["source"], []).append(row["code"])

    quotes: dict[str, Quote] = {}
    faults: dict[str, str] = {}

    async def one(source: str, codes: list[str]) -> None:
        fetch = sources.get(source)
        if fetch is None:
            # containment between sources: a vendor with no client takes its own rows down and nobody
            # else's. The same argument that gave References a call of their own, one level up.
            for code in codes:
                faults[code] = no_client(source)
            return
        got = await _fetch_all(codes, fetch, source)
        quotes.update(got.quotes)
        faults.update(got.faults)

    await asyncio.gather(*(one(source, codes) for source, codes in by_source.items()))

    out = []
    for row in rows:
        quote = quotes.get(row["code"])
        reading = reference_figure(quote)
        fault = faults.get(row["code"], None if quote is not None else _no_quote(row["source"]))
        name = None if quote is None else quote.get("name")
        out.append(
            ReferenceEntry(
                id=row["id"],
                code=row["code"],
                label=row["label"],
                source=row["source"],
                name=name if isinstance(name, str) else None,
                figure=reading.figure,
                field=reading.field,
                change=reading.change,
                # read off the quote rather than decided here: the vendor says which tier it served, and
                # a configured guess would be a label saying what was hoped for (ADR 0019)
                delayed=_flag(quote, "delayed"),
                last_known=_flag(quote, "last_known"),
                delayed_by_minutes=_minutes(quote),
                # a quote that arrived with no price is its own answer, and a different one from no
                # quote: 0/0 is an empty book, which is the Security not being quoted yet rather than
                # unknown
                error=fault if fault is not None else (_NO_PRICE if reading.figure is None else None),
            )
        )
    return out
