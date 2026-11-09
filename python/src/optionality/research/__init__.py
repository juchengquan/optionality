"""The half of this package that mirrors no TypeScript, and that nothing checks.

Everything above this directory is a PORT: it mirrors a module of `backend/src/domain/` or a vendor
client in `backend/src/vendors/`, and something holds it there — the golden cases in
`testdata/golden/` for the maths and the decisions, compared exactly, and recorded fixtures for the
providers. A wrong answer there turns `make test` red.

Nothing holds this. Chains, historical bars and whatever follows are things the service never
fetches, so there is no canonical TypeScript to compare against and no case to generate. The tests
here can check that a response is PARSED as intended; they cannot check that the intention is right,
because there is no second implementation to disagree with. If a figure out of this subpackage is
wrong, the first thing to notice will be a human reading it.

That is stated plainly rather than dressed up, the way `backend/src/entrypoints/http/index.ts` says
its seam is the weakest of the three. It is the first code in the package making a claim no golden
case holds, and treating it as equal in standing to the cased half is how a notebook ends up
trusting it equally.

So the line is structural, not remembered. `tests/test_standalone.py` refuses an import of
`optionality.research` from any pure module and from any port: the cased half must not depend on the
uncased one. The other direction is free — research reads the maths and drives the ports, which is
what it is for.

Each module names the extra it needs in the error when it is missing: `yahoo` for
`optionality.research.yahoo` (yfinance).
"""
