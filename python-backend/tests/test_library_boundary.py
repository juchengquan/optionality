"""The backend reaches the library only through what it publishes (ADR 0021, Decision 5).

`python-backend/` depends on `optionality` the way a notebook does: by name, through its public
modules. Three ways round that are refused here, because each one makes the backend depend on
something the library never promised and nothing holds:

* a PRIVATE module or name, `optionality._*` at any depth. `_ported` is the golden stamp and
  `_MISSING` is a sentence; the underscore is the library saying "not an interface", and a backend
  that read through it would break on a refactor no golden case notices.
* `optionality.research`, the uncased half. It mirrors no TypeScript and nothing in this repository
  says whether it is right (ADR 0020, and its own `__init__.py`). `test_standalone.py` keeps the
  library's cased half off it; this keeps the service off it, which matters more: a figure the
  service ALARMS on must be one the golden cases hold.
* the library's SOURCE rather than its name — `sys.path` edited, a module loaded from a file, an
  import rooted at `src` or `python`, a relative import that climbs out of `optionality_backend`, a
  path built through `python/src`. Each of these imports whatever the working tree holds instead of
  the installed package, so a half-ported library would run live while the suite tested another.

Read from the AST, as `test_standalone.py` reads the library, so an import nested inside a function
is seen too: a lazy import is still a dependency the moment the function runs. String literals are
read as well, folded where they are concatenated, because `importlib.import_module` takes a string.

It is a lint and not a sandbox. Code written to evade it can (`chr`, base64, a name built at
runtime); what it stops is the ACCIDENTAL crossing and the lazy deliberate one, which is what a
convention left unchecked loses to. Checked against a FIXTURE TREE rather than against this
repository, which is the lesson `tools/check-seams.test.mjs` records: a guard tested only against a
clean tree passes while holding nothing.
"""

import ast
import itertools
from pathlib import Path

import pytest
from reading import every_string, python_files

BACKEND = Path(__file__).resolve().parents[1]
#: the one package the backend's code lives in, under `src/`
PACKAGE = "optionality_backend"
LIBRARY = "optionality"
#: the library's uncased half (ADR 0020)
UNHELD = "research"
#: import roots that can only mean the library's source tree: `from src.optionality import alarm`
#: works from `python/`, and `python` is the directory itself
SOURCE_ROOTS = {"src", "python"}
#: what loads a module from a FILE, or changes where imports are looked for
BY_PATH = {"spec_from_file_location", "SourceFileLoader", "SourcelessFileLoader", "run_path", "addsitedir"}
#: the attributes of `sys` that decide where an import is found
SYS_PATHS = {"path", "meta_path", "path_hooks", "path_importer_cache"}


def refusal(name: str) -> str | None:
    """Why the dotted module path `name` may not be imported, or None if it may."""
    parts = name.split(".")
    if parts[0] in SOURCE_ROOTS:
        return "the library's source, not its package"
    return library_refusal(parts)


def library_refusal(parts: list[str]) -> str | None:
    if parts[0] != LIBRARY:
        return None
    if len(parts) > 1 and parts[1] == UNHELD:
        return "the uncased half (ADR 0020)"
    # a dunder is the language's, not the library's: `optionality.__name__` is not private
    if any(p.startswith("_") and not (p.startswith("__") and p.endswith("__")) for p in parts[1:]):
        return "private to the library"
    return None


def through_source(strings: list[str]) -> bool:
    """Whether a path assembled from `strings`, in order, passes through `python/src`."""
    segments = [seg for s in strings for seg in s.replace("\\", "/").split("/") if seg not in ("", ".")]
    return any(a == "python" and b == "src" for a, b in itertools.pairwise(segments))


