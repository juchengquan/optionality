"""A seam's interior is private: only its doors may be imported from outside it.

The Python's half of `tools/check-seams.mjs`, which states this rule inside the TypeScript backend and
cannot read Python. The same seams under the same rules, in one table, `SEAMS`, as that file keeps its
own: the vendors' door and the library's clients behind it, the alarm engine, and the delivery
surfaces in `entrypoints/` (ADR 0015, 0019, 0020, 0021). Where the TypeScript names `main.ts`, this
names `__main__`; where it names `testing/harness.ts` and the scenarios' `doors.ts`, this names
`tests/harness.py` and `tests/scenarios/backend.py`, the one place the Python's scenario runner builds
the backend.

**Why the vendors are a seam.** `open_vendors` opens each vendor ONCE and hands the Provider back
among the sources, which is what makes "one client either way" structural rather than remembered. IB
Gateway allows one connection per client id and the SECOND DISPLACES THE FIRST IN SILENCE, so a second
client is not an inefficiency, it is a provider that stops answering for reasons nobody can see — and
the cheapest way to fix a dashed row is to import the client that has the figure. ADR 0021 put the
clients in the library and kept what opens them here, because it reads Settings. So the rule is two
seams, as it is in `check-seams`: the backend's `vendors/` has one door, and each library client is a
seam with NO door, reached only by the vendor descriptors and their tests — the TypeScript's
`typescript/src/vendors/` with `insiders: ["backend/src/vendors"]`. A Python client is one module,
`optionality.<vendor>`, mapping and connection together, where the TypeScript's is a folder of files;
so where `check-seams` lets the case generator through `fields.ts`, nothing here needs a door at all.

**Why the engine's door is a seam.** A route or a bot command that could import the sweeper could
start a sweep from inside a request; they get the read-only `SweeperPort` in `deps` instead, which is
the health account's. And the door withholds the health account's CLASS, `SweepHealth`
(`engine/__init__.py` says why): #230's mutation sweep found that a freshly constructed one in
`main.ts` typechecked and passed every route, app and boot test while describing a service whose
/health says "starting" for ever as the sweeps run. The TypeScript closes that by making it
unwritable — the door does not export the class, and `check-seams` refuses any reach past the door,
so `main.ts` cannot name it and fails to compile. Withholding the name alone would hold nothing in
Python, where `optionality_backend.engine.health.SweepHealth` is one import away; so this file is the
other half, and the two together are the property: from outside the engine, the class cannot be named.

**Why `entrypoints/` is** (ADR 0020): delivery depends on the library and never the reverse, and
`__main__` is the one place that wires the two. It is the weakest of the three — it prevents a
direction of dependency nobody has violated, where the other two each close a measured failure — and
`entrypoints/http/__init__.py` should keep saying so. The rule sits on `entrypoints/` rather than on
each surface, because a rule per surface leaves a THIRD one unguarded until somebody remembers a line:
so every module and directory directly inside it must have a declared door, and a new surface with
none fails the day it arrives rather than the day something imports it.

What it refuses, from any file outside a seam's own code and its insiders:

* a reach PAST a door, in every spelling — `import ...engine.health`, `from ...engine.health import
  X`, a name the door's `__all__` does not list (`from ...engine import health`, a submodule, which
  Python hands out through the door's namespace), the same reached as an attribute of a door or a
  parent package, a relative import that resolves there, and a dotted name in a string, because
  `importlib.import_module` takes one;
* a door, or a package on the way to one, from anyone but `importable_by` where a seam names who may
  knock: the engine and the entrypoints are reached by `__main__` alone, and by the test support
  declared beside it, each with its reason.

And, before any import is read, the rules that cannot be relaxed by relaxing the rule:

* a door the seam's own `never` forbids — `check-seams`' mutation sweep found that naming a client as
  a door passed every test it had, because the fixtures declare their own seams;
* a door whose `__all__` lists a module inside the seam, which hands out the interior wholesale —
  Python's own hole, where a package's submodules are its attributes;
* an insider that is not another seam's own code, so naming the whole service to make a dashed row go
  away fails rather than opening every client to every route;
* a surface in `entrypoints/` with no door.

**A seam's own code** is its package and its tests at the mirrored path — `tests/engine/` for
`engine/`. The TypeScript keeps a module's tests BESIDE it, inside the directory, where they are
insiders by position; here they live in `tests/` (README, "Porting a module"). Derived from the seam's
directory and never declared, so it cannot be widened. Every other test is read like the service, as
`check-seams` reads a test outside a seam: "a suite that drives a client directly is how the seam
stops being the only way in". The table is written in PATHS, never in dotted names, so that it is not
itself a reach for the string rule.

It is a lint and not a sandbox: `type(sweeper.health)(...)` gets the class back from an instance, as
`sweeper.health.constructor` would in the TypeScript. What it stops is the accidental crossing and the
lazy deliberate one. Checked against a FIXTURE TREE as well as this repository, for `check-seams`'
reason: a guard tested only against a clean tree passes while holding nothing.
"""

import ast
import importlib
import importlib.util
import re
from dataclasses import dataclass
from pathlib import Path

