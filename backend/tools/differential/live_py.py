"""Differential against the owner's real positions and one live quote set.

One process, one fetch: the quotes and the Python figures come from the SAME instant, which is
what phase 0 got wrong when it compared a WebSocket read against a 30-second-old TCP baseline and
read drift as disagreement. Read-only — nothing here writes to the DB or to OpenD.
"""

import json
import sys

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session as OrmSession

from optionality.service import position as P
from optionality.service.models import Position
from optionality.service.monitor import fetch_resilient
from optionality.service.settings import Settings

settings = Settings.from_env()
engine = create_engine(f"sqlite:///{settings.db_path}")
with OrmSession(engine) as s:
    rows = s.scalars(select(Position)).all()
    ps = [
        {
            "id": r.id,
            "name": r.name,
            "strike_date": r.strike_date,
            "contracts": r.contracts,
            "entry": r.entry,
            "legs": r.legs,
            "strategy": r.strategy,
        }
        for r in rows
    ]

codes = sorted({c for r in rows for c in P.position_leg_codes(r)})
print(f"{len(ps)} positions, {len(codes)} distinct legs", file=sys.stderr)
records, bad = fetch_resilient(codes, settings)
if bad:
    print(f"unknown codes dropped: {bad}", file=sys.stderr)
by_code = {r.get("code"): r for r in records}

figures = []
for r in rows:
    figures.append(
        {
            "id": r.id,
            "codes": P.position_leg_codes(r),
            "ctc": P.cost_to_close(r, by_code),
            "pnl": P.position_pnl(r, by_code),
            "size": P.contract_size(by_code),
            "greeks": {f: P.position_greek(r, by_code, f) for f in P.POSITION_GREEK_FIELDS},
            "calls_ctc": P.cost_to_close(r, by_code, "calls"),
            "puts_ctc": P.cost_to_close(r, by_code, "puts"),
        }
    )
combined = {
    "ctc": P.combined_cost_to_close(rows, by_code),
    "entry": P.combined_entry(rows),
    "pnl": P.combined_pnl(rows, by_code),
    "greeks": {f: P.combined_greek(rows, by_code, f) for f in P.POSITION_GREEK_FIELDS},
}
# the inputs go to their own file so the comparison is over the FIGURES alone — passing the
# inputs through both sides would pad the count with values that are equal by construction
with open(sys.argv[1], "w") as f:
    json.dump({"positions": ps, "by_code": by_code}, f, default=str)
with open(sys.argv[2], "w") as f:
    json.dump({"figures": figures, "combined": combined}, f)
print(f"wrote {len(figures)} position figures", file=sys.stderr)