def dotted(node: ast.AST) -> list[str] | None:
    """`a.b.c` as `["a", "b", "c"]`, or None if the chain is not names all the way down."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    return [node.id, *reversed(parts)]


def file_breaches(path: Path, rel: Path) -> list[tuple[int, str]]:
    tree = ast.parse(path.read_text())
    package = list(rel.parent.parts)[1:]  # the file's own package, under src/
    found: set[tuple[int, str]] = set()
    #: what each local name was bound to by an import, so `y._MISSING` is read as the library's
    bound: dict[str, str] = {}

    def module(line: int, name: str) -> None:
        why = refusal(name)
        if why is not None:
            found.add((line, f"imports {name}, {why}"))

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                module(node.lineno, alias.name)
                if alias.asname is not None:
                    bound[alias.asname] = alias.name
                else:
                    root = alias.name.split(".")[0]
                    bound[root] = root
        elif isinstance(node, ast.ImportFrom):
            if node.level > 0:
                # `from .x import y` is the file's own package; each further dot climbs one more.
                # Past the top of `optionality_backend` there is only `src/`, and the library.
                if node.level > len(package):
                    climb = f"{'.' * node.level}{node.module or ''}"
                    found.add((node.lineno, f"imports {climb}, which climbs out of the package"))
                continue
            assert node.module is not None
            for alias in node.names:
                if alias.name == "*":
                    module(node.lineno, node.module)
                    continue
                # the full name only: a refused module refuses everything imported from it, for
                # the same reason, and one finding per import is what a person can act on
                full = f"{node.module}.{alias.name}"
                module(node.lineno, full)
                if node.module == "sys" and alias.name in SYS_PATHS:
                    found.add((node.lineno, f"imports {full}, which decides where imports are found"))
                bound[alias.asname or alias.name] = full
        if isinstance(node, ast.alias) and node.name in BY_PATH:
            found.add((getattr(node, "lineno", 0), f"imports {node.name}, which imports by path rather than by name"))

    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            chain = dotted(node)
            if chain is not None and chain[0] in bound:
                full = bound[chain[0]].split(".") + chain[1:]
                for depth in range(2, len(full) + 1):
                    why = library_refusal(full[:depth])
                    if why is not None:
                        found.add((node.lineno, f"reaches {'.'.join(full[:depth])}, {why}"))
                        break
                if full[0] == "sys" and len(full) > 1 and full[1] in SYS_PATHS:
                    found.add((node.lineno, f"uses sys.{full[1]}, which decides where imports are found"))
            if node.attr in BY_PATH:
                found.add((node.lineno, f"uses {node.attr}, which imports by path rather than by name"))
        elif isinstance(node, ast.Name) and node.id in BY_PATH:
            found.add((node.lineno, f"uses {node.id}, which imports by path rather than by name"))

    for stmt_line, strings in every_string(tree):
        for line, value in strings:
            if all(c.isalnum() or c in "._" for c in value):
                why = library_refusal(value.split("."))
                if why is not None:
                    found.add((line, f"names {value}, {why}"))
            if "PYTHONPATH" in value:
                found.add((line, "sets PYTHONPATH, which decides where imports are found"))
        if through_source([value for _, value in strings]):
            found.add((stmt_line, "builds a path through python/src, the library's source"))
    return sorted(found)


def breaches(root: Path) -> list[str]:
    """Every crossing in `root/src`, as `file:line what`. `root` is shaped like `python-backend/`."""
    lines = []
    for path, rel in python_files(root):
        lines += [f"{rel}:{line} {what}" for line, what in file_breaches(path, rel)]
    return lines


def test_the_real_backend_crosses_no_line() -> None:
    found = breaches(BACKEND)
    assert found == [], "the backend reaches past what the library publishes:\n  " + "\n  ".join(found)


# --- the fixture tree -------------------------------------------------------------------------


def write(root: Path, rel: str, source: str) -> None:
    path = root / "src" / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source)


REFUSED = {
    # private, at any depth, in every spelling of an import
    "a private module, imported": "import optionality._ported\n",
    "a private module, from the package": "from optionality import _ported\n",
    "a name from a private module": "from optionality._ported import GOLDEN_CASES\n",
    "a private name from a public module": "from optionality.yahoo import _MISSING\n",
    "a private module, reached as an attribute": "import optionality\nX = optionality._ported.GOLDEN_CASES\n",
    "a private name, reached through an alias": "from optionality import yahoo as y\nX = y._MISSING\n",
    # the uncased half
    "research, imported": "import optionality.research.yahoo\n",
    "research, from the package": "from optionality import research\n",
    "research, aliased": "from optionality import research as r\n",
    "a research module": "from optionality.research import yahoo\n",
    "a research function": "from optionality.research.yahoo import option_chain\n",
    "research, imported lazily": "def chain():\n    from optionality.research.yahoo import option_chain\n",
    "research, reached as an attribute": "import optionality\nchain = optionality.research.yahoo\n",
    "research, by importlib": 'import importlib\nm = importlib.import_module("optionality.research.yahoo")\n',
    "a private module, by __import__": 'm = __import__("optionality._ported")\n',
    "a private module, by a folded string": 'import importlib\nimportlib.import_module("optionality." + "_ported")\n',
    # the source tree instead of the package
    "sys.path edited": 'import sys\nsys.path.insert(0, "../python/lib")\n',
    "sys.path edited under an alias": 'import sys as s\ns.path.append("x")\n',
    "sys.path edited lazily": 'def boot():\n    import sys\n    sys.path.append("x")\n',
    "sys.path imported by name": "from sys import path\n",
    "an import hook installed": "import sys\nsys.meta_path.insert(0, object())\n",
    "PYTHONPATH set": 'import os\nos.environ["PYTHONPATH"] = "x"\n',
    "a module loaded from a file": "import importlib.util\nspec = importlib.util.spec_from_file_location('m', 'a.py')\n",
    "a file loader by name": "from importlib.machinery import SourceFileLoader\n",
    "a site dir added": "import site\nsite.addsitedir('x')\n",
    "a file run as a module": "import runpy\nrunpy.run_path('x.py')\n",
    "an import rooted at src": "from src.optionality import alarm\n",
    "an import rooted at python": "import python.src.optionality\n",
    "a relative import out of the package": "from ...python.src.optionality import alarm\n",
    "a path joined through python/src": 'from pathlib import Path\nP = Path(__file__).parents[3] / "python" / "src"\n',
    "a path from Path(...) through python/src": 'from pathlib import Path\nP = Path("..", "python") / "src"\n',
    "a path by os.path.join": 'import os\nP = os.path.join(ROOT, "python", "src", "optionality")\n',
    "a path in one string": 'P = "../../python/src/optionality/alarm.py"\n',
}


@pytest.mark.parametrize("source", REFUSED.values(), ids=REFUSED.keys())
def test_a_crossing_is_refused(tmp_path: Path, source: str) -> None:
    write(tmp_path, f"{PACKAGE}/caller.py", source)
    found = breaches(tmp_path)
    assert len(found) >= 1, f"the lint did not see: {source!r}"
    assert all(f.startswith(f"src/{PACKAGE}/caller.py:") for f in found), found


def test_a_crossing_names_its_line_and_the_rule(tmp_path: Path) -> None:
    write(tmp_path, f"{PACKAGE}/caller.py", '"""doc"""\n\nfrom optionality.research import yahoo\n')
    assert breaches(tmp_path) == [
        f"src/{PACKAGE}/caller.py:3 imports optionality.research.yahoo, the uncased half (ADR 0020)"
    ]


ALLOWED = {
    "a public module": "from optionality import alarm, expiry\n",
    "a public name": "from optionality.position import cost_to_close\n",
    "a public module, imported": "import optionality.js\nX = optionality.js.math_round(1.5)\n",
    "the package itself": "import optionality\nX = optionality.alarm\n",
    "a sibling, relatively": "from . import sibling\nfrom .sub import thing\n",
    "a relative import that stays inside": "from .. import thing\n",
    "os.path, which is not sys.path": 'import os\nP = os.path.join("a", "b")\n',
    "a dunder, which is not private": "import optionality\nV = optionality.__name__\n",
    "the backend's own name": "import optionality_backend\n",
    "the words, apart": 'LANGS = "python"\nDIRS = "src"\n',
    "the docstring may say it": '"""Never optionality.research, never sys.path."""\n',
}


@pytest.mark.parametrize("source", ALLOWED.values(), ids=ALLOWED.keys())
def test_what_the_library_publishes_is_allowed(tmp_path: Path, source: str) -> None:
    """The other direction, so an over-broad rule cannot pass as a strict one: a lint that refused
    every import of the library would leave the backend unable to use the maths it is built on."""
    write(tmp_path, f"{PACKAGE}/sub/caller.py", source)
    assert breaches(tmp_path) == []


def test_every_file_under_src_is_read(tmp_path: Path) -> None:
    """Nested packages too, and a file outside the package: a walker that read one level would
    pass the real tree, which today is one file."""
    write(tmp_path, f"{PACKAGE}/a/b/c/deep.py", "from optionality import _ported\n")
    write(tmp_path, "stray.py", "import optionality.research\n")
    assert sorted(f.split(":")[0] for f in breaches(tmp_path)) == [
        f"src/{PACKAGE}/a/b/c/deep.py",
        "src/stray.py",
    ]


def test_the_backend_has_no_python_outside_src_and_tests() -> None:
    """The lint reads `src/`. A `tools/` or `scripts/` beside it would run in the same environment
    and be read by nobody, so its arrival is a decision rather than a drift: extend the scope here
    when it comes."""
    stray = [
        str(p.relative_to(BACKEND))
        for p in BACKEND.rglob("*.py")
        if p.relative_to(BACKEND).parts[0] not in {"src", "tests", ".venv"}
    ]
    assert stray == []


def test_the_real_tree_is_not_empty() -> None:
    """An empty `src/` passes every rule above while proving nothing."""
    assert (BACKEND / "src" / PACKAGE / "__init__.py").is_file()
    assert ast.parse((BACKEND / "src" / PACKAGE / "__init__.py").read_text())
