"""A seam's interior is private: only its door may be imported from outside it.

The Python's half of `tools/check-seams.mjs`, which states this rule inside the TypeScript backend
and cannot read Python. One seam so far, the one ported: the alarm engine (ADR 0021, phase 4).

**Why the engine's door is a seam at all.** A route or a bot command that could import the sweeper
could start a sweep from inside a request; they get the read-only `SweeperPort` in `deps` instead,
which is the health account's. And the door withholds the health account's CLASS, `SweepHealth`
(`engine/__init__.py` says why): #230's mutation sweep found that a freshly constructed one in
`main.ts` typechecked and passed every route, app and boot test while describing a service whose
/health says "starting" for ever as the sweeps run. The TypeScript closes that by making it
unwritable — the door does not export the class, and `check-seams` refuses any reach past the door,
so `main.ts` cannot name it and fails to compile. Withholding the name alone would hold nothing in
Python, where `optionality_backend.engine.health.SweepHealth` is one import away; so this file is
the other half, and the two together are the property: from outside the engine, the class cannot be
named.

What it refuses, from any file outside the seam's insiders:

* a reach PAST the door, in every spelling — `import ...engine.health`, `from ...engine.health
  import X`, a name the door does not export (`from ...engine import health`, a submodule, which
  Python hands out through the door's namespace), the same reached as an attribute of a door or a
  parent package, a relative import that resolves there, and a dotted name in a string, because
  `importlib.import_module` takes one;
* the door itself, from anyone but `importable_by`: the engine is reached by `__main__` alone.

**Insiders** are the engine's own package and its tests at the mirrored path, `tests/engine/`. The
TypeScript keeps a module's tests BESIDE it, inside the directory, where they are insiders by
position; here they live in `tests/` (README, "Porting a module"), so they are named. Every other
test is read like the service, as `check-seams` reads a test outside the seam: "a suite that drives
a client directly is how the seam stops being the only way in". This file is the one other caller,
as `check-seams.test.mjs` is in the TypeScript, because it imports the door to ask what it exports.

It is a lint and not a sandbox: `type(sweeper.health)(...)` gets the class back from an instance, as
`sweeper.health.constructor` would in the TypeScript. What it stops is the accidental crossing and
the lazy deliberate one. Checked against a FIXTURE TREE as well as this repository, for
`check-seams`' reason: a guard tested only against a clean tree passes while holding nothing.
"""

import ast
import importlib
from dataclasses import dataclass
from pathlib import Path

import pytest
from reading import every_string

BACKEND = Path(__file__).resolve().parents[1]
#: where the lint reads, relative to the backend: the service and every test
READ = ("src", "tests")


@dataclass(frozen=True)
class Seam:
    #: the package whose `__init__.py` is the one door, dotted
    door: str
    #: what may reach past the door, as directories relative to the backend
    insiders: tuple[str, ...]
    #: the only files that may import the door at all, relative to the backend
    importable_by: tuple[str, ...]
    #: printed when the rule is broken, because a guard that only says "refused" teaches the next
    #: person to delete it
    why: str


SEAMS = (
    Seam(
        door="optionality_backend.engine",
        insiders=("src/optionality_backend/engine", "tests/engine"),
        importable_by=(
            "src/optionality_backend/__main__.py",
            # this guard's own test, which imports the door to assert it still withholds the health
            # account's class. Declared rather than exempted as a class: "any test may reach in" is
            # how the engine stops being main-only.
            "tests/test_seams.py",
        ),
        why=(
            "the engine is reached by `__main__` alone; a request must not be able to start a sweep, "
            "and the door withholds SweepHealth so a second health account cannot be built"
        ),
    ),
)


# --- the lint ----------------------------------------------------------------------------------


def door_exports(root: Path, seam: Seam) -> set[str]:
    """The names the door's `__all__` lists, read from its source. A door with no `__all__` exports
    nothing this lint will let through: a name is handed out by being listed."""
    path = root / "src" / Path(*seam.door.split(".")) / "__init__.py"
    if not path.is_file():
        return set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__all__" for t in node.targets):
            return {e.value for e in getattr(node.value, "elts", []) if isinstance(e, ast.Constant)}
    return set()


def crossing(full: list[str], door: list[str], exports: set[str]) -> tuple[str, list[str]] | None:
    """What the dotted name `full` does to the seam: ("door", the door) when it names the door or a
    name the door exports, ("past", the door and the first name it does not export) when it reaches
    inside, None when it is not the seam's at all."""
    if full[: len(door)] != door:
        return None
    if len(full) == len(door) or full[len(door)] in exports:
        return "door", door
    return "past", full[: len(door) + 1]


