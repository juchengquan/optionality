"""SPX options maths and moomoo access, ported from the optionality service's TypeScript (ADR 0014).

The modules mirror typescript/src/domain/ file for file and are held to it by the golden cases in
testdata/golden/. `optionality.opend` needs the `opend` extra to CONNECT, not to import: it reaches the SDK inside
the function that uses it, so the module loads either way and asking it to connect without the
extra raises with the words to install. `optionality.ibkr` is the same with the `ibkr` extra. Everything else at this level needs neither the extra nor a
running service, which `tests/test_standalone.py` checks rather than promises.

`optionality.research` is the exception, and it is one of standing rather than of packaging: it
mirrors no TypeScript, so no golden case holds it and nothing here can say whether it is right. Read
its own docstring before trusting a figure out of it. Nothing above it may import it, which the same
suite holds.
"""
