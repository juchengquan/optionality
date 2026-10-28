# Golden cases

Test data, not tests — hence `testdata/`. The TypeScript writes these files and both suites read
them, so they sit outside both packages (ADR 0014).

What the TypeScript domain computes for a fixed set of inputs, one file per module (ADR 0014).
The TypeScript is canonical: these files are **generated**, never edited. `make cases` rewrites
them from `backend/src/cases/inputs.ts`, and `make check-cases` (and the backend's test suite)
fail when they no longer match what the TypeScript computes. The Python package must reproduce
every `expect` exactly — no tolerance, because the differences that matter are rounding at `.5`.

One function has instants that cannot be cases here: `displayTimeShort` names the zone with
ICU's abbreviation and the Python with tzdata's, and ICU has fewer names. The instants where the
two agree ARE cases below; the seven where they differ are measured in
`../zone-abbreviations.json`, a hand-written sibling that both suites read and each asserts its own
column of. That file is not in this directory on purpose: comparing exactly, with no tolerance, is
what makes these cases worth having, and an "expected to differ" exemption inside the mechanism is
how a rounding divergence that matters would hide.

Each file is `{"module": ..., "cases": [{"fn", "name", "args", "expect"}]}`. `fn` is the
TypeScript name; the Python name is its snake_case. `args` are positional. Three tags extend
JSON:

- `{"$date": "<ISO instant>"}` — a Date argument
- `{"$set": [...]}` — a Set result, members sorted
- `{"$throws": true}` — the function raised; the message is not part of the contract