def resolved(node: ast.ImportFrom, rel: Path) -> str | None:
    """The absolute module a `from` import names, or None for a relative one that cannot be the
    service's: one in `tests/`, or one climbing out of `src/` (which `test_library_boundary.py`
    refuses)."""
    if node.level == 0:
        return node.module
    if rel.parts[0] != "src":
        return None
    package = list(rel.parts[1:-1])
    if node.level - 1 > len(package) - 1:
        return None
    base = package[: len(package) - (node.level - 1)]
    return ".".join([*base, *([node.module] if node.module else [])])


def file_breaches(path: Path, rel: Path, seam: Seam, exports: set[str]) -> list[tuple[int, str]]:
    door = seam.door.split(".")
    may_knock = str(rel) in seam.importable_by
    found: set[tuple[int, str]] = set()
    #: what each local name was bound to by an import, so `e.health` is read as the engine's
    bound: dict[str, list[str]] = {}

    def refer(line: int, full: list[str], depth: int = 0) -> None:
        """`depth` is how much of `full` the import already named; a crossing inside it was found
        there."""
        what = crossing(full, door, exports)
        if what is None:
            return
        kind, prefix = what
        if len(prefix) <= depth:
            return
        name = ".".join(prefix)
        if kind == "past":
            found.add((line, f"reaches {name}, which is inside {seam.door}: only its door may be imported"))
        elif not may_knock:
            reached_by = ", ".join(seam.importable_by)
            found.add((line, f"imports {name}, which is reached by {reached_by} alone"))

    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                parts = alias.name.split(".")
                refer(node.lineno, parts)
                if alias.asname is not None:
                    bound[alias.asname] = parts
                else:
                    bound[parts[0]] = parts[:1]
        elif isinstance(node, ast.ImportFrom):
            module = resolved(node, rel)
            if module is None:
                continue
            for alias in node.names:
                full = module.split(".") if alias.name == "*" else [*module.split("."), alias.name]
                refer(node.lineno, full)
                if alias.name != "*":
                    bound[alias.asname or alias.name] = full

    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            chain = []
            at: ast.AST = node
            while isinstance(at, ast.Attribute):
                chain.append(at.attr)
                at = at.value
            if isinstance(at, ast.Name) and at.id in bound:
                base = bound[at.id]
                refer(node.lineno, [*base, *reversed(chain)], depth=len(base))

    for _, strings in every_string(tree):
        for line, value in strings:
            if value and all(c.isalnum() or c in "._" for c in value):
                refer(line, value.split("."))
    return sorted(found)


def python_files(root: Path) -> list[tuple[Path, Path]]:
    return [(p, p.relative_to(root)) for top in READ for p in sorted((root / top).rglob("*.py"))]


def breaches(root: Path, seams: tuple[Seam, ...] = SEAMS) -> list[tuple[Seam, str]]:
    """Every crossing in `root`, as the seam it crosses and `file:line what`. `root` is shaped like
    `python-backend/`, so a fixture tree and the real one are read the same way."""
    out = []
    for seam in seams:
        exports = door_exports(root, seam)
        for path, rel in python_files(root):
            if any(rel.is_relative_to(inside) for inside in seam.insiders):
                continue
            out += [(seam, f"{rel}:{line} {what}") for line, what in file_breaches(path, rel, seam, exports)]
    return out


def lines(root: Path, seams: tuple[Seam, ...]) -> list[str]:
    return [line for _, line in breaches(root, seams)]


def test_the_real_backend_keeps_to_its_seams() -> None:
    found = breaches(BACKEND)
    assert found == [], "\n".join(f"{line}\n    because {seam.why}" for seam, line in found)


# --- the fixture tree ----------------------------------------------------------------------------

#: One seam shaped like the real one, under names that say nothing about it: the rule is about a
#: package with a door, not about the engine.
SEAM = Seam(
    door="pkg.things",
    insiders=("src/pkg/things", "tests/things"),
    importable_by=("src/pkg/__main__.py",),
    why="one door",
)


def write(root: Path, rel: str, source: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source)


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    write(tmp_path, "src/pkg/__init__.py", "")
    write(tmp_path, "src/pkg/things/__init__.py", 'from .inner import Open\n\n__all__ = ["Open"]\n')
    write(tmp_path, "src/pkg/things/inner.py", "class Open: ...\nclass Hidden: ...\n")
    return tmp_path


