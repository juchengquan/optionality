"""Prove the Python can still open the copied database (ADR 0009, phase 4).

Keeping SQLAlchemy's storage formats was a deliberate choice, and this is the thing it buys: if
the TypeScript service misbehaves after a cutover with no side-by-side run to fall back on, the
Python can be pointed at this file and started. A claim like that is worth nothing unverified.

Read-only. Takes the copy's path, compares what SQLAlchemy reads out of it against what it reads
out of the original, and checks Alembic considers it already at head.
"""

import subprocess
import sys

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from optionality.service.models import ConfigDoc, Monitor, Position, Report, Run, Schedule

MODELS = (ConfigDoc, Schedule, Run, Monitor, Position, Report)


def read(path: str) -> dict:
    """Every row of every model, as SQLAlchemy's Python objects rather than as raw columns."""
    engine = create_engine(f"sqlite:///{path}")
    out: dict = {}
    with Session(engine) as session:
        for model in MODELS:
            rows = session.scalars(select(model)).all()
            key = model.__tablename__
            out[key] = [{c.name: getattr(row, c.name) for c in model.__table__.columns} for row in rows]
            out[key].sort(key=lambda r: str(sorted(r.items(), key=lambda kv: kv[0])))
    engine.dispose()
    return out


def main() -> int:
    source, target = sys.argv[1], sys.argv[2]
    a, b = read(source), read(target)

    compared = 0
    bad = []
    for table in a:
        if len(a[table]) != len(b[table]):
            bad.append(f"{table}: {len(a[table])} rows in source, {len(b[table])} in target")
            continue
        for left, right in zip(a[table], b[table], strict=True):
            for column, value in left.items():
                compared += 1
                other = right[column]
                # type as well as value: a datetime read back as a string would mean SQLAlchemy
                # could not parse what we wrote, which is the whole question here
                if type(value) is not type(other) or value != other:
                    bad.append(
                        f"{table}.{column}: {value!r} ({type(value).__name__}) vs {other!r} ({type(other).__name__})"
                    )

    print(f"SQLAlchemy read {compared} field values out of the copy")
    for line in bad[:20]:
        print(f"  {line}")
    if bad:
        print(f"{len(bad)} DIVERGENCES — the Python does not read the copy the same way")
        return 1
    if compared < 100:
        print(f"only {compared} values compared — this check is not looking")
        return 2

    # alembic must consider the file already migrated, or a rollback would try to replay every
    # migration against data that is already in its final shape
    proc = subprocess.run(
        ["uv", "run", "alembic", "current"],
        env={**__import__("os").environ, "OPTIONALITY_DB_PATH": target},
        capture_output=True,
        text=True,
        check=False,
    )
    current = proc.stdout.strip().splitlines()
    stamp = next((line for line in current if "head" in line or line), "")
    print(f"alembic current: {stamp or '(nothing)'}")
    if "(head)" not in stamp:
        print("alembic does not consider the copy to be at head")
        return 3

    print("the Python reads the copy identically, and alembic sees it at head")
    return 0


if __name__ == "__main__":
    sys.exit(main())
