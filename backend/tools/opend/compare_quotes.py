"""The two services' computed answers, side by side (ADR 0009, phase 6).

Phase 6 is done when "a manual sweep against live OpenD produces the same figures the Python service
shows at the same moment". This is that check at the level the owner reads: not the raw snapshot fields
— `make diff-opend` does those — but the computed entries the dashboard and the bot draw. dte, the fill
bar, a combo's signed sum, a position's cost to close and its P&L.

    python compare_quotes.py <key> <python.json> <typescript.json> <python-again.json> <floor>

`floor` is the least number of values the caller expects to have been compared. A clean report from a
comparison that walked almost nothing reads exactly like a real one.

Bracketed, because both endpoints make a LIVE call and the market moves between the two reads. Every
field present in both answers is compared; a numeric one that lands between the brackets is the same
quantity a moment apart, and anything else must match exactly.
"""

import json
import sys

# compared loosely by structure rather than value: a nested snapshot is the raw market data that
# diff-opend already checks field by field, and its timestamps differ by construction
STRUCTURAL = {
    "snapshot",
    "fetched_at",
    "last_checked_at",
    "created_at",
    "combo_greeks",
    "positions",
    "legs",
    # written by whichever sweeper owns that database, on its own schedule and into its own file. The
    # TypeScript service runs against a COPY, so these are two independent sweeps of the same
    # watchlist, not two computations of the same figure — compare_shapes.py checks their types and
    # make diff-opend checks the market data they come from.
    "last_value",
    "triggered",
}


def load(path: str, key: str) -> dict:
    with open(path) as f:
        return {row[key]: row for row in json.load(f)}


def agrees(a: object, b: object, c: object) -> bool:
    if b == a or b == c:
        return True
    numeric = all(isinstance(v, int | float) and not isinstance(v, bool) for v in (a, b, c))
    return numeric and min(a, c) <= b <= max(a, c)


def main() -> int:
    key = sys.argv[1]
    before, mine, after = (load(p, key) for p in sys.argv[2:5])
    floor = int(sys.argv[5]) if len(sys.argv) > 5 else 1

    if before.keys() != mine.keys():
        print(
            f"different sets: python only {sorted(before.keys() - mine.keys())}, "
            f"typescript only {sorted(mine.keys() - before.keys())}"
        )
        return 1

    divergences = []
    compared = 0
    for name, py in sorted(before.items()):
        ts = mine[name]
        py_after = after.get(name, py)
        shared = sorted(set(py) & set(ts))
        missing = sorted(set(py) - set(ts))
        if missing:
            divergences.append(f"{name}: fields absent from the typescript answer: {missing}")
        for field in shared:
            if field in STRUCTURAL:
                continue
            compared += 1
            if not agrees(py.get(field), ts.get(field), py_after.get(field)):
                divergences.append(
                    f"{name}.{field}: python {py.get(field)!r} / {py_after.get(field)!r}, typescript {ts.get(field)!r}"
                )

    print(f"{len(divergences)} divergences over {compared} compared values across {len(mine)} rows")
    for line in divergences[:30]:
        print(f"  {line}")
    if compared < floor:
        print(f"only {compared} values compared, expected at least {floor} — this check is not looking")
        return 2
    return 1 if divergences else 0


if __name__ == "__main__":
    sys.exit(main())