PAST = {
    "the interior, imported": "import pkg.things.inner\n",
    "the interior, aliased": "import pkg.things.inner as i\n",
    "a name from the interior": "from pkg.things.inner import Hidden\n",
    "a name the door exports, from the interior": "from pkg.things.inner import Open\n",
    "a submodule through the door": "from pkg.things import inner\n",
    "a name the door does not export": "from pkg.things import Hidden\n",
    "the interior as an attribute of the door": "import pkg.things as t\nX = t.inner.Hidden\n",
    "the interior as an attribute of the package": "import pkg\nX = pkg.things.inner.Hidden\n",
    "the interior, relatively": "from .things.inner import Hidden\n",
    "a submodule, relatively through the door": "from .things import inner\n",
    "the interior, imported lazily": "def f():\n    from pkg.things.inner import Hidden\n",
    "the interior, by importlib": 'import importlib\nm = importlib.import_module("pkg.things.inner")\n',
    "the interior, by a folded string": 'import importlib\nm = importlib.import_module("pkg.things." + "inner")\n',
}


@pytest.mark.parametrize("source", PAST.values(), ids=PAST.keys())
def test_refuses_a_reach_past_the_door(tree: Path, source: str) -> None:
    # from the one caller the door is FOR, so the refusal is about the reach and not about who knocked
    write(tree, "src/pkg/__main__.py", source)
    found = lines(tree, (SEAM,))
    assert found, f"the lint did not see: {source!r}"
    assert all(f.startswith("src/pkg/__main__.py:") and "is inside pkg.things" in f for f in found), found


def test_names_what_was_reached_for(tree: Path) -> None:
    write(tree, "src/pkg/__main__.py", '"""doc"""\n\nfrom pkg.things.inner import Hidden\n')
    assert lines(tree, (SEAM,)) == [
        "src/pkg/__main__.py:3 reaches pkg.things.inner, which is inside pkg.things: only its door may be imported"
    ]


def test_refuses_a_relative_reach_from_deeper_in_the_package(tree: Path) -> None:
    write(tree, "src/pkg/routes/health.py", "from ..things.inner import Hidden\n")
    assert [f.split(" ", 1)[0] for f in lines(tree, (SEAM,))] == ["src/pkg/routes/health.py:1"]


DOOR = {
    "the door's export": "from pkg.things import Open\n",
    "the door, imported": "import pkg.things\nX = pkg.things.Open\n",
    "the door, aliased": "import pkg.things as t\nX = t.Open\n",
    "the door, relatively": "from .things import Open\n",
    "the door from its package": "from pkg import things\n",
}


@pytest.mark.parametrize("source", DOOR.values(), ids=DOOR.keys())
def test_allows_the_door_to_its_declared_caller(tree: Path, source: str) -> None:
    write(tree, "src/pkg/__main__.py", source)
    assert lines(tree, (SEAM,)) == []


@pytest.mark.parametrize("source", DOOR.values(), ids=DOOR.keys())
def test_refuses_anybody_else_even_at_the_door(tree: Path, source: str) -> None:
    # the file is the right one, the CALLER is not: a route that could import the engine could start
    # a sweep from inside a request
    write(tree, "src/pkg/service.py", source)
    found = lines(tree, (SEAM,))
    assert found, f"the lint let a stranger through: {source!r}"
    assert all("which is reached by src/pkg/__main__.py alone" in f for f in found), found


def test_allows_the_interior_to_import_itself(tree: Path) -> None:
    write(tree, "src/pkg/things/sweeper.py", "from .inner import Hidden\nfrom pkg.things.inner import Open\n")
    assert lines(tree, (SEAM,)) == []


def test_allows_the_interior_to_reach_back_out_which_is_not_what_this_guards(tree: Path) -> None:
    write(tree, "src/pkg/things/sweeper.py", "from ..ports import SweeperPort\n")
    write(tree, "src/pkg/ports.py", "class SweeperPort: ...\n")
    assert lines(tree, (SEAM,)) == []


def test_allows_the_seams_own_tests_past_the_door(tree: Path) -> None:
    # the mirror of the TypeScript's tests BESIDE the module, inside the directory
    write(tree, "tests/things/test_inner.py", "from pkg.things.inner import Hidden\n")
    assert lines(tree, (SEAM,)) == []


