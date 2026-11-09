# optionality

SPX options maths and moomoo access for notebooks, ported from the service's TypeScript and checked
against it by the golden cases in `../testdata/golden/` (ADR 0014). See the repository's CLAUDE.md.

```python
from optionality import api
from optionality.opend import OpenD
from optionality.position import cost_to_close, position_leg_codes

held = api.positions()  # your Positions, from the live service
with OpenD() as od:  # live quotes from OpenD (the `opend` extra)
    codes = [c for p in held for c in position_leg_codes(p)]
    records, _ = od.quotes(codes)
by_code = {r["code"]: r for r in records}
[cost_to_close(p, by_code) for p in held]
```

`alarm` and `lifecycle` answer what the next sweep would DO, without a sweep running — whether a
reading alarms and in what words, whether a silent rule is about to be quarantined, what becomes of
an expired one. The sentences are the ones the service sends, compared exactly (ADR 0017).

`api.references()` gives every Reference with its live figure, including the vendor's own freshness
claim — Yahoo states minutes, IBKR states only that it is delayed, moomoo states nothing (ADR
0019). It is the one route that cannot fail: a vendor that is wholly down leaves each row a figure
of `None` with its own `error`, so you read the reason rather than catch an exception (ADR 0018).

There is deliberately no `api.quotes()`. `GET /quotes` takes no parameters — it is "live quotes for
the whole watchlist" — so it cannot price a contract the service does not already watch, which is
the bounded-call invariant working as intended. For an arbitrary code you want a Provider:
`optionality.opend` today.

`api` reads `http://127.0.0.1:31415` by default; set `OPTIONALITY_API=https://<host>/opt/api` to use
the service from elsewhere on the tailnet.

## Two halves, and the line between them

Everything above `research/` is a port: it mirrors a `backend/src/domain/` module or a vendor client
and is held there — by the golden cases for the maths and the decisions, compared exactly, and by
recorded fixtures for the providers. A wrong answer turns `make test` red.

`optionality.research` is the other half. Chains, historical bars, anything the service never
fetches: it mirrors no TypeScript, so there is nothing to compare it against and **nothing checks
whether it is right**. Its tests say a response was parsed as intended, not that the intention was.
Treat a figure out of it as you would your own cell.

```python
from optionality.research.yahoo import daily_bars, expirations, option_chain  # the `yahoo` extra
```

The line is structural: `tests/test_standalone.py` refuses an import of `optionality.research` from
any pure module and from any port, so the cased half can never come to depend on the uncased one.
The other direction is free, and is what the subpackage is for.

## Installing

A pinned ref, never a path into a working tree (ADR 0016) — an editable install would serve this
notebook whatever half-ported state that tree happens to be in:

```
uv add "optionality @ git+https://github.com/juchengquan/optionality.git@py-2026.11.9#subdirectory=python"
```

The version says WHEN it was cut; `optionality._ported.GOLDEN_CASES` says WHAT it agrees with. One
cell tells you whether it is still current:

```python
print(api.agrees())  # "this port agrees with the service (<fingerprint>)"
```

The fingerprint itself is deliberately not written out here. It changes with every domain commit,
nothing checks this file against it, and it has gone stale twice — a figure in a document that no
gate can contradict is worse than no figure, because a reader compares theirs against it.

It never runs on import and never raises: with no service reachable it says so and the maths still
works, which is the whole point of the package (ADR 0014).

That last sentence is checked rather than promised. `tests/test_standalone.py` holds it two ways,
because they fail differently: a static pass reads all fourteen pure modules and names any line
reaching the SDK, the network or one of the three impure modules — including an import nested
inside a function — and a subprocess then imports all fourteen with `moomoo` made unimportable and
`OPTIONALITY_API` unset, and computes with them. Only the second can see an import-time dependency
no pattern would list, such as the zone data `timefmt` needs, which is present on a developer's
machine and absent from a slim container. It was worth writing: `moomoo` is installed in the venv
the suite runs in, so until now a pure module reaching for it would have passed every test.

