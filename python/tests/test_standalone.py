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

A second line runs through this file, and it is about CORRECTNESS rather than installability.
`optionality.research/` mirrors no TypeScript, so no golden case holds it and nothing in this
repository can say whether it is right (see its own `__init__.py`). The cased half must therefore
not depend on it, in either of its two kinds:

* a PURE module may not import it, for the same reason it may not import `opend` — it is the half
  the golden cases compare, and a case that reached uncased code would be comparing the wrong
  thing.
* a PORT may not import it either. A port implements `quotes.QuoteFetcher` and is held to the
  TypeScript vendor it mirrors by recorded fixtures; a port whose answer passed through an unheld
  chain reader would be a port in name only.

The other direction is fine and is asserted as such: research reads the maths and may drive a port.
The ports are DERIVED rather than listed, because `yahoo` and `ibkr` ports are in flight and a list
written today goes stale — they are the impure modules that are not the contract itself and not the
service reader, and the existing static check above already forces a new port into `IMPURE` by
failing the moment it is treated as pure.
"""

import ast
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1] / "src" / "optionality"

#: the three that mirror no domain module and reach the outside (CLAUDE.md): the SDK, the one
#: fetch-and-catch, and the reader of the live service
IMPURE = {"opend", "quotes", "api"}
#: generated, and the package docstring
NOT_A_MODULE = {"_ported", "__init__"}
#: the two impure modules that are not PORTS: the `QuoteFetcher` contract itself, and the reader of
#: the live service. Everything else impure answers that contract, which is what makes the port list
#: derived — see the docstring
NOT_A_PORT = {"quotes", "api"}
#: the uncased half, as a subpackage so it is a directory rather than a name to remember
RESEARCH_DIR = PACKAGE / "research"
RESEARCH = "optionality.research"

#: what a pure module may never import, at module level or inside a function. `yfinance` joins
#: `moomoo` for the same reason: it is an extra, and a pure module reaching it would break
#: `import optionality.alarm` for everyone who installed without one
FORBIDDEN_ROOTS = {"moomoo", "yfinance", "urllib", "http", "requests", "httpx", "socket", "ssl"}


def pure_modules() -> list[str]:
    names = sorted(
        p.stem for p in PACKAGE.glob("*.py") if p.stem not in IMPURE | NOT_A_MODULE
    )
    # there IS something to check: an empty list would pass every assertion below
    assert len(names) >= 14, f"only {len(names)} pure modules found in {PACKAGE}"
    return names


def port_modules() -> list[str]:
    """The modules that answer `quotes.QuoteFetcher`, derived rather than listed."""
    names = sorted(IMPURE - NOT_A_PORT)
    # an exemption list that can be widened from the inside is not a rule: adding "opend" to
    # NOT_A_PORT would leave nothing to check and every assertion below would pass
    assert "opend" in names, f"no ports left to check — NOT_A_PORT has swallowed them: {names}"
    return names


def research_modules() -> list[Path]:
    """Every file of the uncased half. Its ABSENCE is a failure, not a pass: the rules below forbid
    an import of something that does not exist, which is satisfied by an empty repository."""
    paths = sorted(RESEARCH_DIR.glob("*.py"))
    names = [p.stem for p in paths]
    assert "__init__" in names and len(names) >= 2, (
        f"no research half found in {RESEARCH_DIR} — the rules below would be about nothing: {names}"
    )
    return paths


def imported_by(path: Path) -> list[tuple[int, str]]:
    """Every name the file at `path` imports, with its line — from the AST, so an import nested
    inside a function is seen too. A lazy import is still an import-time dependency the moment the
    function is called, and `opend/client.ts` does exactly that trick on the TypeScript side."""
    tree = ast.parse(path.read_text())
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
    for line, name in imported_by(PACKAGE / f"{module}.py"):
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


def reaches_research(path: Path) -> list[str]:
    """Where the file at `path` imports the uncased half, with lines."""
    return [
        f"{path.name}:{line} imports {name}"
        for line, name in imported_by(path)
        if name == RESEARCH or name.startswith(RESEARCH + ".")
    ]


@pytest.mark.parametrize("module", pure_modules())
def test_a_pure_module_does_not_reach_the_uncased_half(module: str) -> None:
    offences = reaches_research(PACKAGE / f"{module}.py")
    assert offences == [], (
        "a pure module reached optionality.research, which no golden case holds — the cased half "
        "would then be compared to the TypeScript through code nothing checks: " + "; ".join(offences)
    )


@pytest.mark.parametrize("module", port_modules())
def test_a_port_does_not_reach_the_uncased_half(module: str) -> None:
    offences = reaches_research(PACKAGE / f"{module}.py")
    assert offences == [], (
        "a port reached optionality.research. A port is held to the TypeScript vendor it mirrors "
        "by recorded fixtures, and an answer routed through unheld code is not held at all: "
        + "; ".join(offences)
    )


def test_the_research_half_may_reach_the_cased_one(tmp_path: Path) -> None:
    """The direction that is fine, asserted so an over-broad rule cannot pass as a strict one.

    Research exists to drive the maths and the ports from a notebook; a rule that forbade that
    would have left the subpackage with nothing to do."""
    # every research file as it stands, first: nothing here may be flagged
    for path in research_modules():
        assert reaches_research(path) == [], f"{path.name} imports itself?"
    allowed = tmp_path / "chains.py"
    allowed.write_text("from optionality.opend import OpenD\nfrom optionality import expiry\n")
    assert reaches_research(allowed) == []


def test_the_research_rule_bites(tmp_path: Path) -> None:
    """The detector itself, against a file that breaks the rule. A guard whose matcher quietly
    matched nothing would pass every test above while holding nothing — `cases.test.ts` records
    exactly that failure, and this review round has hit it twice."""
    for source in (
        "from optionality.research.yahoo import option_chain\n",
        "import optionality.research\n",
        "def chain():\n    from optionality.research import yahoo\n",  # nested is still an import
    ):
        offender = tmp_path / "offender.py"
        offender.write_text(source)
        assert reaches_research(offender) != [], f"the rule did not see: {source!r}"


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


def test_the_all_extra_covers_every_other_one() -> None:
    """`all` exists so a notebook can stop thinking about extras — which only works while it is
    complete.

    Here rather than in a packaging test of its own because it is the same question as the rest of
    this file: what does a notebook actually get when it installs this. And it is the same failure
    shape as `hc.types.ts`'s coverage, which was true for sixteen endpoints and held by nobody — a
    new extra added and forgotten in `all` would leave `optionality[all]` quietly incomplete, and
    the only symptom is an ImportError in somebody's first cell.

    Derived from the table rather than listed: the point is that nothing has to be remembered.
    """
    pyproject = tomllib.loads((PACKAGE.parents[1] / "pyproject.toml").read_text())
    extras = pyproject["project"]["optional-dependencies"]
    assert "all" in extras, "the `all` extra is gone"
    others = sorted(set(extras) - {"all"})
    assert others, "there are no other extras, so `all` is checking nothing"
    covered = " ".join(extras["all"])
    missing = [name for name in others if f"[{name}]" not in covered and name not in covered]
    assert missing == [], (
        f"`all` does not pull {', '.join(missing)} — a notebook asking for everything would not get it"
    )
