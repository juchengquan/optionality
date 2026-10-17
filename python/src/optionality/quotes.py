"""Quote batches that survive an unknown contract. Mirrors backend/src/quotes.ts.

moomoo refuses the WHOLE batch when any code in it is unknown, and names the culprit — without its
market prefix. `fetch_resilient` drops what it names and asks again, so one bad contract cannot take
the rest hostage. Any other failure (a dead gateway, a quota) is raised untouched: containment engages
only on the case it can read.
"""

import re
from collections.abc import Callable
from typing import NamedTuple

from optionality.quote import Quote

type QuoteFetcher = Callable[[list[str]], list[Quote]]

_UNKNOWN_CODE = re.compile(r"Unknown stock\.?\s+([A-Z0-9.]+)")


class Batch(NamedTuple):
    records: list[Quote]
    bad: list[str]


def fetch_resilient(codes: list[str], fetch: QuoteFetcher) -> Batch:
    remaining = list(codes)
    bad: list[str] = []
    while remaining:
        try:
            return Batch(fetch(remaining), bad)
        except Exception as err:
            match = _UNKNOWN_CODE.search(str(err))
            if not match:
                raise
            culprit = match.group(1).rstrip(".")
            hits = [c for c in remaining if c == culprit or c.endswith(culprit)]
            if not hits:
                raise  # cannot map the culprit to our codes: a generic failure
            remaining = [c for c in remaining if c not in hits]
            bad.extend(hits)
    return Batch([], bad)


def verify_contracts(codes: list[str], fetch: QuoteFetcher) -> str | None:
    """Why these contracts cannot be trusted to exist, or None. Strict: it refuses while OpenD is down."""
    try:
        records, bad = fetch_resilient(codes, fetch)
    except Exception as err:
        return f"cannot verify contract: OpenD unreachable ({err})"
    if bad:
        return f"contract does not exist: {', '.join(bad)} — check strike and expiry"
    returned = {r.get("code") for r in records}
    missing = [c for c in codes if c not in returned]
    if missing:
        return f"contract does not exist: {', '.join(missing)} — check strike and expiry"
    return None
