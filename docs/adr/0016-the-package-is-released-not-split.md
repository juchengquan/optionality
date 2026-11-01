# 16. The Python package is released from this repository, not split out of it

Date: 2026-11-01

## Status

Accepted. Decided with the owner on 2026-11-01. Amends ADR 0014, whose last decision was
"One repository with real package boundaries … Splitting repositories is left for later."
This is that later, and the answer is no — with the thing the split was wanted for built instead.

## Context

The package in `python/` (ADR 0014) is consumed by notebooks that live outside this repository, in
`~/_workspace`, run by a pipx JupyterLab against kernels of their own. Nothing in those kernels
knows this checkout exists, and `.gitignore` keeps the notebooks local on purpose. So the package
is a library with no way to be installed, which is what raised splitting it into its own repository.

Three premises turned out to be wrong, and they are worth recording because they are what the
question was built on:

- **The Python backend is not pending deletion.** Phase 10 deleted it on 2026-10-17 (ADR 0014);
  `python-before-phase-10` keeps the code. There is nothing left to rescue.
- **The independent package already exists.** `python/` has its own `pyproject.toml`, name,
  version, MIT licence, dependency set, lockfile, suite and ruff configuration.
- **`langchain-core` is not a separate repository.** It is `libs/core` inside
  `langchain-ai/langchain`, beside `libs/langchain` and `libs/partners/*` — separately published,
  separately versioned, one repository. The shape the owner described wanting is the shape already
  here.

What was missing was not a repository. It was a way to install, a way to say which port you have,
and a way to find out that it has gone stale.

Measured rather than assumed, on 2026-11-01:

- A pinned subdirectory install works today, against this repository unchanged:
  `optionality @ git+https://github.com/juchengquan/optionality.git@de431cf#subdirectory=python`
  installs 0.1.0 into a clean 3.12 venv, all twelve modules import, `buildSpxCode`'s port answers
  `US.SPXW261204C8100000`, and the wheel ships source only — no tests, no fixtures. The repository
  is public, so no token stands in the way.
- **The sdist cannot carry the golden cases**, which sit outside `python/`. It does ship `tests/`,
  so `uv build` produces an sdist holding a suite that cannot pass: `test_cases.py` resolves
  `parents[2]/testdata/golden`, finds nothing, and fails on `len(ALL) >= 100`. That guard was
  written for exactly this and called the shot.
- Since the port landed, **five** commits touched `backend/src/domain`. Four ported in the SAME
  commit; the fifth was documentation. The median chase was about fourteen lines of Python.
  The coupling has never been left red overnight.
- `tools/check-boundaries.mjs` lists `python` among its packages, but its `SOURCE` pattern admits
  only `.ts/.tsx/.mts/.js/.mjs/.jsx`. **No Python file has ever been checked.** The half of its own
  header about "its importable modules for the Python" is unenforced.
- There is no CI in this repository — no `.github` at all. `make check` on the owner's machine is
  the entire gate, and its power is that it runs both suites against one working tree in one
  command.

Alternatives considered and rejected:

- **A separate repository.** `testdata/golden/` is shared ground the TypeScript generates. Split,
  and it is either vendored (a copy of the only evidence the port is honest) or pinned across
  repositories (six steps for a fourteen-line change). Neither is enforceable without CI in both
  repositories, so the split would spend a weekend buying back the safety of one `make check`.
- **Publishing to PyPI.** `optionality`, `optionality-core` and `spx-optionality` are all free. For
  an audience of one it reserves a public name, owes a release and deprecation story, and offers
  strangers a tool that talks to a localhost service. A pinned git ref converts to PyPI later at no
  cost; the reverse is a one-way door.
- **SemVer.** This package does not own its breaking changes: the TypeScript renames and the port
  mirrors, so MAJOR would encode another implementation's decision. Worse, its risk is behaviour,
  not surface — a rounding fix changes what `cost_to_close` computes and nothing about its
  signature, and SemVer would call that a patch exactly when the risk was highest. The
  classification worth forcing is fidelity, and ≥100 exact-comparison cases already force it.
