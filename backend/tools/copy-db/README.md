# Copying the database

ADR 0009 chose a **fresh schema and a scripted copy** over reusing the Python's file. The schema
lives in `backend/src/db/schema.sql`; this is the copy.

```sh
make copy-db                      # -> data/optionality-next.db, then checks the Python can read it
make copy-db NEXT_DB=/tmp/x.db    # somewhere else
```

24 rows is small enough to verify **completely** rather than by sampling — a luxury that will not
exist again, so it is spent here rather than saved. Nothing is sampled, nothing is spot-checked:
every field of every row of every table.

## It snapshots before it copies

The service may be running, and the sweeper rewrites `last_value` and `last_checked_at` on every
monitor on every sweep. The first version copied from the live file and then verified against it,
which compares a snapshot against a moving target: it reported 13 divergences, all of them the
sweeper doing its job two minutes later.

That is the same mistake phase 0 made — a WebSocket read judged against a TCP baseline half a
minute older — so the fix is the same. `copy.ts` takes a consistent snapshot through SQLite's
online backup, and the copy, the verification and the Python readback all refer to **that**. The
snapshot is left next to the target as `<target>.snapshot`.

The live file is opened read-only, and the script refuses to overwrite an existing target.

## Two verifications, because they see different things

**`verify.ts`** (TypeScript, runs inside `copy.ts`) compares raw stored values — 211 of them —
with `Object.is`, so type counts as well as value. This is the primary check: it is the only one
that sees a `1` that became `"1"`, or JSON whose spacing changed.

**`python_can_read.py`** opens the copy with SQLAlchemy and compares what the Python *means* by
each field — 194 values — then runs `alembic current` against it. It answers a different question:
not "are the bytes the same" but "can the Python still use this file".

That question matters because keeping SQLAlchemy's storage formats was a deliberate decision, and
this is what it buys: with no side-by-side run and no recording week, pointing the Python back at
this file is the only rollback there is. A claim like that is worth nothing unverified.

The two counts differ by 17 and that is not a discrepancy: `monitor_positions` (8 rows × 2 fields)
and `alembic_version` (1) are not mapped models, so SQLAlchemy never sees them. The TypeScript
check covers everything.

Their blind spots are genuinely different. Storing `'yes'` in `enabled` is caught by `verify.ts`
on all seven monitors and **missed entirely** by the Python check, because SQLAlchemy maps both `1`
and `'yes'` to `True`. Run both.

## Exit codes

`copy.ts` — 1 divergences, 2 fewer than 100 values compared (a clean report from a comparison that
walked nothing reads exactly like a real one).
`python_can_read.py` — 1 divergences, 2 too few values, 3 alembic does not see the file at head.

## Verified by breaking it

Every check here was confirmed against the thing it guards: a datetime that lost its microseconds,
a number that became text, a float that moved in its last place, JSON whose spacing changed, a NULL
that became an empty string, a missing row, an extra row, a row under a different key, a wrong
Alembic stamp, a dropped table. See `verify.test.ts`.

Two of those mutations could not be made at all, which was worth learning: SQLite's type affinity
rewrites `'1'` into the integer `1` in a `BOOLEAN` column, so most type changes are impossible to
introduce. Only a value a NUMERIC column cannot convert survives. And re-keying a position is
refused outright by the foreign key from `monitor_positions` — the pragma doing its job.
