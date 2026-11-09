"""The door scenarios' Python runner (ADR 0021, Decision 4): the half of the replay that holds the
Python backend to `testdata/scenarios/`, as `backend/testing/scenarios/` holds the TypeScript.

Module for module with that directory, where there is one to mirror:

* `corpus.py` — where the files are, and reading them (`corpus.ts`);
* `compare.py` — what "the same" means, from the README's "Comparing" (vitest's `toEqual` there);
* `world.py` — a world made real: the database built from `schema/schema.sql` and stamped, its
  rows, the vendors answering from their tables, the clock, the id minter, Telegram (`world.ts`);
* `backend.py` — THE SEAM: the one function that builds the Python backend on a world, which
  raises `NotPorted` until phase 3 fills it. `doors.ts` builds the TypeScript service inline; here
  it is a module of its own because it is the one thing that changes as the port lands;
* `doors.py` — the three doors run on a world, step for step as `doors.ts` runs them;
* `backlog.py` — the scenarios not ported yet, and the rules that make the list only shrink.

Under `tests/`, never `src/`: everything here is correct in a test and a lie in production — a
vendor that answers from a table, a Telegram that delivers into a list. The README in
`testdata/scenarios/` is the format; this is the Python's reading of it, as `format.ts` is the
TypeScript's.
"""