- **Stamping the fidelity fingerprint at build time.** Reaching `../../testdata/golden/` from a
  build hook works for a git clone and silently produces nothing for an sdist. A stamp that is
  sometimes absent is worse than none, because it stops being read.
- **Loosening `make check`.** Dropping the Python suite from the gate does not reduce the porting
  work; it defers it to the moment a notebook prints a plausible wrong number, which nothing else
  in the system can detect. The service never imports this package.

## Decision

- **One repository.** `python/` stays where it is, and the layout stays flat —
  `backend/`, `frontend/`, `python/`, `testdata/golden/`, `tools/`, `docs/adr/`. No `libs/`
  nesting: at three packages it would invalidate every path in CLAUDE.md, five ADRs, the Makefile
  and `pyproject.toml` for no gain.
- **Installed by pinned git ref**, subdirectory `python/`. Not published.
- **Versioned by date: CalVer `YYYY.MM.DD`**, unpadded, with a fourth segment for a second cut in
  one day and no trailing `.0` — `2026.11.1`, then `2026.11.1.1`, then `2026.11.23`. Tagged with a
  `py-` prefix, so bare `v…` stays free for the service. PEP 440 was checked: `2026.09.0`
  normalises to `2026.9.0` (so neither field is padded), ordering is numeric
  (`2026.11.9 < 2026.11.11`, `2026.11.30 < 2026.12.1`), `0.1.0 < 2026.9.0` so the move forward is
  clean, and an epoch (`1!1.0.0`) is the way back to SemVer if it is ever wanted.
- **The version says WHEN IT WAS CUT. Fidelity is a separate fingerprint**: the sha256 of
  `testdata/golden/*.json` — the contract surface, excluding its README — written by `make cases`
  into a committed `python/src/optionality/_ported.py` and verified by `make check-cases`. Generated,
  committed and guarded, the same discipline as the golden cases themselves and `frontend/dist`.
  Read together: cut 2026.11.1, agrees with `<hash>`.
- **Staleness is checkable against the running service.** `make cases` writes the TypeScript's
  stamp too, `/health` carries the golden hash, and `optionality.api.agrees()` compares them.
  Opt-in and never at import: ADR 0014 exists so the maths works with no service running, and a
  package that must phone home to be useful breaks its own charter. No service, no verdict.
- **`make check` is unchanged** — every suite, one gate. The relief for a large port is that the
  PR is the unit that must be green, not every commit on the branch.
- **Releases are two steps**, because CLAUDE.md forbids pushing to main: `make py-cut` on a branch
  computes the date, writes the version, regenerates the stamp and runs the gate; `make py-tag` on
  main refuses unless it is on main, clean, up to date with origin, green, the version parses as a
  date and the tag is unused — then tags and pushes.
- **The package boundary gets enforced for Python**: `.py` in the boundary lint, and filesystem
  climbs as well as imports, since the Python's only crossing is `parents[2]` and nothing stops a
  future one landing in `backend/src/`. `testdata/golden/` remains the single shared directory.
- **`tests/` is excluded from the sdist.** The suite's purpose is comparison against the canonical
  implementation in this repository; a standalone sdist has nothing to compare against.

## Consequences

- Notebooks pin a ref and move deliberately. A notebook can sit on one tag for months; `agrees()`
  is how it learns the engine has moved on without it.
- Two stamps are generated from one source, so they cannot disagree — but `make cases` now writes
  into `python/src/` as well as `testdata/golden/`, and a port that edits `_ported.py` by hand is
  defeating the guard.
- The release date and the tag date can differ by a day if a bump PR waits. That is tolerable
  because the version's claim is "cut on", not "agrees as of"; a one-file release PR wants merging
  the same day.
- This decision is revisited if any of three things happen: a consumer who is not the owner, source
  in `python/` that is not a port, or CI existing — the first two weaken the shared-fixture
  argument, and the third removes the objection that nothing would enforce a cross-repository
  contract.
