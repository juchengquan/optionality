"""Quotes: one contract's live figures. Mirrors backend/src/domain/quote.ts.

A Quote stays a plain dict on purpose. moomoo sends about a hundred fields and the maths reads eight;
a model would either drop the ones a notebook wants or need changing whenever moomoo adds one.
"""

from datetime import datetime
from typing import Any, NamedTuple

from optionality.js import to_fixed
from optionality.timefmt import display_time, market_time_to_display

type Quote = dict[str, Any]
type ByCode = dict[str, Quote]


class Batch(NamedTuple):
    """What one bounded batch came back with: the quotes, and the codes the Provider does not know.

    `unknown`, not `bad`: the TypeScript's `QuoteBatch` has always called it that, and the two names
    for one concept were a divergence nothing checked (ADR 0017).
    """

    records: list[Quote]
    unknown: list[str]


def round4(value: float) -> float:
    """A points figure rounded for a human: `toFixed(4)`, which ties away from zero."""
    return to_fixed(value, 4)


def display_records(records: list[Quote], display_tz: str, fetched_at: datetime | None) -> ByCode:
    """Index a batch's records by code, with display-tz timestamps stamped on.

    Copies rather than mutates: the service renders its cached records on every dashboard poll, and
    `market_time_to_display` is not idempotent — feeding its own output back in would read the
    offset as part of a new naive time.

    `fetched_at` is the honest "data as-of"; `update_time` is only the last trade, and it arrives
    naive US-Eastern.
    """
    stamped = display_time(fetched_at, display_tz)
    by_code: ByCode = {}
    for raw in records:
        record = dict(raw)
        if record.get("update_time"):
            record["update_time"] = market_time_to_display(str(record["update_time"]), display_tz)
        record["fetched_at"] = stamped
        by_code[str(record.get("code"))] = record
    return by_code


def verify_verdict(codes: list[str], batch: Batch) -> str | None:
    """Why these contracts cannot be trusted to exist, or None.

    Strict on purpose: creation is gated by a live probe and refuses while the Provider is down,
    because a monitor created against a contract that does not exist would quarantine itself on the
    first sweep. BOTH checks, though a code named unknown usually has no record either: a Provider
    that does both at once is contradicting itself, and a gate this strict takes the pessimistic
    reading.
    """
    if batch.unknown:
        return f"contract does not exist: {', '.join(batch.unknown)} — check strike and expiry"
    returned = {r.get("code") for r in batch.records}
    missing = [c for c in codes if c not in returned]
    if missing:
        return f"contract does not exist: {', '.join(missing)} — check strike and expiry"
    return None
