# 14. The Python returns as a library, checked against the TypeScript

Date: 2026-10-17

## Status

Accepted. Decided with the owner on 2026-10-17. Amends ADR 0009's phase 10, which now runs
earlier.

## Context

Phase 10 was to delete the Python. The owner wants Python kept for their own notebooks: building
contract codes, fetching quotes, and computing Cost to close, P&L, exit levels and the vol part
without the service running.

Three shapes were considered and rejected:

- **Both backends behind one frontend, sharing an OpenAPI contract.** A contract describes
  shapes, and this project's bugs have been about behaviour — #129, #120 and #116 were all
  correct in shape and wrong in what they decided. Only one service can run at a time anyway
  (one bot token, one writer, diverged schemas), so "interchangeable" means switching, and
  switching is the rollback measured on 2026-10-15 as a trap.
- **The old Python, packaged as it is.** Twelve days after the cutover its Cost to close already
  answered a different question from the alarms' (#105), and it lacks exit levels and the vol
  part entirely.
- **Contracts and quotes only, figures from the live API.** One source of truth, but no figures
  while the service is down, which is the case the owner wants covered.

## Decision

- A package, `optionality`, in `python/`: contracts, expiry, quotes and OpenD access (tier 1),
  and the position, monitor, exit and vol maths (tier 2). Ported FROM THE TYPESCRIPT, module for
  module, with snake_case the only translation.
- The TypeScript is canonical. Golden cases in `cases/` (moved to `tests/golden/` the same day:
  still shared ground, under a name that says test data), inputs written by hand in TypeScript and
  outputs computed by it, are checked by both suites; `make check-cases` fails when they are
  stale. A TypeScript fix therefore turns the Python red until it is ported.
- Comparison is EXACT. JavaScript's `Math.round` and Python's `round` disagree at .5 (0.125 →
  0.13 against 0.12, measured), so the Python reproduces JavaScript's rounding rather than the
  cases carrying a tolerance that would hide it.
- Frozen Pydantic models for the domain types; a Quote stays a plain dict. The moomoo SDK is an
  optional extra (`opend`), uv-managed. Installed by local path; not published. MIT.
- One repository with real package boundaries: the frontend imports the backend's published
  entry points, never its source tree. Splitting repositories is left for later.

## Consequences

- Phase 10 runs before the port, not on 2026-11-02: the old service and the new package would
  both be the `optionality` module, and one environment cannot hold two.
- Two implementations of the Glossary's terms now exist on purpose. Only the cases keep that from
  being the drift ADR 0009 warned about; a domain change that skips them reopens it.
