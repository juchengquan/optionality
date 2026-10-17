# Golden cases

What the TypeScript domain computes for a fixed set of inputs, one file per module (ADR 0014).
The TypeScript is canonical: these files are **generated**, never edited. `make cases` rewrites
them from `backend/src/cases/inputs.ts`, and `make check-cases` (and the backend's test suite)
fail when they no longer match what the TypeScript computes. The Python package must reproduce
every `expect` exactly — no tolerance, because the differences that matter are rounding at `.5`.

Each file is `{"module": ..., "cases": [{"fn", "name", "args", "expect"}]}`. `fn` is the
TypeScript name; the Python name is its snake_case. `args` are positional. Three tags extend
JSON:

- `{"$date": "<ISO instant>"}` — a Date argument
- `{"$set": [...]}` — a Set result, members sorted
- `{"$throws": true}` — the function raised; the message is not part of the contract