import pytest
from reading import every_string

BACKEND = Path(__file__).resolve().parents[1]
#: where the lint reads, relative to the backend: the service and every test
READ = ("src", "tests")
#: the one file that wires the service's two halves, as `main.ts` is (ADR 0020)
MAIN = "src/optionality_backend/__main__.py"

type Dotted = tuple[str, ...]


def is_package_dir(path: Path) -> bool:
    """A directory Python could import, which a cache is not: `__pycache__` is an identifier too."""
    return path.is_dir() and path.name.isidentifier() and not path.name.startswith("__")


@dataclass(frozen=True)
class Seam:
    #: the package whose interior is private, as a path below an import root — the backend's
    #: `optionality_backend/engine` is `src/optionality_backend/engine` here — or one module, with its
    #: `.py`: the library's `optionality/ibkr.py`, reached by name from an installed package.
    dir: str
    #: the files in it that may be imported from outside, relative to `dir`; a package's door is its
    #: `__init__.py`. A door hands out what its `__all__` lists and nothing else.
    doors: tuple[str, ...]
    #: what may NEVER be a door, searched in "/" + the door: what the seam exists to keep in. None
    #: only where there is no door to widen, which a test pins.
    never: re.Pattern[str] | None
    #: printed when the rule is broken, because a guard that only says "refused" teaches the next
    #: person to delete it
    why: str
    #: the only files, relative to the backend, that may import a door at all. None is anyone.
    importable_by: tuple[str, ...] | None = None
    #: what may reach past the doors besides the seam's own code, relative to the backend: another
    #: seam's own code, and nothing else (`check-seams`' `insiders`)
    insiders: tuple[str, ...] = ()
    #: every module and directory directly inside `dir` is a SURFACE, and must have a declared door
    door_per_entry: bool = False


# --- the seams this backend declares -------------------------------------------------------------

#: The vendors whose clients are the library's: one `optionality.<name>` per folder in `vendors/`, as
#: each TypeScript client sits in `typescript/src/vendors/<name>/`. Derived rather than listed, so a
#: new vendor's client is behind the door the day its folder is; a test holds each to a module the
#: library actually has, so the derivation cannot be vacuous.
CLIENTS = tuple(sorted(p.name for p in (BACKEND / "src/optionality_backend/vendors").iterdir() if is_package_dir(p)))

VENDORS = Seam(
    dir="optionality_backend/vendors",
    # the door, and the only one: the descriptors are built into `VENDORS` there
    doors=("__init__.py",),
    # a descriptor is what `VENDORS` is built from, and a client is the connection itself; naming
    # either as a door is naming the thing the seam exists for. No client lives here since ADR 0021;
    # the pattern keeps one from coming back as a door if one does, as `check-seams`' does.
    never=re.compile(r"/(client|vendor)\.py$"),
    # anyone may knock, as in `check-seams`: `__main__` is the only caller today, but the rule is the
    # one client per vendor, not who asks for the door
    why=(
        "a vendor is reached through `open_vendors` (ADR 0015, 0019) — IB Gateway allows one connection "
        "per client id and the second displaces the first in silence"
    ),
)

LIBRARY_CLIENTS = tuple(
    Seam(
        dir=f"optionality/{client}.py",
        doors=(),
        never=None,
        # the descriptors, which build the clients from Settings, and their tests. Each must be a seam's
        # own code — `breaches` refuses one that is not — so naming `src/optionality_backend` here to
        # make a dashed row go away fails rather than opening every client to every route.
        insiders=("src/optionality_backend/vendors", "tests/vendors"),
        why=(
            "the library's vendor clients are opened by the backend's descriptors alone, which "
            "`open_vendors` reaches (ADR 0015, 0019, 0021) — IB Gateway allows one connection per client "
            "id and the second displaces the first in silence"
        ),
    )
    for client in CLIENTS
)

ENGINE = Seam(
    dir="optionality_backend/engine",
    doors=("__init__.py",),
    # nothing but the door, and `sweeper.py` least of all; `health.py` because the door withholds
    # `SweepHealth` and naming that file would hand the class back and reopen #230's mutation M7
    never=re.compile(r"/(sweeper|health|scheduler)\.py$"),
    importable_by=(
        MAIN,
        # this guard's own test, which imports the door to assert it still withholds the health
        # account's class. Declared rather than exempted as a class: "any test may reach in" is how
        # the engine stops being main-only.
        "tests/test_seams.py",
        # the door scenarios (ADR 0021): a sweep scenario is one tick of the REAL engine on a stated
        # world, so the file that builds it must build a `MonitorSweeper` as `__main__` does —
        # `doors.ts`, declared in `check-seams` for the same reason. It gets the door's exports and
        # nothing more: `SweepHealth` stays withheld.
        "tests/scenarios/backend.py",
    ),
    why=(
        "the engine is reached by `__main__` alone; a request must not be able to start a sweep, "
        "and the door withholds SweepHealth so a second health account cannot be built"
    ),
)

