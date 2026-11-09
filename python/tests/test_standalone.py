"""The maths works with no `opend` extra and no service running.

Three documents promise it — `python/README.md` ("with no service reachable it says so and the
maths still works"), ADR 0016 ("the maths works with no service running"), and this package's own
`__init__.py` ("`optionality.opend` needs the `opend` extra", which says the other modules do not).
Nothing held them to it, and the promise is the one a notebook discovers in its FIRST CELL: a pure
module that acquired an import-time dependency on the SDK or on the service would break
`import optionality.alarm` for everyone who installed without the extra.

It could not be noticed here, either. `moomoo` IS installed in the venv this suite runs in, so a
pure module importing `optionality.opend` would have imported fine and every test would have
stayed green.

Two checks, because they fail differently and a mutation should have to defeat both:

* the STATIC one reads each module and names the offending line. It is a proxy: it knows only the
  dependencies it was told to look for.
* the DYNAMIC one imports all fourteen in a subprocess with `moomoo` made unimportable and
  `OPTIONALITY_API` unset, and then COMPUTES with them. Writing it corrected an assumption: it
  found that `optionality.opend` imports PERFECTLY WELL with no SDK, because `_moomoo_connect`
  imports it inside the function ("it is heavy and only wanted when asked for"). So the extra is
  needed to CONNECT, not to import, and what this asserts instead is that connecting fails with
  words naming the extra to install. It tests the promise itself rather than a
  proxy for it — including the import-time dependencies no pattern would list, such as the zone
  data `timefmt` needs, which is present on this machine and absent from a slim container.

The dynamic one carries its own anti-vacuum check. A subprocess whose blocker silently failed to
bite would pass while proving nothing — the failure `cases.test.ts` records as a filter that
quietly matched nothing, and which this review round has hit twice — so the script asserts that
`import moomoo` DOES raise and that `optionality.opend` therefore fails, before it concludes
anything about the rest.
"""

import ast
import subprocess
import sys
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1] / "src" / "optionality"

#: the three that mirror no domain module and reach the outside (CLAUDE.md): the SDK, the one
#: fetch-and-catch, and the reader of the live service
IMPURE = {"opend", "quotes", "api"}
#: generated, and the package docstring
NOT_A_MODULE = {"_ported", "__init__"}

#: what a pure module may never import, at module level or inside a function
FORBIDDEN_ROOTS = {"moomoo", "urllib", "http", "requests", "httpx", "socket", "ssl"}


def pure_modules() -> list[str]:
    names = sorted(
        p.stem for p in PACKAGE.glob("*.py") if p.stem not in IMPURE | NOT_A_MODULE
    )
    # there IS something to check: an empty list would pass every assertion below
    assert len(names) >= 14, f"only {len(names)} pure modules found in {PACKAGE}"
    return names