def test_refuses_any_other_test_that_reaches_past_the_door(tree: Path) -> None:
    write(tree, "tests/routes/test_health.py", "from pkg.things.inner import Hidden\n")
    assert [f.split(" ", 1)[0] for f in lines(tree, (SEAM,))] == ["tests/routes/test_health.py:1"]


def test_is_quiet_about_a_package_that_merely_shares_a_prefix(tree: Path) -> None:
    write(tree, "src/pkg/service.py", "import pkg.thingsmith\nfrom pkg import thing\n")
    assert lines(tree, (SEAM,)) == []


def test_lets_a_docstring_say_it(tree: Path) -> None:
    write(tree, "src/pkg/service.py", '"""Never pkg.things.inner, only pkg.things."""\n')
    assert lines(tree, (SEAM,)) == []


def test_hands_out_nothing_through_a_door_with_no_all(tree: Path) -> None:
    # a name is handed out by being LISTED; a door that lists nothing exports nothing this lets by
    write(tree, "src/pkg/things/__init__.py", "from .inner import Open\n")
    write(tree, "src/pkg/__main__.py", "from pkg.things import Open\n")
    assert [f.split(" ", 2)[1] for f in lines(tree, (SEAM,))] == ["reaches"]


# --- the seams this backend declares --------------------------------------------------------------

#: What the TypeScript's door exports, as `engine/index.ts` writes it.
ENGINE_DOOR = {"MonitorSweeper", "SweeperDeps", "Scheduler", "STALE_AFTER_SWEEPS"}
#: What the Python's door exports that the TypeScript's leaves to the compiler: `startSweep`'s
#: watchdog is an object literal checked by its shape there, and a record built by name here.
PYTHON_ONLY = {"SweepWatchdog"}
#: What is not ported yet (ADR 0021, the first port). Written out, never derived, and it may only
#: shrink: a name leaves it in the change that ports its module, and the door is whole when it is
#: empty. Holding the door to the TypeScript's whole list less this is what keeps an unported name
#: ABSENT rather than stubbed.
NOT_YET = {"MonitorSweeper", "SweeperDeps"}


class TestTheSeamsThisBackendDeclares:
    def test_gives_every_seam_a_reason_and_a_caller(self) -> None:
        for seam in SEAMS:
            assert seam.why, f"{seam.door} has no reason"
            assert seam.importable_by, f"{seam.door} says nothing about who may knock"
        assert SEAMS

    def test_keeps_sweep_health_behind_the_engines_door_which_is_what_that_seam_is_for(self) -> None:
        # #230's mutation M7: a second health account built outside the engine described a service
        # whose /health says "starting" for ever while the sweeps run. Withholding the class closes it
        # — but only while the door keeps withholding it, which is this test, and only while nothing
        # can reach past the door, which is the lint above.
        engine = importlib.import_module(SEAMS[0].door)
        exported = set(engine.__all__)
        assert "SweepHealth" not in exported, "the engine's door exports SweepHealth again — M7 is reopened"
        assert not hasattr(engine, "SweepHealth")
        # nor under another name: the property is that the CLASS cannot be had, not the word
        for name in exported:
            value = getattr(engine, name)
            assert not (isinstance(value, type) and any(c.__name__ == "SweepHealth" for c in value.__mro__)), (
                f"the engine's door hands out SweepHealth as {name}"
            )
        # and it still hands out what `__main__` needs, so this is not passing by exporting nothing
        assert exported == (ENGINE_DOOR - NOT_YET) | PYTHON_ONLY
        assert all(hasattr(engine, name) for name in exported)

    def test_keeps_the_engine_main_only_which_widening_its_callers_would_not(self) -> None:
        # the TypeScript's mutation sweep found an exemption that could be widened from the inside
        # with every test green; this is what holds the list to its claim
        [engine] = [s for s in SEAMS if s.door == "optionality_backend.engine"]
        assert "src/optionality_backend/__main__.py" in engine.importable_by
        others = [f for f in engine.importable_by if f != "src/optionality_backend/__main__.py"]
        assert others == ["tests/test_seams.py"], "the engine admits a caller that is neither __main__ nor this guard"
        assert set(engine.insiders) == {"src/optionality_backend/engine", "tests/engine"}

    def test_reads_the_real_tree_and_finds_the_door(self) -> None:
        # an empty tree, or a door this lint cannot read, passes every rule while proving nothing
        [engine] = SEAMS
        assert door_exports(BACKEND, engine) == (ENGINE_DOOR - NOT_YET) | PYTHON_ONLY
        assert any(rel.parts[0] == "tests" for _, rel in python_files(BACKEND))
