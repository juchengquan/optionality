"""SPX options maths and moomoo access, ported from the optionality service's TypeScript (ADR 0014).

The modules mirror backend/src/domain/ file for file and are held to it by the golden cases in
testdata/golden/. `optionality.opend` needs the `opend` extra to CONNECT, not to import: it reaches the SDK inside
the function that uses it, so the module loads either way and asking it to connect without the
extra raises with the words to install. Everything else here needs neither the extra nor a running
service, which `tests/test_standalone.py` checks rather than promises.
"""
