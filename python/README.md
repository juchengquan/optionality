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

`api` reads `http://127.0.0.1:31415` by default; set `OPTIONALITY_API=https://<host>/opt/api` to use
the service from elsewhere on the tailnet.

## Installing

A pinned ref, never a path into a working tree (ADR 0016) — an editable install would serve this
notebook whatever half-ported state that tree happens to be in:

```
uv add "optionality @ git+https://github.com/juchengquan/optionality.git@py-2026.11.1#subdirectory=python"
```

The version says WHEN it was cut; `optionality._ported.GOLDEN_CASES` says WHAT it agrees with. One
cell tells you whether it is still current:

```python
print(api.agrees())  # "this port agrees with the service (7ed1a1af…)"
```

It never runs on import and never raises: with no service reachable it says so and the maths still
works, which is the whole point of the package (ADR 0014).

