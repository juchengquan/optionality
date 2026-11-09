"""The market-data port's contract, and the one thing above it that is not pure.

Mirrors typescript/src/quotes.ts. A Provider is anything that answers `QuoteFetcher`: it returns the
records it has AND the codes it does not know, and it raises only when it could not answer at all.
A raise is an outage, and an outage must never read as a watchlist full of unknown contracts.

`fetch_resilient` is gone (ADR 0017). It dropped a code moomoo named in its error prose and asked
again — above the port, which is where the TypeScript USED to do it. #168 moved that into the
provider on the reasoning that moomoo's grammar is moomoo's business, and ADR 0015 made the vendor
one Provider among others; this module kept the old shape for three weeks because nothing cased it.
`opend.OpenD.quotes` owns the loop now, as `opend/client.ts` does.

The verdict itself is `quote.verify_verdict`, which is cased. What is left here is the fetch and the
catch, which cannot be.
"""

from collections.abc import Callable

from optionality.quote import Batch, verify_verdict

type QuoteFetcher = Callable[[list[str]], Batch]


def verify_contracts(codes: list[str], fetch: QuoteFetcher) -> str | None:
    """Why these contracts cannot be trusted to exist, or None. Strict: it refuses while OpenD is down."""
    try:
        batch = fetch(codes)
    except Exception as err:
        return f"cannot verify contract: OpenD unreachable ({err})"
    return verify_verdict(codes, batch)