ENTRYPOINTS = Seam(
    dir="optionality_backend/entrypoints",
    # the HTTP layer's package door, and the bot's MODULE door, `bot/bot.py`, as `check-seams` declares
    # `bot/bot.ts`: it lists `TelegramBot` and what `__main__` builds one with, and the command table
    # and the formatter stay behind it
    doors=("http/__init__.py", "bot/bot.py"),
    # a route mounted from anywhere but `app.py`, or mounted twice, is the one thing in this layer that
    # would be hard to see
    never=re.compile(r"/(app\.py|routes/.*)$"),
    # who may use a door AT ALL: the direction, not the file. `__main__` is the one wiring;
    # `tests/harness.py` builds the app for a test, as `testing/harness.ts` does; and the scenarios'
    # seam opens both surfaces on a stated world beside the real engine, as `doors.ts` does. Test
    # support, declared each with its reason — a blanket "anything under tests/" would be a hole with
    # a comment.
    importable_by=(MAIN, "tests/harness.py", "tests/scenarios/backend.py"),
    # on `entrypoints/` rather than per surface, so a third surface — a CLI, a worker — cannot arrive
    # unguarded: `hc.types.ts`'s "complete by diligence" failure, closed in advance
    door_per_entry=True,
    why=(
        "delivery depends on the library and never the reverse (ADR 0020); `__main__` is the only "
        "wiring, and a request must not reach another surface's routes"
    ),
)

SEAMS = (VENDORS, *LIBRARY_CLIENTS, ENGINE, ENTRYPOINTS)


# --- the lint ------------------------------------------------------------------------------------


def dotted(path: str) -> Dotted:
    """A module's path as the name it is imported by: `a/b/__init__.py` is `a.b`, `a/b/c.py` `a.b.c`."""
    parts = tuple(path.removesuffix(".py").split("/"))
    return parts[:-1] if parts[-1] == "__init__" else parts


def spelled(name: Dotted) -> str:
    return ".".join(name)


def own_code(root: Path, seam: Seam) -> tuple[str, ...]:
    """Where a seam's own code lives in `root`: its package under `src/`, and its tests at the mirrored
    path under `tests/`. None for a seam in another package — the library's clients have no code in
    this tree, and are reached only by their insiders."""
    top, *rest = seam.dir.split("/")
    if not rest or not (root / "src" / top).is_dir():
        return ()
    if seam.dir.endswith(".py"):
        *where, module = rest
        return (f"src/{seam.dir}", "/".join(["tests", *where, f"test_{module}"]))
    return (f"src/{seam.dir}", "/".join(["tests", *rest]))


def listed(path: Path) -> set[str]:
    """The names a door's `__all__` lists, read from its source. A door with no `__all__` hands out
    nothing this lint will let through: a name is handed out by being listed. A door not written yet
    lists nothing either."""
    if not path.is_file():
        return set()
    for node in ast.walk(ast.parse(path.read_text())):
        targets = (
            node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        )
        if any(isinstance(t, ast.Name) and t.id == "__all__" for t in targets):
            return {e.value for e in getattr(node.value, "elts", []) if isinstance(e, ast.Constant)}
    return set()


def doors_of(root: Path, seam: Seam) -> dict[Dotted, set[str]]:
    """Each door, by the name it is imported by, and what its `__all__` lists."""
    return {dotted(f"{seam.dir}/{door}"): listed(root / "src" / seam.dir / door) for door in seam.doors}


def crossing(full: Dotted, interior: Dotted, doors: dict[Dotted, set[str]]) -> tuple[str, Dotted] | None:
    """What the dotted name `full` does to a seam: ("door", what it named) when it names a door, a name
    a door lists, or a package on the way to a door; ("past", the first part of it that is none of
    those) when it reaches inside; None when it is not the seam's at all."""
    if full[: len(interior)] != interior:
        return None
    for i in range(len(interior), len(full) + 1):
        head = full[:i]
        if head in doors:
            if i == len(full) or full[i] in doors[head]:
                return "door", head
            return "past", full[: i + 1]
        if not any(door[:i] == head for door in doors):
            return "past", head
    return "door", full


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


def past(root: Path, seam: Seam, doors: dict[Dotted, set[str]], reached: Dotted) -> str:
    """What to say about a reach past the doors, so the message says what would have been allowed."""
    if not doors:
        return f"reaches {spelled(reached)}, which has no door: only {', '.join(seam.insiders)} may reach in"
    inside = f"reaches {spelled(reached)}, which is inside {spelled(dotted(seam.dir))}"
    door, name = reached[:-1], reached[-1]
    if door in doors and not is_module(root, reached):
        return f"{inside}: the door {spelled(door)} does not list {name} in `__all__`"
    return (
        f"{inside}: only its door{'s' if len(doors) > 1 else ''} {', '.join(spelled(d) for d in doors)} may be imported"
    )


