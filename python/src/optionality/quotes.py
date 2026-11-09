"""The market-data port's contract, and the one thing above it that is not pure.

Mirrors typescript/src/quotes.ts. A Provider is anything that answers `QuoteFetcher`: it returns the
records it has AND the codes it does not know, and it raises only when it could not answer at all.
A raise is an outage, and an outage must never read as a watchlist full of unknown contracts.

`fetch_resilient` is gone (ADR 0017). It dropped a code moomoo named in its error prose and asked
again — above the port, which is where the TypeScript USED to do it. #168 moved that into the
provider on the reasoning that moomoo's grammar is moomoo's business, and ADR 0015 made the vendor
one Provider among others; this module kept the old shape for three weeks because nothing cased it.
`opend.OpenD.quotes` owns the loop now, as `opend/client.ts` does.

The verdicts are `quote.verify_verdict` and `quote.unverifiable_verdict`, both cased. What is left
here is the fetch and the catch, which cannot be.
"""

from collections.abc import Callable

from optionality.quote import Batch, unverifiable_verdict, verify_verdict

type QuoteFetcher = Callable[[list[str]], Batch]


def verify_contracts(codes: list[str], fetch: QuoteFetcher) -> str | None:
    """Why these contracts cannot be trusted to exist, or None.

    Strict: it refuses while the Provider is down. Both verdicts are `quote`'s and cased: a raise and an
    answer are two different refusals, and the raised one used to claim an outage, "OpenD unreachable",
    about a Provider that had answered perfectly well and declined the security (ADR 0018). This
    function kept that sentence after the verdict replacing it was ported, because a case calls the
    verdict and never this catch; `tests/test_quotes.py` holds the catch.
    """
    try:
        batch = fetch(codes)
    except Exception as err:
        return unverifiable_verdict(str(err))
    # everything but the fetch and the catch is `quote.verify_verdict`, which is cased
    return verify_verdict(codes, batch)
