"""Building the app for a test. The Python's half of backend/testing/harness.ts.

It keeps that harness's most important property: a test can NEVER reach a real vendor, because the
moomoo SDK blocks indefinitely on a dead port and a missing fake looks like a hung suite (CLAUDE.md).
The sweeper and the Provider's probe are faked for the same reason.

Outside `src/`, as the TypeScript's is outside its `src/`: everything here is correct in a test and a
lie in production — a Provider that prices every code it is asked for, a sweeper that has never swept,
a bearer token of "tok".

A request goes through `httpx2.ASGITransport` ON THE TEST'S OWN LOOP, which is why the tests that use
this are `async def`: the service runs on one asyncio loop (ADR 0021, Decision 6) and its database
connection refuses any other thread. FastAPI's `TestClient` runs the app on a loop in a thread of its
own, and the first query fails there with sqlite3's "objects created in a thread can only be used in
that same thread" — measured, and the reason this is not built on it.

**Partly ported**: what the routes ported so far need. `fakeFetcher`, `poisonable` and
`pricedFetcher` arrive with the routes whose tests use them. `json` is `json_body`: under its own name
it would shadow the standard library's module in every test that imports both.
"""

import json
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx2
from fastapi import FastAPI
from optionality.quote import Batch, Quote

from optionality_backend.db.open import create_database
from optionality_backend.entrypoints.http import Deps, create_app
from optionality_backend.env import Settings, settings_for
from optionality_backend.ports import AlarmState, QuoteFetcher

TOKEN = "tok"

#: The harness's clock, fixed. A test that invents a date from the REAL clock while the app reads this
#: one is a test that breaks at midnight: derive dates from here and the gap cannot open.
NOW = datetime(2026, 10, 2, 5, 26, 6, 299000, tzinfo=UTC)


def days_from_now(n: int) -> str:
    """A date `n` days from the harness's clock, as YYYY-MM-DD."""
    return (NOW + timedelta(days=n)).date().isoformat()


class FakeSweeper:
    """A sweeper that has never swept, which is what a freshly started service looks like."""

    def __init__(self) -> None:
        self.sweep_at: datetime | None = None
        self.fetch_at: datetime | None = None
        #: None, as a service that has not asked yet: /health then falls back to the port probe
        self.fetch_ok: bool | None = None
        self.ok = True
        self.failures = 0
        self.label = "watching"
        self.bad = False

    def last_sweep_at(self) -> datetime | None:
        return self.sweep_at

    def last_fetch_at(self) -> datetime | None:
        return self.fetch_at

    def last_fetch_ok(self) -> bool | None:
        return self.fetch_ok

    def last_sweep_ok(self) -> bool:
        return self.ok

    def consecutive_failures(self) -> int:
        return self.failures

    def alarm_state(self) -> AlarmState:
        return AlarmState(label=self.label, bad=self.bad)


def priced(records: list[Quote]) -> Batch:
    """A batch in which every code was priced — what a fake Provider answers unless the test is about
    one that was not."""
    return Batch(records=records, unknown=[])


async def echo_fetcher(codes: list[str]) -> Batch:
    """The permissive default: every requested contract "exists"."""
    return Batch(records=[{"code": c} for c in codes], unknown=[])


def quoting(by_code: dict[str, Quote]) -> QuoteFetcher:
    """A fetcher that returns the given figures per code, and nothing for a code it does not know."""

    async def fetch(codes: list[str]) -> Batch:
        return priced([{"code": c, **by_code[c]} for c in codes if c in by_code])

    return fetch


@dataclass
class FakeProvider:
    name: str
    fetch_quotes: QuoteFetcher
    answers: bool

    async def reachable(self) -> bool:
        return self.answers

    def close(self) -> None:
        """Nothing to hang up."""


@dataclass
class Harness:
    app: FastAPI
    db: sqlite3.Connection
    settings: Settings
    sweeper: FakeSweeper
    folder: Path
    #: what the clock returns. Set it to state the time rather than wait for it.
    clock: dict[str, datetime] = field(default_factory=lambda: {"now": NOW})

    @property
    def now(self) -> datetime:
        return self.clock["now"]

    @now.setter
    def now(self, value: datetime) -> None:
        self.clock["now"] = value

    async def call(
        self,
        path: str,
        *,
        method: str = "GET",
        anonymous: bool = False,
        headers: dict[str, str] | None = None,
        content: str | None = None,
    ) -> httpx2.Response:
        """A request against the app, with the bearer token unless `anonymous` is passed."""
        sent = {**({} if anonymous else {"Authorization": f"Bearer {TOKEN}"}), **(headers or {})}
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=self.app), base_url="http://test") as c:
            return await c.request(method, path, headers=sent, content=content)

    def close(self) -> None:
        # a test may have closed it on purpose, to see what /health says when the database is gone
        self.db.close()
        shutil.rmtree(self.folder, ignore_errors=True)


def harness(
    *,
    settings: dict[str, Any] | None = None,
    opend: bool = False,
    provider_name: str = "moomoo",
    fetch_quotes: QuoteFetcher | None = None,
    reference_sources: dict[str, QuoteFetcher] | None = None,
) -> Harness:
    folder = Path(tempfile.mkdtemp(prefix="optionality-http-"))
    db = create_database(folder / "test.db")
    s = settings_for(
        **{
            "api_token": TOKEN,
            # the owner's own zone, so that a UTC-only test cannot pass by coincidence
            "display_tz": "Asia/Singapore",
            # the dashboard refresh floor; low so tests can pick any interval
            "monitor_interval_seconds": 5,
            **(settings or {}),
        }
    )
    sweeper = FakeSweeper()
    provider = FakeProvider(name=provider_name, fetch_quotes=fetch_quotes or echo_fetcher, answers=opend)
    clock = {"now": NOW}
    deps = Deps(
        settings=s,
        db=db,
        now=lambda: clock["now"],
        sweeper=sweeper,
        provider=provider,
        # what the vendor door assembles in the service: every reachable vendor by name, the Provider
        # among them under its own
        sources={provider.name: provider.fetch_quotes, **(reference_sources or {})},
    )
    return Harness(app=create_app(deps), db=db, settings=s, sweeper=sweeper, folder=folder, clock=clock)


def json_body(payload: Any) -> dict[str, Any]:
    """POST JSON, the shape nearly every write test needs: `h.call(path, **json_body({...}))`."""
    return {
        "method": "POST",
        "content": json.dumps(payload, separators=(",", ":"), ensure_ascii=False),
        "headers": {"Content-Type": "application/json"},
    }
