"""Run the Python domain over the cases. Keys are built with Python's own build_spx_code, so a
divergence in code building shows up as a missing quote rather than being papered over."""

import json
import sys
from datetime import date, datetime
from types import SimpleNamespace

from optionality.apis.aux import build_spx_code
from optionality.service import monitor as M
from optionality.service import position as P
from optionality.service.timefmt import MARKET_TZ, display_time, market_time_to_display

with open(sys.argv[1]) as f:
    loaded = json.load(f)
cases, clock, display = loaded["cases"], loaded["clock"], loaded["display"]
out = []
for case in cases:
    ps = [SimpleNamespace(**p) for p in case["positions"]]
    by_code = {build_spx_code(q["strike_date"], q["option_type"], q["strike"]): q["quote"] for q in case["quotes"]}
    scope = case["scope"]
    # the codes a Monitor watches, built with THIS side's builder. 9999 is held by nothing.
    watched = [
        build_spx_code(ps[pi].strike_date, ps[pi].legs[li]["option_type"], ps[pi].legs[li]["strike"])
        for pi, li in case["contract_picks"]
    ]
    if case["stranger"]:
        watched.append(build_spx_code(ps[0].strike_date, "CALL", 9999))
    found, holding_scope = P.positions_holding(ps, watched)
    monitors = []
    for mon in case["monitors"]:
        m = SimpleNamespace(**mon, code=build_spx_code(mon["strike_date"], mon["option_type"], mon["strike"]))
        value = M.monitor_value(m, by_code)
        # the breach rule, lifted verbatim from sweep() so the harness cannot drift from it
        if value is None:
            breached = None
        else:
            above = m.direction != "below"
            metric = value if m.compare == "signed" else abs(value)
            breached = metric >= m.threshold if above else metric <= m.threshold
        monitors.append(
            {
                "codes": M.monitor_leg_codes(m),
                "value": value,
                "field_error": M.combo_field_error(m.field),
                "sums": [M.combo_field_sum(m, by_code, f) for f in (*M.COMBO_GREEK_FIELDS, "option_implied_volatility")]
                if m.legs
                else None,
                "fill": M.threshold_fill(value, m.threshold, m.direction, m.compare),
                "breached": breached,
            }
        )
    row = {
        "monitors": monitors,
        "watched": watched,
        "holding": [sorted(found), holding_scope],
        "codes": [P.position_leg_codes(p, scope) for p in ps],
        "ctc": [P.cost_to_close(p, by_code, scope) for p in ps],
        "greeks": [[P.position_greek(p, by_code, f, scope) for f in P.POSITION_GREEK_FIELDS] for p in ps],
        "size": P.contract_size(by_code),
        "pnl": [P.position_pnl(p, by_code) for p in ps],
        "comb_ctc": P.combined_cost_to_close(ps, by_code, scope),
        "comb_entry": P.combined_entry(ps),
        "comb_pnl": P.combined_pnl(ps, by_code),
        "comb_greek": [P.combined_greek(ps, by_code, f, scope) for f in P.POSITION_GREEK_FIELDS],
    }
    out.append(row)
# days_to_expiry's own line, with the instant injected instead of read from the clock:
# datetime.now(MARKET_TZ).date() is instant.astimezone(MARKET_TZ).date()
dte = [
    [(date.fromisoformat(d) - datetime.fromisoformat(i).astimezone(MARKET_TZ).date()).days for d in clock["dates"]]
    for i in clock["instants"]
]

display_out = {
    "display_time": [
        [display_time(datetime.fromisoformat(i), z) for i in display["instants"]] for z in display["zones"]
    ],
    "market_time": [[market_time_to_display(t, z) for t in display["market_times"]] for z in display["zones"]],
}

with open(sys.argv[2], "w") as f:
    json.dump({"cases": out, "dte": dte, "display": display_out}, f)
print(f"python: {len(out)} rows")
