"""Compare the TypeScript OpenD client against the Python SDK, field by field.

Bracketed: the Python is read before AND after the TypeScript, because the market moves while we
look at it. A value that matches either read is drift; one that matches neither is a divergence.

Only the fields the service consumes are compared, and that list is the point of this file — it is
written out here so a reviewer can see exactly what the mapping is claimed to cover. The Python SDK
returns 143 columns, nearly all of them 'N/A' for an option; transcribing one nothing reads would be
unverified either way.
"""

import json
import sys

# every field the dashboard's columns, the bot's tables or the domain's maths reads
CONSUMED = [
    "code",
    "name",
    "update_time",
    "last_price",
    "bid_price",
    "ask_price",
    "mid_price",
    "volume",
    "turnover",
    "lot_size",
    "suspension",
    "open_price",
    "high_price",
    "low_price",
    "prev_close_price",
    "ask_vol",
    "bid_vol",
    "amplitude",
    "avg_price",
    "bid_ask_ratio",
    "turnover_rate",
    "option_type",
    "stock_owner",
    "option_strike_price",
    "option_contract_size",
    "option_contract_multiplier",
    "option_open_interest",
    "option_implied_volatility",
    "option_premium",
    "option_delta",
    "option_gamma",
    "option_vega",
    "option_theta",
    "option_rho",
    "option_expiry_date_distance",
    "option_area_type",
]

# fields that move with the market, and so are compared against the bracket rather than for equality
VOLATILE = {
    "update_time",
    "last_price",
    "bid_price",
    "ask_price",
    "mid_price",
    "volume",
    "turnover",
    "ask_vol",
    "bid_vol",
    "amplitude",
    "avg_price",
    "bid_ask_ratio",
    "turnover_rate",
    "high_price",
    "low_price",
    "option_implied_volatility",
    "option_premium",
    "option_delta",
    "option_gamma",
    "option_vega",
    "option_theta",
    "option_rho",
    "option_open_interest",
}


def load(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def main() -> int:
    before, ts, after = (load(p) for p in sys.argv[1:4])
    window = after["at"] + after["took"] - before["at"]
    print(f"the three reads span {window:.2f}s")

    divergences = []
    compared = 0
    drifted = 0
    for code, py_before in sorted(before["by_code"].items()):
        py_after = after["by_code"].get(code, {})
        mine = ts["by_code"].get(code)
        if mine is None:
            divergences.append(f"{code}: absent from the TypeScript read entirely")
            continue
        for field in CONSUMED:
            compared += 1
            a, b, m = py_before.get(field), py_after.get(field), mine.get(field)
            if m == a or m == b:
                if a != b:
                    drifted += 1
                continue
            # between the two brackets is still the same quantity, just a moment apart
            bracketed = all(isinstance(v, int | float) for v in (a, b, m)) and min(a, b) <= m <= max(a, b)
            if field in VOLATILE and bracketed:
                drifted += 1
                continue
            divergences.append(f"{code}.{field}: python {a!r} / {b!r}, typescript {m!r}")

    print(
        f"{len(divergences)} divergences over {compared} compared values "
        f"({drifted} moved with the market and matched a bracket)"
    )
    for line in divergences[:30]:
        print(f"  {line}")
    if compared < 100:
        print(f"only {compared} values compared — this check is not looking")
        return 2
    return 1 if divergences else 0


if __name__ == "__main__":
    sys.exit(main())