def file_breaches(root: Path, rel: Path, seam: Seam, doors: dict[Dotted, set[str]]) -> list[tuple[int, str]]:
    interior = dotted(seam.dir)
    may_knock = seam.importable_by is None or str(rel) in seam.importable_by
    found: set[tuple[int, str]] = set()
    #: what each local name was bound to by an import, so `e.health` is read as the engine's
    bound: dict[str, Dotted] = {}

    def refer(line: int, full: Dotted, depth: int = 0) -> None:
        """`depth` is how much of `full` the import already named; a crossing inside it was found
        there."""
        what = crossing(full, interior, doors)
        if what is None:
            return
        kind, prefix = what
        if len(prefix) <= depth:
            return
        if kind == "past":
            found.add((line, past(root, seam, doors, prefix)))
        elif not may_knock:
            reached_by = ", ".join(seam.importable_by or ())
            found.add((line, f"imports {spelled(prefix)}, which is reached by {reached_by} alone"))

    tree = ast.parse((root / rel).read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                parts = tuple(alias.name.split("."))
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
                full = tuple(module.split(".")) if alias.name == "*" else (*module.split("."), alias.name)
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
                refer(node.lineno, (*base, *reversed(chain)), depth=len(base))

    for _, strings in every_string(tree):
        for line, value in strings:
            if value and all(c.isalnum() or c in "._" for c in value):
                refer(line, tuple(value.split(".")))
    return sorted(found)


def is_module(root: Path, name: Dotted) -> bool:
    base = root / "src" / Path(*name)
    return base.is_dir() or base.with_suffix(".py").is_file()


def handed_out(root: Path, seam: Seam, door: str) -> list[str]:
    """The names a door's `__all__` lists that the door bound to a MODULE of its own seam — `from .
    import health`, then `"health"` in `__all__` — which would let the interior out through the door."""
    rel = Path("src", seam.dir, door)
    if not (root / rel).is_file():
        return []
    tree = ast.parse((root / rel).read_text())
    exports, interior = listed(root / rel), dotted(seam.dir)
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (module := resolved(node, rel)) is not None:
            names = [(a.asname or a.name, (*module.split("."), a.name)) for a in node.names if a.name != "*"]
        elif isinstance(node, ast.Import):
            names = [(a.asname, tuple(a.name.split("."))) for a in node.names if a.asname]
        else:
            continue
        for local, target in names:
            if local in exports and target[: len(interior)] == interior and is_module(root, target):
                out.add(local)
    return sorted(out)


def table_breaches(root: Path, seam: Seam, seams: tuple[Seam, ...]) -> list[str]:
    """What is wrong with the seam's own declaration, before any import is read: the rules that cannot
    be relaxed by relaxing the rule."""
    found = []
    for door in seam.doors:
        if seam.never is not None and seam.never.search(f"/{door}"):
            found.append(f'{seam.dir}/: "{door}" is named as a door, and {seam.never.pattern} may never be one')
        for name in handed_out(root, seam, door):
            found.append(
                f'{seam.dir}/{door}: lists "{name}" in `__all__`, which is a module inside '
                f"{spelled(dotted(seam.dir))}: a door hands out names, never the interior"
            )
    # an insider reaches the whole interior, so naming a bare directory would hand it to everything there
    owned = {place for s in seams for place in own_code(root, s)}
    for insider in seam.insiders:
        if insider not in owned:
            found.append(
                f'{seam.dir}/: "{insider}" is named as an insider and is not a seam\'s own code, so what it '
                "reaches would have no door"
            )
    base = root / "src" / seam.dir
    if seam.door_per_entry and base.is_dir():
        for entry in sorted(base.iterdir()):
            surface = is_package_dir(entry) or entry.suffix == ".py" and entry.name != "__init__.py"
            if surface and not any(door == entry.name or door.startswith(f"{entry.name}/") for door in seam.doors):
                found.append(
                    f"{seam.dir}/{entry.name}: a surface with no door — declare its door in SEAMS, with its reason"
                )
    return found


def python_files(root: Path) -> list[tuple[Path, Path]]:
    return [(p, p.relative_to(root)) for top in READ for p in sorted((root / top).rglob("*.py"))]


def breaches(root: Path, seams: tuple[Seam, ...] = SEAMS) -> list[tuple[Seam, str]]:
    """Every crossing in `root`, as the seam it crosses and `file:line what` — or `dir/: what` for a
    declaration that breaks its own seam. `root` is shaped like `python-backend/`, so a fixture tree
    and the real one are read the same way."""
    out = []
    files = python_files(root)
    for seam in seams:
        out += [(seam, line) for line in table_breaches(root, seam, seams)]
        doors = doors_of(root, seam)
        exempt = (*own_code(root, seam), *seam.insiders)
        for _, rel in files:
            if any(rel.is_relative_to(place) for place in exempt):
                continue
            out += [(seam, f"{rel}:{line} {what}") for line, what in file_breaches(root, rel, seam, doors)]
    return out


def lines(root: Path, seams: tuple[Seam, ...]) -> list[str]:
    return [line for _, line in breaches(root, seams)]


def test_the_real_backend_keeps_to_its_seams() -> None:
    found = breaches(BACKEND)
    assert found == [], "\n".join(f"{line}\n    because {seam.why}" for seam, line in found)


# --- the fixture tree: one door ------------------------------------------------------------------

#: One seam shaped like the engine, under names that say nothing about it: the rule is about a package
#: with a door, not about the engine.
SEAM = Seam(
    dir="pkg/things",
    doors=("__init__.py",),
    never=re.compile(r"/inner\.py$"),
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


def test_names_what_was_reached_for_and_where_the_door_is(tree: Path) -> None:
    write(tree, "src/pkg/__main__.py", '"""doc"""\n\nfrom pkg.things.inner import Hidden\n')
    assert lines(tree, (SEAM,)) == [
        (
            "src/pkg/__main__.py:3 reaches pkg.things.inner, which is inside pkg.things: only its door pkg.things "
            "may be imported"
        )
    ]


def test_names_the_door_that_does_not_list_a_name(tree: Path) -> None:
    # what a port meets when it writes a door and forgets its `__all__`: the message says which line
    write(tree, "src/pkg/__main__.py", "from pkg.things import Hidden\n")
    assert lines(tree, (SEAM,)) == [
        (
            "src/pkg/__main__.py:1 reaches pkg.things.Hidden, which is inside pkg.things: the door pkg.things does not "
            "list Hidden in `__all__`"
        )
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


@pytest.mark.parametrize("source", DOOR.values(), ids=DOOR.keys())
def test_lets_anyone_through_the_door_when_the_seam_names_no_caller_which_is_the_vendors(
    tree: Path, source: str
) -> None:
    write(tree, "src/pkg/service.py", source)
    assert lines(tree, (Seam(dir="pkg/things", doors=("__init__.py",), never=None, why="any"),)) == []


def test_still_refuses_a_reach_past_the_door_when_anyone_may_knock(tree: Path) -> None:
    # naming no caller widens who may use the door, never what is behind it
    write(tree, "src/pkg/service.py", "from pkg.things.inner import Hidden\n")
    anyone = Seam(dir="pkg/things", doors=("__init__.py",), never=None, why="any")
    assert [f.split(" ", 2)[1] for f in lines(tree, (anyone,))] == ["reaches"]


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
    write(tree, "tests/test_things.py", "from pkg.things.inner import Hidden\n")
    assert [f.split(" ", 1)[0] for f in lines(tree, (SEAM,))] == [
        "tests/routes/test_health.py:1",
        "tests/test_things.py:1",
    ]


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


# --- a door the seam itself forbids, and a door that hands out its interior -----------------------


def test_refuses_a_door_the_seam_forbids_so_the_rule_cannot_be_relaxed_by_relaxing_the_rule(tree: Path) -> None:
    # the mutation that found this in `check-seams`: adding a client to the door list passed every
    # test it had, because the fixtures declare their own seam and nothing looked at the list itself
    widened = Seam(dir="pkg/things", doors=("__init__.py", "inner.py"), never=re.compile(r"/inner\.py$"), why="x")
    assert lines(tree, (widened,)) == ['pkg/things/: "inner.py" is named as a door, and /inner\\.py$ may never be one']


def test_says_nothing_when_every_door_is_allowed(tree: Path) -> None:
    assert lines(tree, (SEAM,)) == []


HANDED_OUT = {
    "a submodule": 'from . import inner\nfrom .inner import Open\n\n__all__ = ["Open", "inner"]\n',
    "a submodule, renamed": 'from . import inner as deep\n\n__all__ = ["deep"]\n',
    "a submodule, by its full name": 'import pkg.things.inner as deep\n\n__all__ = ["deep"]\n',
    "a package inside": 'from .sub import more\n\n__all__ = ["more"]\n',
}


@pytest.mark.parametrize("source", HANDED_OUT.values(), ids=HANDED_OUT.keys())
def test_refuses_a_door_that_lists_a_module_of_its_seam(tree: Path, source: str) -> None:
    # Python's own hole: a submodule is an attribute of its package, so a door listing one hands out
    # everything behind it — `from pkg.things import inner` would pass as the door's export, and
    # `inner.Hidden` with it
    write(tree, "src/pkg/things/sub/more.py", "")
    write(tree, "src/pkg/things/__init__.py", source)
    found = lines(tree, (SEAM,))
    assert len(found) == 1 and found[0].startswith("pkg/things/__init__.py: lists "), found
    assert "a module inside pkg.things" in found[0]


def test_lets_a_door_list_a_module_that_is_not_its_seams(tree: Path) -> None:
    write(tree, "src/pkg/ports.py", "")
    write(tree, "src/pkg/things/__init__.py", 'from .. import ports\n\n__all__ = ["ports"]\n')
    assert lines(tree, (SEAM,)) == []


# --- the fixture tree: several doors, and the surfaces --------------------------------------------

#: Shaped like `entrypoints/`: two surfaces, one door each, one a package and one a module.
SURFACES = Seam(
    dir="pkg/surfaces",
    doors=("web/__init__.py", "chat/door.py"),
    never=re.compile(r"/(app\.py|routes/.*)$"),
    importable_by=("src/pkg/__main__.py",),
    door_per_entry=True,
    why="two surfaces",
)


@pytest.fixture
def surfaces(tmp_path: Path) -> Path:
    write(tmp_path, "src/pkg/__init__.py", "")
    write(tmp_path, "src/pkg/surfaces/web/__init__.py", 'from .app import serve\n\n__all__ = ["serve"]\n')
    write(tmp_path, "src/pkg/surfaces/web/app.py", "def serve(): ...\ndef hidden(): ...\n")
    write(tmp_path, "src/pkg/surfaces/web/routes/one.py", "")
    write(
        tmp_path,
        "src/pkg/surfaces/chat/door.py",
        'from .commands import table\n\n__all__ = ["Chat"]\n\nclass Chat: ...\n',
    )
    write(tmp_path, "src/pkg/surfaces/chat/commands.py", "table = {}\n")
    return tmp_path


AT_A_DOOR = {
    "a package door's export": "from pkg.surfaces.web import serve\n",
    "a module door's export": "from pkg.surfaces.chat.door import Chat\n",
    "a package door": "from pkg.surfaces import web\n",
    "a module door": "from pkg.surfaces.chat import door\n",
    "a module door, aliased": "import pkg.surfaces.chat.door as d\nX = d.Chat\n",
    "a door, relatively": "from .surfaces.web import serve\n",
    "the way to a door": "import pkg.surfaces\nX = pkg.surfaces.web.serve\n",
    "the package on the way to a door": "from pkg.surfaces import chat\nX = chat.door.Chat\n",
}


@pytest.mark.parametrize("source", AT_A_DOOR.values(), ids=AT_A_DOOR.keys())
def test_allows_either_door_to_its_declared_caller(surfaces: Path, source: str) -> None:
    write(surfaces, "src/pkg/__main__.py", source)
    assert lines(surfaces, (SURFACES,)) == []


@pytest.mark.parametrize("source", AT_A_DOOR.values(), ids=AT_A_DOOR.keys())
def test_refuses_a_stranger_at_either_door_or_on_the_way_to_one(surfaces: Path, source: str) -> None:
    # a service that could import a delivery surface is a library that depends on delivery (ADR 0020)
    write(surfaces, "src/pkg/service.py", source)
    found = lines(surfaces, (SURFACES,))
    assert found, f"the lint let a stranger through: {source!r}"
    assert all("which is reached by src/pkg/__main__.py alone" in f for f in found), found


PAST_A_SURFACE = {
    "the app behind a package door": "from pkg.surfaces.web.app import hidden\n",
    "the app, through the door": "from pkg.surfaces.web import app\n",
    "a route": "from pkg.surfaces.web.routes import one\n",
    "a route, by importlib": 'import importlib\nm = importlib.import_module("pkg.surfaces.web.routes.one")\n',
    "a name a module door imported and does not list": "from pkg.surfaces.chat.door import table\n",
    "a module beside a module door": "from pkg.surfaces.chat import commands\n",
    "a module beside a module door, as an attribute": "import pkg.surfaces\nX = pkg.surfaces.chat.commands.table\n",
    "a surface nobody declared": "from pkg.surfaces import cli\n",
}


@pytest.mark.parametrize("source", PAST_A_SURFACE.values(), ids=PAST_A_SURFACE.keys())
def test_refuses_a_reach_past_either_door(surfaces: Path, source: str) -> None:
    write(surfaces, "src/pkg/__main__.py", source)
    found = lines(surfaces, (SURFACES,))
    assert found, f"the lint did not see: {source!r}"
    assert all("is inside pkg.surfaces" in f for f in found), found


def test_names_every_door_when_one_is_reached_past(surfaces: Path) -> None:
    write(surfaces, "src/pkg/__main__.py", "from pkg.surfaces.web.routes import one\n")
    assert lines(surfaces, (SURFACES,)) == [
        (
            "src/pkg/__main__.py:1 reaches pkg.surfaces.web.routes, which is inside pkg.surfaces: only its doors "
            "pkg.surfaces.web, pkg.surfaces.chat.door may be imported"
        )
    ]


def test_allows_one_surface_to_reach_another_which_is_the_interior_importing_itself(surfaces: Path) -> None:
    write(surfaces, "src/pkg/surfaces/chat/commands.py", "from ..web.app import hidden\n")
    assert lines(surfaces, (SURFACES,)) == []


def test_refuses_a_door_the_surfaces_forbid(surfaces: Path) -> None:
    widened = Seam(**{**SURFACES.__dict__, "doors": (*SURFACES.doors, "web/routes/one.py")})
    assert lines(surfaces, (widened,)) == [
        'pkg/surfaces/: "web/routes/one.py" is named as a door, and /(app\\.py|routes/.*)$ may never be one'
    ]


NEW_SURFACE = {
    "a package": ("src/pkg/surfaces/cli/__init__.py", "pkg/surfaces/cli"),
    "a directory with no __init__": ("src/pkg/surfaces/cli/main.py", "pkg/surfaces/cli"),
    "a module": ("src/pkg/surfaces/cron.py", "pkg/surfaces/cron.py"),
    "one whose name a door's merely starts with": ("src/pkg/surfaces/webhooks/hook.py", "pkg/surfaces/webhooks"),
}


@pytest.mark.parametrize(("path", "named"), NEW_SURFACE.values(), ids=NEW_SURFACE.keys())
def test_refuses_a_new_surface_with_no_door_declared(surfaces: Path, path: str, named: str) -> None:
    # ADR 0020's reason for putting the rule on the directory: a third surface added with no line in
    # SEAMS would be unguarded until somebody remembered. It fails the day it arrives instead — before
    # anything imports it, which is when the reach rule alone would notice.
    write(surfaces, path, "")
    assert lines(surfaces, (SURFACES,)) == [
        f"{named}: a surface with no door — declare its door in SEAMS, with its reason"
    ]


def test_counts_neither_a_package_marker_nor_a_cache_as_a_surface(surfaces: Path) -> None:
    write(surfaces, "src/pkg/surfaces/__init__.py", "")
    write(surfaces, "src/pkg/surfaces/__pycache__/door.cpython-312.pyc", "")
    assert lines(surfaces, (SURFACES,)) == []


def test_asks_nothing_of_the_directories_of_a_seam_that_does_not_ask(tree: Path) -> None:
    # the vendors' folders are descriptors, not surfaces, and have no door each
    write(tree, "src/pkg/things/one/vendor.py", "")
    assert lines(tree, (SEAM,)) == []


# --- the fixture tree: a seam in another package, reached through its insiders ---------------------

#: Shaped like the library's clients: a module of ANOTHER package, with no door, that only the `things`
#: seam's own code may reach.
CLIENT = Seam(dir="lib/client.py", doors=(), never=None, insiders=("src/pkg/things", "tests/things"), why="opened once")

INTO_THE_CLIENT = {
    "the client, imported": "import lib.client\n",
    "a name from it": "from lib.client import Client\n",
    "it, from its package": "from lib import client\n",
    "it, aliased": "from lib import client as c\n",
    "it, as an attribute": "import lib\nX = lib.client.Client\n",
    "it, imported lazily": "def f():\n    from lib.client import Client\n",
    "it, by importlib": 'import importlib\nm = importlib.import_module("lib.client")\n',
}


@pytest.mark.parametrize("source", INTO_THE_CLIENT.values(), ids=INTO_THE_CLIENT.keys())
def test_refuses_a_reach_into_a_seam_with_no_door_from_anyone_but_its_insiders(tree: Path, source: str) -> None:
    # `__main__` included: a seam with no door has no caller to declare
    write(tree, "src/pkg/__main__.py", source)
    found = lines(tree, (SEAM, CLIENT))
    assert found, f"the lint did not see: {source!r}"
    assert all(
        f.endswith("reaches lib.client, which has no door: only src/pkg/things, tests/things may reach in")
        for f in found
    )


def test_lets_its_insiders_reach_in_and_only_them(tree: Path) -> None:
    write(tree, "src/pkg/things/one/vendor.py", "from lib.client import Client\n")
    write(tree, "tests/things/one/test_vendor.py", "from lib.client import Client\n")
    write(tree, "src/pkg/sweeper.py", "from lib.client import Client\n")
    write(tree, "tests/test_sweeper.py", "from lib.client import Client\n")
    assert [f.split(" ", 1)[0] for f in lines(tree, (SEAM, CLIENT))] == [
        "src/pkg/sweeper.py:1",
        "tests/test_sweeper.py:1",
    ]


def test_is_quiet_about_the_rest_of_the_other_package(tree: Path) -> None:
    write(tree, "src/pkg/service.py", "import lib\nfrom lib import quote\nimport lib.clientele\nX = lib.version\n")
    assert lines(tree, (SEAM, CLIENT)) == []


def test_refuses_an_insider_that_is_not_a_seams_own_code_so_the_interior_cannot_leak(tree: Path) -> None:
    # the cheap fix for a dashed row, one level up: naming the whole service as an insider
    leaky = Seam(**{**CLIENT.__dict__, "insiders": ("src/pkg",)})
    assert lines(tree, (SEAM, leaky)) == [
        (
            'lib/client.py/: "src/pkg" is named as an insider and is not a seam\'s own code, so what it reaches '
            "would have no door"
        )
    ]


def test_refuses_an_insider_whose_seam_is_not_declared(tree: Path) -> None:
    # `tests/things` is only a seam's own code while `pkg/things` is a seam: delete that seam and the
    # client's insiders are two bare directories
    assert [f.split(" ", 2)[1] for f in lines(tree, (CLIENT,))] == ['"src/pkg/things"', '"tests/things"']


# --- the seams this backend declares --------------------------------------------------------------

#: What the TypeScript's door exports, as `engine/index.ts` writes it.
ENGINE_DOOR = {"MonitorSweeper", "SweeperDeps", "Scheduler", "STALE_AFTER_SWEEPS"}
#: What the Python's door exports that the TypeScript's leaves to the compiler: `startSweep`'s
#: watchdog is an object literal checked by its shape there, and a record built by name here. (A
#: `NOT_YET` stood beside these while the sweeper was unported; the door is whole, so it went.)
PYTHON_ONLY = {"SweepWatchdog"}


def files_in(seam: Seam) -> list[str]:
    """Every module in a seam of this backend, relative to its directory, as `never` reads a door."""
    base = BACKEND / "src" / seam.dir
    return sorted(str(p.relative_to(base)) for p in base.rglob("*.py"))


class TestTheSeamsThisBackendDeclares:
    def test_gives_every_seam_a_reason_and_every_door_a_never(self) -> None:
        # a seam with no `why` prints nothing when it fails, which is how a guard gets deleted
        for seam in SEAMS:
            assert seam.why, f"{seam.dir} has no reason"
            assert seam.never is not None or not seam.doors, f"{seam.dir} says nothing about what may not be a door"
        assert SEAMS

    def test_has_a_never_that_matches_something_in_the_tree_it_guards(self) -> None:
        # the half a filter can fail silently: a pattern matching NOTHING forbids nothing, and would
        # pass the test above while leaving every door open
        for seam in (s for s in SEAMS if s.never is not None):
            forbidden = [f for f in files_in(seam) if seam.never.search(f"/{f}")]
            assert forbidden, f"{seam.dir}: {seam.never.pattern} matches no file there"
            assert not set(forbidden) & set(seam.doors)

    def test_keeps_sweep_health_behind_the_engines_door_which_is_what_that_seam_is_for(self) -> None:
        # #230's mutation M7: a second health account built outside the engine described a service
        # whose /health says "starting" for ever while the sweeps run. Withholding the class closes it
        # — but only while the door keeps withholding it, which is this test, and only while nothing
        # can reach past the door, which is the lint above.
        engine = importlib.import_module(spelled(dotted(ENGINE.dir)))
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
        assert exported == ENGINE_DOOR | PYTHON_ONLY
        assert all(hasattr(engine, name) for name in exported)

    def test_keeps_the_two_main_only_seams_main_only_which_widening_their_callers_would_not(self) -> None:
        # the TypeScript's mutation sweep found an exemption that could be widened from the inside with
        # every test green, and that removing the caller list altogether passed as well — "anyone may"
        # is a legitimate state for the vendors. Both seams claim main-only in their own `why`; this is
        # what holds them to it, caller by caller.
        callers = {
            ENGINE: ["tests/test_seams.py", "tests/scenarios/backend.py"],
            ENTRYPOINTS: ["tests/harness.py", "tests/scenarios/backend.py"],
        }
        for seam, others in callers.items():
            assert seam in SEAMS, f"{seam.dir} is no longer a declared seam"
            assert seam.importable_by is not None, f"{seam.dir} no longer says who may knock"
            assert MAIN in seam.importable_by, f"{seam.dir} is no longer reached by __main__"
            assert [f for f in seam.importable_by if f != MAIN] == others, (
                f"{seam.dir} admits a caller that is neither __main__ nor the test support declared for it"
            )

    def test_declares_a_door_for_every_surface_in_entrypoints_so_a_new_one_cannot_arrive_unguarded(self) -> None:
        # ADR 0020: a third entrypoint added with no line in SEAMS would be unguarded until somebody
        # remembered. The rule is the seam's `door_per_entry`, which deleting would quietly drop.
        assert ENTRYPOINTS in SEAMS, "the entrypoints seam is gone"
        assert ENTRYPOINTS.door_per_entry, "entrypoints/ no longer asks every surface for a door"
        base = BACKEND / "src" / ENTRYPOINTS.dir
        surfaces = [
            p.name for p in base.iterdir() if is_package_dir(p) or p.suffix == ".py" and p.name != "__init__.py"
        ]
        # http and bot today; never none, or the rule above holds over nothing
        assert surfaces, "entrypoints/ holds no surfaces at all"

    def test_keeps_the_librarys_vendor_clients_behind_the_backends_vendor_door(self) -> None:
        # Every field here is one a mutation could change with the fixtures still green, because they
        # declare their own seams: a door on a client, or insiders grown past the descriptors, hands the
        # clients to the whole service.
        assert VENDORS in SEAMS and VENDORS.doors == ("__init__.py",), "the vendor door has grown a second way in"
        found = importlib.util.find_spec("optionality")
        assert found is not None and found.submodule_search_locations
        library = Path(found.submodule_search_locations[0])
        assert CLIENTS, "no vendor folder was found, so no client is held"
        assert [s.dir for s in SEAMS if s in LIBRARY_CLIENTS] == [f"optionality/{c}.py" for c in CLIENTS]
        for seam in LIBRARY_CLIENTS:
            assert (library / Path(seam.dir).name).is_file(), f"the library has no {seam.dir} for its vendor folder"
            assert seam.doors == (), f"{seam.dir} has grown a door"
            assert seam.insiders == own_code(BACKEND, VENDORS), f"something besides the descriptors may open {seam.dir}"

    def test_reads_the_real_tree_and_finds_the_doors(self) -> None:
        # an empty tree, or a door this lint cannot read, passes every rule while proving nothing
        assert doors_of(BACKEND, ENGINE) == {dotted(ENGINE.dir): ENGINE_DOOR | PYTHON_ONLY}
        assert any(rel.parts[0] == "tests" for _, rel in python_files(BACKEND))
        # and every door that is written lists what it hands out, or `__main__` could use none of it
        for seam in SEAMS:
            for door in seam.doors:
                if (BACKEND / "src" / seam.dir / door).is_file():
                    assert listed(BACKEND / "src" / seam.dir / door), f"{seam.dir}/{door} has no `__all__`"
