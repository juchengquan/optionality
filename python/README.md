# optionality

SPX options maths and moomoo access for notebooks, ported from the service's TypeScript and checked
against it by the golden cases in `../testdata/golden/` (ADR 0014). See the repository's CLAUDE.md.

```python
from optionality import api
from optionality.opend import OpenD
from optionality.position import cost_to_close, position_leg_codes

held = api.positions()                      # your Positions, from the live service
with OpenD() as od:                         # live quotes from OpenD (the `opend` extra)
    codes = [c for p in held for c in position_leg_codes(p)]
    records, _ = od.quotes(codes)
by_code = {r["code"]: r for r in records}
[cost_to_close(p, by_code) for p in held]
```

`api` reads `http://127.0.0.1:31415` by default; set `OPTIONALITY_API=https://<host>/opt/api` to use
the service from elsewhere on the tailnet.

