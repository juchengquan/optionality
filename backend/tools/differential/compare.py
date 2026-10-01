"""Compare two runs of the same domain, one Python and one TypeScript.

Exact, never approximate: both sides do the same arithmetic in the same order on the same doubles,
so a bit-for-bit match is the only honest pass. 0.47499999999999987 against 0.475 is a divergence.

Walks whatever shape it is given — a list of generated cases or the live run's single object — and
counts the LEAVES it compared. That count is the check on the check: a comparison that reports two
compared values where thousands were expected is not passing, it is not looking.
"""

import json
import math
import sys

compared = 0


def differs(x, y, path: str) -> list[str]:
    global compared
    if isinstance(x, list) and isinstance(y, list):
        if len(x) != len(y):
            return [f"{path}: length {len(x)} vs {len(y)}"]
        return [d for i, (u, v) in enumerate(zip(x, y, strict=True)) for d in differs(u, v, f"{path}[{i}]")]
    if isinstance(x, dict) and isinstance(y, dict):
        if x.keys() != y.keys():
            return [f"{path}: keys {sorted(x)} vs {sorted(y)}"]
        return [d for k in x for d in differs(x[k], y[k], f"{path}.{k}")]
    if type(x) is not type(y) and not (isinstance(x, int | float) and isinstance(y, int | float)):
        return [f"{path}: python={x!r} ts={y!r} (different types)"]
    compared += 1
    if x is None or y is None:
        return [] if x is y else [f"{path}: python={x!r} ts={y!r}"]
    if isinstance(x, int | float) and not isinstance(x, bool):
        if x == y or (math.isnan(x) and math.isnan(y)):
            return []
        return [f"{path}: python={x!r} ts={y!r}"]
    return [] if x == y else [f"{path}: python={x!r} ts={y!r}"]


def main() -> int:
    with open(sys.argv[1]) as f:
        a = json.load(f)
    with open(sys.argv[2]) as f:
        b = json.load(f)
    # the minimum the caller expects to have been looked at, so a comparison that walks almost
    # nothing fails loudly instead of reporting a clean run
    floor = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    bad = differs(a, b, "")
    print(f"{len(bad)} divergences over {compared} compared values")
    for d in bad[:20]:
        print("  ", d)
    if len(bad) > 20:
        print(f"   ... and {len(bad) - 20} more")
    if compared < floor:
        print(f"compared only {compared} values, expected at least {floor} — the comparison is not looking")
        return 2
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