def imported_by(module: str) -> list[tuple[int, str]]:
    """Every name `module` imports, with its line — from the AST, so an import nested inside a
    function is seen too. A lazy import is still an import-time dependency the moment the
    function is called, and `opend/client.ts` does exactly that trick on the TypeScript side."""
    tree = ast.parse((PACKAGE / f"{module}.py").read_text())
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found += [(node.lineno, a.name) for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            found.append((node.lineno, node.module))
    return found


@pytest.mark.parametrize("module", pure_modules())
def test_a_pure_module_reaches_nothing_outside_itself(module: str) -> None:
    offences = []
    for line, name in imported_by(module):
        root = name.split(".")[0]
        if root in FORBIDDEN_ROOTS:
            offences.append(f"{module}.py:{line} imports {name}")
        if name.startswith("optionality.") and name.split(".")[1] in IMPURE:
            offences.append(f"{module}.py:{line} imports {name}")
    assert offences == [], (
        "a pure module reached the SDK, the network or an impure module — this breaks "
        "`import optionality` for anyone who installed without the `opend` extra: "
        + "; ".join(offences)
    )


STANDALONE = r'''
import importlib, importlib.abc, sys

class Absent(importlib.abc.MetaPathFinder):
    """moomoo is not installed, as far as anything below is concerned.

    ModuleNotFoundError and not ImportError: that is what absence actually raises, and
    `opend.py` catches the narrower one by name. A blocker raising the wider class would have
    walked straight past its handler and tested the wrong failure.
    """

    def find_spec(self, name, path=None, target=None):
        if name == "moomoo" or name.startswith("moomoo."):
            raise ModuleNotFoundError(f"No module named {name!r}", name=name)
        return None

sys.meta_path.insert(0, Absent())

# --- the blocker must actually bite, or every assertion below is vacuous -------------------
try:
    import moomoo
except ModuleNotFoundError:
    pass
else:
    raise SystemExit("BLOCKER DEAD: moomoo imported anyway, so this check proves nothing")

# --- opend IMPORTS without the SDK, by design ---------------------------------------------
# `_moomoo_connect` imports the SDK inside the function, "not at the top: it is heavy and only
# wanted when asked for". So the module stands alone and only CONNECTING needs the extra.
import optionality.opend as od

# --- and asking it to connect fails with words that say what to install -------------------
try:
    od.OpenD().__enter__()
except ImportError as err:
    assert "optionality[opend]" in str(err), f"unhelpful message: {err}"
else:
    raise SystemExit("OpenD connected with no SDK — what did it connect to?")

# --- the fourteen, imported with no SDK and no service ------------------------------------
MODULES = __MODULES__
for name in MODULES:
    importlib.import_module(f"optionality.{name}")

# --- and they COMPUTE, not merely import --------------------------------------------------
from optionality.js import math_round, to_fixed
from optionality.expiry import days_to_expiry, market_date
from optionality.monitor import threshold_fill
from optionality.timefmt import display_time_short
from datetime import UTC, datetime

# the three values below are GOLDEN CASES, quoted rather than invented — js.mathRound("a half
# rounds up"), js.toFixed("an exact binary half goes away from zero") and
# monitor.thresholdFill("halfway above"). They are here to prove the modules FUNCTION with no SDK
# and no service; whether the maths is right is `test_cases.py`'s job, over all 52 of them.
assert math_round(12.5) == 13, math_round(12.5)
assert to_fixed(0.03125, 4) == 0.0313, to_fixed(0.03125, 4)
assert threshold_fill(0.15, 0.3, "above", "abs") == 50, threshold_fill(0.15, 0.3, "above", "abs")

# the zone path specifically: this needs tz data, which is the import-time dependency that is
# present on a developer's machine and absent from a slim container
at = datetime(2026, 11, 9, 5, 0, tzinfo=UTC)
assert display_time_short(at, "Asia/Singapore"), "display_time_short answered nothing"
assert market_date(at), "market_date answered nothing"
assert isinstance(days_to_expiry("2026-12-18", at), int)

# --- api imports with no service, because agrees() must never run at import ----------------
import optionality.api

print("OK")
'''


def test_the_maths_imports_and_computes_with_no_sdk_and_no_service(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script = tmp_path / "standalone.py"
    script.write_text(STANDALONE.replace("__MODULES__", repr(pure_modules())))
    # no service, and nothing inherited that might make one reachable
    # a bare environment: no OPTIONALITY_API, so "no service" is the state under test. `-s`
    # rather than `-I`, because `-I` implies `-E` and would discard the PYTHONPATH that puts the
    # package itself on the path; the interpreter is the venv's, so pydantic is still found.
    env = {
        "PATH": "/usr/bin:/bin",
        "PYTHONPATH": str(PACKAGE.parent),
        "HOME": str(tmp_path),
    }
    done = subprocess.run(
        [sys.executable, "-s", str(script)],
        capture_output=True, text=True, env=env, timeout=60, check=False,
    )
    assert done.returncode == 0, (
        f"the package does not stand alone:\n{done.stdout}\n{done.stderr}"
    )
    assert done.stdout.strip().endswith("OK"), done.stdout
