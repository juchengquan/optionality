"""The codes the live service actually watches: every monitor's legs and every position's legs.

Read from the database rather than invented, because the mapping has to be right for the contracts
the owner holds, and an SPX weekly carries fields a made-up code would not.
"""

import json
import sys

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from optionality.service.models import Monitor, Position
from optionality.service.monitor import monitor_leg_codes
from optionality.service.position import position_leg_codes
from optionality.service.settings import Settings


def main() -> int:
    settings = Settings.from_env()
    engine = create_engine(f"sqlite:///{settings.db_path}")
    with Session(engine) as session:
        codes = {c for m in session.scalars(select(Monitor)) for c in monitor_leg_codes(m)}
        codes |= {c for p in session.scalars(select(Position)) for c in position_leg_codes(p)}
    with open(sys.argv[1], "w") as f:
        json.dump(sorted(codes), f)
    print(f"{len(codes)} codes from the live watchlist", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
