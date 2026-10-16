"""Every field the dashboard reads, present in BOTH services with the same type (ADR 0009, phase 8).

Phase 8 types the frontend against the TypeScript backend while the dashboard still talks to the Python
one — the cutover is phase 9. For the window between them the frontend compiles against one service's
shapes and runs against the other's, so a field present in one and absent in the other is a blank cell
in production on a branch whose typecheck passed.

This is deliberately NOT a set comparison. The Python's `snapshot` carries all 143 columns the moomoo
SDK returns, nearly all 'N/A' for an option; the TypeScript one carries the 36 the service consumes
(ADR 0009 phase 6b). Demanding set equality would report 107 differences that are all the same decision.
What matters is the other direction: everything the dashboard asks for, both services answer.

    python compare_shapes.py <endpoint> <python.json> <typescript.json>
"""

import json
import sys

# Every field frontend/src reads, by endpoint. Written out because it is the contract this check is
# about — a reviewer can see exactly what the dashboard depends on, and adding a column to the UI means
# adding a line here.
REQUIRED: dict[str, list[str]] = {
    "quotes": [
        "id",
        "code",
        "field",
        "threshold",
        "direction",
        "compare",
        "triggered",
        "strike_date",
        "dte",
        "fill",
        "scope",
        "positions",
        "cost_to_close",
        "entry",
        "pnl",
        "snapshot",
        # present only on a combo row
        "?legs",
        "?combo_value",
        "?combo_greeks",
        "?error",
    ],
    "quotes.snapshot": [
        "?name",
        "?mid_price",
        "?bid_price",
        "?ask_price",
        "?option_delta",
        "?option_gamma",
        "?option_theta",
        "?option_vega",
        "?option_implied_volatility",
        "?update_time",
        "?fetched_at",
    ],
    # `.id` only: the components take entry.positions whole and submit against the id. The old
    # hand-written interface declared a name nothing read.
    "quotes.positions": ["id"],
    "monitors": [
        "id",
        "code",
        "field",
        "threshold",
        "strike_date",
        "enabled",
        "disabled_reason",
        "scope",
        "positions",
    ],
    "monitors.positions": ["id"],
    "health": ["db", "opend", "queue_depth", "monitor", "settings"],
    "health.monitor": ["last_sweep_at", "alarms", "fetched_at"],
    "health.monitor.alarms": ["label", "bad"],
    "health.settings": ["sweep_seconds", "expired_retention_days"],
    # not read by the dashboard; compared so the cutover does not silently reshape it
    "positions/values": ["id", "name", "cost_to_close", "pnl", "contract_size", "greeks"],
}


def kind(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def rows(payload: object) -> list[dict]:
    """A list endpoint's rows, or the single object a scalar endpoint returns."""
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    return [payload] if isinstance(payload, dict) else []


def check(spec: str, a: object, b: object, out: list[str], counted: list[int]) -> None:
    required = REQUIRED.get(spec)
    if required is None:
        return
    for py_row, ts_row in zip(rows(a), rows(b), strict=False):
        for name in required:
            optional = name.startswith("?")
            field = name.removeprefix("?")
            in_py, in_ts = field in py_row, field in ts_row
            if not in_py and not in_ts:
                continue  # a combo-only field on a single-leg row, on both sides
            if in_py != in_ts:
                if optional:
                    continue  # one row happens to carry it and the other does not
                out.append(f"{spec}.{field}: python {in_py}, typescript {in_ts}")
                continue
            counted[0] += 1
            ka, kb = kind(py_row[field]), kind(ts_row[field])
            # a nullable field set on one side and not the other is not a shape difference
            if ka != kb and "null" not in (ka, kb):
                out.append(f"{spec}.{field}: python {ka}, typescript {kb}")
                continue
            nested = f"{spec}.{field}"
            if nested in REQUIRED:
                check(nested, py_row[field], ts_row[field], out, counted)


def main() -> int:
    endpoint = sys.argv[1]
    with open(sys.argv[2]) as f:
        a = json.load(f)
    with open(sys.argv[3]) as f:
        b = json.load(f)

    out: list[str] = []
    counted = [0]
    check(endpoint, a, b, out, counted)
    print(f"{len(out)} differences over {counted[0]} required fields")
    for line in out[:30]:
        print(f"  {line}")
    if counted[0] == 0:
        print("no required fields were compared — this check is not looking")
        return 2
    return 1 if out else 0


if __name__ == "__main__":
    sys.exit(main())
