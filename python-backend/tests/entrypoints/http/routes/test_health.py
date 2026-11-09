"""That `/health` serves the GENERATED fingerprint, whatever it says (ADR 0016). Port of
backend/src/entrypoints/http/routes/health.test.ts.

`test_app.py` compares the response with the constant it imports, which a hard-coded literal equal to
today's hash also satisfies — a sweep proved it in the TypeScript. The claim worth making is that the
route reads the library rather than a copy of its value, and the only way to state that is to make the
library say something else.

**Where the Python differs.** The TypeScript mocks the module `optionality/golden`; here the package's
own published name, `optionality.GOLDEN_CASES`, is patched for the one test. That is the name the
backend may read — `optionality._ported`, which holds it, is private to the library
(`tests/test_library_boundary.py`) — so a route that copied the value, or bound it at import, fails.
"""

import optionality


class TestTheGoldenFingerprintOnHealth:
    async def test_is_whatever_the_generated_module_says_not_a_copy_of_it(self, start, monkeypatch):
        monkeypatch.setattr(optionality, "GOLDEN_CASES", "feedfacecafe")
        data = (await start().call("/health", anonymous=True)).json()
        assert data["golden_cases"] == "feedfacecafe"
