"""The backend places, modifies, cancels and exercises no order (ADR 0021, Decision 8).

The TypeScript cannot trade because its IB Gateway client has no order message to send (ADR 0019).
The Python cannot say that: it reaches the gateway through `ib_async`, which was chosen BECAUSE it
can trade (Decision 7). Until a trading ADR designs it, three locks stand in for the missing
message: the gateway's Read-Only API switch, this lint, and the library's own (`ib_async`'s
`readonly=True` is not one — it skips two order fetches at connect and refuses nothing).

**What it refuses, and how the names were derived, is not written here.** The list and the reader
that applies it are the library's, `optionality.no_trading`, imported by name: the library holds
itself to the same rule now that the IB Gateway client is the library's, and one list cannot drift
from itself. The library's suite also re-derives the list from the installed `ib_async` and tests
the reader against every construction it refuses and allows. Read that module's docstring.

**What is the backend's own is the door.** The names are refused anywhere under
`python-backend/src/` except inside `optionality_backend/trading/`, and `DOOR` is asserted to be
exactly that directory and that directory asserted NOT TO EXIST. Creating it is the deliberate act
— an ADR, and an edit to this file that a reviewer sees — and nothing inside `src/` can widen the
exemption, because nothing inside `src/` is read to decide it. Checked against a FIXTURE TREE
rather than this repository, for `check-seams`' reason: a guard tested only against a clean tree
passes while holding nothing.
"""

from pathlib import Path

import pytest
from optionality.no_trading import breaches_in
from reading import python_files

BACKEND = Path(__file__).resolve().parents[1]
PACKAGE = "optionality_backend"
#: the one place an order may be named, relative to `src/`. It does not exist; see the docstring
DOOR = ("optionality_backend", "trading")


def through_the_door(rel: Path) -> bool:
    """Whether `rel` (relative to the backend) is a file INSIDE `src/optionality_backend/trading/`.
    Exactly that directory: not a `trading.py`, not a `trading/` anywhere else."""
    under_src = rel.parts[1:]
    return len(under_src) > len(DOOR) and under_src[: len(DOOR)] == DOOR


def breaches(root: Path) -> list[str]:
    """Every order reference in `root/src` outside the door, as `file:line what`."""
    lines = []
    for path, rel in python_files(root):
        if through_the_door(rel):
            continue
        lines += [f"{rel}:{line} {what}" for line, what in breaches_in(path.read_text())]
    return lines


def test_the_real_backend_places_no_order() -> None:
    found = breaches(BACKEND)
    assert found == [], (
        f"the backend names an order outside {'/'.join(DOOR)}/, which no ADR has created "
        "(ADR 0021, Decision 8):\n  " + "\n  ".join(found)
    )


def test_the_door_is_trading_and_nothing_else() -> None:
    """Widening the exemption means editing THIS line, which a reviewer sees, and an ADR."""
    assert DOOR == ("optionality_backend", "trading")


def test_the_door_does_not_exist_yet() -> None:
    """Creating `trading/` is the deliberate act ADR 0021 reserves for a trading ADR. When that ADR
    lands, it deletes this test in the same pull request — that is the door being opened."""
    door = BACKEND / "src" / Path(*DOOR)
    assert not door.exists() and not door.is_symlink(), f"{door} exists — which ADR created it?"


# --- the door, against a fixture tree ----------------------------------------------------------


def write(root: Path, rel: str, source: str) -> Path:
    path = root / "src" / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source)
    return path


#: one of each KIND of finding, enough to show the backend's walk applies the library's whole
#: reader — every construction the reader refuses is the library suite's to enumerate
REFUSED = {
    "a placement": "ib.placeOrder(contract, order)\n",
    "an order class imported": "from ib_async import LimitOrder\n",
    "the name kept in a string": "getattr(ib, 'place' + 'Order')(contract, order)\n",
    "PLACE_ORDER on the wire": "ib.client.send(3, 1, contract)\n",
    "exec": "exec('ib.reqGlobalCancel()')\n",
}


@pytest.mark.parametrize("source", REFUSED.values(), ids=REFUSED.keys())
def test_an_order_is_refused(tmp_path: Path, source: str) -> None:
    write(tmp_path, f"{PACKAGE}/vendors/ibkr.py", source)
    found = breaches(tmp_path)
    assert len(found) >= 1, f"the lint did not see: {source!r}"
    assert all(f.startswith(f"src/{PACKAGE}/vendors/ibkr.py:") for f in found), found


def test_a_finding_names_its_line_and_what_it_reached(tmp_path: Path) -> None:
    write(tmp_path, f"{PACKAGE}/vendors/ibkr.py", '"""The IB client."""\n\nib.placeOrder(contract, order)\n')
    assert breaches(tmp_path) == [f"src/{PACKAGE}/vendors/ibkr.py:3 references .placeOrder"]


def test_reading_the_market_is_allowed(tmp_path: Path) -> None:
    write(tmp_path, f"{PACKAGE}/vendors/ibkr.py", "from optionality.ibkr import IbkrClient\nclient.cancelMktData(7)\n")
    assert breaches(tmp_path) == []


def test_the_door_lets_an_order_through(tmp_path: Path) -> None:
    """The exemption WORKS, at any depth inside it — otherwise the trading ADR would find a door
    that does not open and widen something else."""
    write(tmp_path, f"{PACKAGE}/trading/__init__.py", "from ib_async import LimitOrder\n")
    write(tmp_path, f"{PACKAGE}/trading/spreads/place.py", "ib.placeOrder(contract, order)\n")
    assert breaches(tmp_path) == []


NOT_THE_DOOR = {
    "a module named for it": f"{PACKAGE}/trading.py",
    "a trading/ deeper down": f"{PACKAGE}/vendors/trading/place.py",
    "a name that starts with it": f"{PACKAGE}/trading_desk/place.py",
    "another capitalisation": f"{PACKAGE}/Trading/place.py",
    "a trading/ outside the package": "trading/place.py",
    "the package root itself": f"{PACKAGE}/__init__.py",
}


@pytest.mark.parametrize("rel", NOT_THE_DOOR.values(), ids=NOT_THE_DOOR.keys())
def test_only_the_door_is_the_door(tmp_path: Path, rel: str) -> None:
    write(tmp_path, rel, "ib.placeOrder(contract, order)\n")
    assert breaches(tmp_path) == [f"src/{rel}:1 references .placeOrder"]


def test_every_file_under_src_is_read(tmp_path: Path) -> None:
    write(tmp_path, f"{PACKAGE}/a/b/c/deep.py", "ib.cancelOrder(o)\n")
    write(tmp_path, "stray.py", "ib.reqGlobalCancel()\n")
    assert [f.split(":")[0] for f in breaches(tmp_path)] == [f"src/{PACKAGE}/a/b/c/deep.py", "src/stray.py"]
    assert python_files(tmp_path / "nowhere") == []


def test_the_list_is_the_librarys_and_is_not_copied_here() -> None:
    """ONE list. A second one written into this file would pass every test above while the two
    drift, which is what moving it into the library was for."""
    from optionality import no_trading

    tree = Path(__file__).read_text()
    for name in ("ORDER_CALLS", "ORDER_CLASSES", "FORBIDDEN", "WRITE_MESSAGES"):
        assert f"{name} =" not in tree, f"{name} is defined here as well as in optionality.no_trading"
    assert "placeOrder" in no_trading.ORDER_CALLS
