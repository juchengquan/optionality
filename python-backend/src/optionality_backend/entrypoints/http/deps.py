"""Everything a route needs, in one value (ADR 0009, phase 5). Port of
backend/src/entrypoints/http/deps.ts.

Passed into each router factory as a closure rather than carried on the framework's request state: a
closure is checked at the point of construction, and FastAPI's `Depends` would make every handler
declare what this hands it whole.

**Where the Python differs, and why.** `sources` is `references.Sources`, a `Mapping` of name to fetcher
(`Readonly<Record<string, QuoteFetcher>>`), and the fetchers are the backend's awaitable
`ports.QuoteFetcher`, never the library's synchronous one.
"""

import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from ...env import Settings
from ...ports import ProviderClient, SweeperPort
from ...references import Sources


@dataclass(frozen=True)
class Deps:
    settings: Settings
    db: sqlite3.Connection
    #: Injectable so that a test can state the time rather than wait for it. An AWARE datetime.
    now: Callable[[], datetime]
    sweeper: SweeperPort
    #: Where market data comes from: its name and state for `/health`, and the one bounded call the
    #: creation probes and the live routes make (ADR 0015).
    #:
    #: A test must never reach a real vendor — the moomoo SDK blocks indefinitely on a dead port, so a
    #: missing fake looks like a hung suite — and the harness supplies a fake Provider.
    provider: ProviderClient
    #: Every vendor this build can reach, by name — the Provider among them (ADR 0019).
    #:
    #: A Reference is the one figure allowed a source the rest of the service does not use: nothing
    #: alarms on it and nothing is derived from it, so the one-Provider rule does not reach it. The
    #: vendor door assembles this, which is also what guarantees the Provider's own Reference rows are
    #: served by the same client the alarms read from.
    sources: Sources
    #: The id a write mints, injectable for the same reason as `now`: a door scenario (ADR 0021)
    #: records the rows a request wrote, and a random id there could only be scrubbed after the fact.
    #: None, as it is in `__main__`, mints a uuid (`db.values.new_id`).
    new_id: Callable[[], str] | None = None
