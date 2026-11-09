"""The library places, modifies, cancels and exercises no order (ADR 0021, Decision 8).

`optionality.ibkr` holds an `ib_async` connection, and `ib_async` can trade, so this package is
held to the rule the backend is: every name in `optionality.no_trading` refused, ANYWHERE under
`python/src` — the library has no `trading/` door and none is planned, because trading would be the
backend's. The list and the reader are `optionality.no_trading`'s, shared with
`python-backend/tests/test_no_trading.py`, which imports them; their docstring says what is refused
and why.

Three things are held here and nowhere else, because they are about the list rather than about
either package's tree:

* the DERIVATION — `derive()` reads the installed `ib_async`'s source and the written-down list
  must equal what it says, so an upgrade that adds an order method fails here until it is refused.
  `ib_async` is this package's own `ibkr` extra, installed by its dev group, so it is never skipped.
* the READER — what each refused and allowed construction looks like, against fixture sources,
  because a guard tested only against a clean tree passes while holding nothing.
* the one EXEMPTION — `optionality/no_trading.py` may name the names in strings, because its tables
  are the names. Fixed here to that one file, and only its strings: an order CALLED there is still
  refused.
"""

import ast
import importlib.util
import re
from pathlib import Path

import pytest

from optionality.no_trading import (
    FORBIDDEN,
    KNOWN_MESSAGES,
    ORDER_CALLS,
    ORDER_CLASSES,
    READ_CLASSES,
    WRITE_MESSAGES,
    an_int,
    breaches_in,
    docstrings,
    every_string,
    folded,
)

SRC = Path(__file__).resolve().parents[1] / "src"
#: the one file that may NAME an order in a string, relative to `src/`: it is the list
THE_LIST = ("optionality", "no_trading.py")


def library_breaches(src: Path) -> list[str]:
    """Every order reference in the tree under `src`, as `file:line what`."""
    found = []
    for path in sorted(src.rglob("*.py")):
        rel = path.relative_to(src)
        hits = breaches_in(path.read_text(), strings=rel.parts != THE_LIST)
        found += [f"{rel.as_posix()}:{line} {what}" for line, what in hits]
    return found


def test_the_real_library_places_no_order() -> None:
    files = list(SRC.rglob("*.py"))
    # there IS something to read, and the client is in it: an empty walk would pass while holding nothing
    assert SRC / "optionality" / "ibkr.py" in files and len(files) >= 20, f"only {len(files)} files under {SRC}"
    found = library_breaches(SRC)
    assert found == [], "the library names an order (ADR 0021, Decision 8):\n  " + "\n  ".join(found)


def test_the_exemption_is_the_list_and_nothing_else() -> None:
    """Widening it means editing THIS line, which a reviewer sees."""
    assert THE_LIST == ("optionality", "no_trading.py")
    assert (SRC / Path(*THE_LIST)).is_file()
    # and it is NEEDED: read like every other file, the list names every name it holds
    named = {what.split()[1] for _, what in breaches_in((SRC / Path(*THE_LIST)).read_text())}
    assert named == set(FORBIDDEN)


def test_the_list_may_name_orders_but_never_call_one(tmp_path: Path) -> None:
    listed = tmp_path / Path(*THE_LIST)
    listed.parent.mkdir(parents=True)
    listed.write_text('WIRE = frozenset({"placeOrder"})\nib.placeOrder(contract, order)\n')
    assert library_breaches(tmp_path) == ["optionality/no_trading.py:2 references .placeOrder"]


def test_the_exemption_does_not_follow_the_name(tmp_path: Path) -> None:
    for rel in ("optionality/research/no_trading.py", "no_trading.py", "optionality/no_trading_too.py"):
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('VERB = "cancelOrder"\n')
    assert [f.split(":")[0] for f in library_breaches(tmp_path)] == [
        "no_trading.py",
        "optionality/no_trading_too.py",
        "optionality/research/no_trading.py",
    ]


def test_the_adr_names_are_refused() -> None:
    """The four Decision 8 names, held even where `ib_async` is not installed to re-derive them."""
    assert {"placeOrder", "cancelOrder", "reqGlobalCancel", "exerciseOptions"} <= ORDER_CALLS
    assert {"Order", "LimitOrder", "MarketOrder"} <= ORDER_CLASSES
    assert not READ_CLASSES & ORDER_CLASSES


# --- the derivation ----------------------------------------------------------------------------


def class_in(path: Path, name: str) -> ast.ClassDef:
    tree = ast.parse(path.read_text())
    return next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == name)


def methods(cls: ast.ClassDef) -> list[ast.FunctionDef | ast.AsyncFunctionDef]:
    return [n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]


def messages_of(fn: ast.AST) -> set[int]:
    """The message ids a `Client` method sends: the first field of `self.send(...)`, or of the list
    it stars into `send` — `placeOrder` builds `fields = [3, ...]` and sends `*fields`."""
    starred = set()
    ids: set[int | None] = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "send":
            first = node.args[0] if node.args else None
            if isinstance(first, ast.Starred) and isinstance(first.value, ast.Name):
                starred.add(first.value.id)
            elif first is not None:
                ids.add(an_int(first))
    for node in ast.walk(fn):
        if (
            isinstance(node, ast.Assign)
            and isinstance(node.value, ast.List)
            and node.value.elts
            and any(isinstance(t, ast.Name) and t.id in starred for t in node.targets)
        ):
            ids.add(an_int(node.value.elts[0]))
    return {i for i in ids if i is not None}


def names_in(node: ast.AST) -> set[str]:
    """Every name an annotation mentions, quoted or not."""
    found = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Name):
            found.add(n.id)
        elif isinstance(n, ast.Constant) and isinstance(n.value, str):
            found |= set(re.findall(r"\w+", n.value))
    return found


def derive(library: Path) -> tuple[frozenset[str], frozenset[str], frozenset[int]]:
    """`(calls, classes, messages)` for the `ib_async` whose package directory is `library`, read
    from its source by AST — never imported, so deriving cannot run its code. The steps are the
    ones `optionality.no_trading`'s docstring numbers."""
    # 1. the wire: which Client method sends which message
    sent = {fn.name: messages_of(fn) for fn in methods(class_in(library / "client.py", "Client"))}
    wire = {name for name, ids in sent.items() if ids & WRITE_MESSAGES.keys()}
    # 4. the classes, default-deny (needed before 3, which looks for them)
    order = ast.parse((library / "order.py").read_text())
    classes = {n.name for n in order.body if isinstance(n, ast.ClassDef) and not n.name.startswith("_")}
    classes -= READ_CLASSES
    # 2 and 3. the IB methods that reach the wire, build an order, or take one
    calls_on_self: dict[str, set[str]] = {}
    acting = set()
    for fn in methods(class_in(library / "ib.py", "IB")):
        own, through_client = set(), set()
        for node in ast.walk(fn):
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "self":
                own.add(node.attr)
            if (
                isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Attribute)
                and node.value.attr == "client"
                and isinstance(node.value.value, ast.Name)
                and node.value.value.id == "self"
            ):
                through_client.add(node.attr)
        calls_on_self[fn.name] = own
        builds = any(
            isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in classes for n in ast.walk(fn)
        )
        arguments = [*fn.args.posonlyargs, *fn.args.args, *fn.args.kwonlyargs]
        takes = any(a.annotation is not None and names_in(a.annotation) & classes for a in arguments)
        if through_client & wire or builds or takes:
            acting.add(fn.name)
    # ...and every method that calls one of those, to a fixed point
    while more := {name for name, own in calls_on_self.items() if own & acting} - acting:
        acting |= more
    return frozenset(wire | acting), frozenset(classes), frozenset(set().union(*sent.values()))


def installed() -> Path:
    """`ib_async`'s package directory, found without importing it."""
    spec = importlib.util.find_spec("ib_async")
    assert spec is not None and spec.submodule_search_locations, (
        "ib_async is not installed, and this package's dev group installs it (the `ibkr` extra): "
        "a derivation the gate skips is a guard nobody runs"
    )
    return Path(next(iter(spec.submodule_search_locations)))


def test_the_names_are_what_ib_async_says() -> None:
    """The written-down list against the library it was derived from."""
    calls, classes, messages = derive(installed())
    assert calls == ORDER_CALLS, (
        f"ib_async now says {sorted(calls)}: refused but no longer derived {sorted(ORDER_CALLS - calls)}, "
        f"derived but not refused {sorted(calls - ORDER_CALLS)}"
    )
    assert classes == ORDER_CLASSES, (
        f"ib_async.order now defines {sorted(classes)} besides the reads — classify {sorted(classes ^ ORDER_CLASSES)}"
    )
    assert messages - KNOWN_MESSAGES == set(), (
        f"ib_async sends messages nobody has classified: {sorted(messages - KNOWN_MESSAGES)} — is one of them an order?"
    )
    assert set(WRITE_MESSAGES) <= messages, "an order message vanished from ib_async: re-derive"


FAKE_CLIENT = """
class Client:
    def send(self, *fields):
        pass

    def reqMktData(self, reqId, contract):
        self.send(1, 11, reqId, contract)

    def placeOrder(self, orderId, contract, order):
        fields = [3, orderId, contract]
        self.send(*fields)

    def cancelOrder(self, orderId):
        self.send(4, 1, orderId)

    def exerciseOptions(self, reqId, contract):
        self.send(21, 2, reqId, contract)

    def reqShiny(self):
        self.send(200, 1)
"""

FAKE_IB = """
from .order import BracketOrder, LimitOrder, Order


class IB:
    def connect(self):
        self.reqMktData(None)

    def reqMktData(self, contract):
        return self.client.reqMktData(1, contract)

    def openOrders(self) -> list[Order]:
        return []

    def placeOrder(self, contract, order):
        self.client.placeOrder(1, contract, order)

    async def whatIfOrderAsync(self, contract, order):
        self.client.placeOrder(2, contract, order)

    def whatIfOrder(self, contract, order):
        return self._run(self.whatIfOrderAsync(contract, order))

    def bracketOrder(self, action):
        return BracketOrder(LimitOrder(action), LimitOrder(action), LimitOrder(action))

    @staticmethod
    def oneCancelsAll(orders: list[Order], group: str):
        return orders
"""

FAKE_ORDER = """
class Order: ...
class LimitOrder(Order): ...
class BracketOrder: ...
class ShinyNewThing: ...
class Trade: ...
class OrderStatus: ...
class OrderState: ...
class OrderStateNumeric(OrderState): ...
"""


def test_the_derivation_reads_a_library(tmp_path: Path) -> None:
    """Each rule of the derivation, against a small library shaped like `ib_async`: an id sent
    through a `fields` list, a caller two `self.` hops from the wire, a builder found by its
    constructor call and one by its argument's annotation, a read that merely RETURNS orders, a
    method that reaches only a read, a class nobody has classified, and a message nobody has."""
    (tmp_path / "client.py").write_text(FAKE_CLIENT)
    (tmp_path / "ib.py").write_text(FAKE_IB)
    (tmp_path / "order.py").write_text(FAKE_ORDER)
    calls, classes, messages = derive(tmp_path)
    assert calls == {
        "placeOrder",
        "cancelOrder",
        "exerciseOptions",
        "whatIfOrderAsync",
        "whatIfOrder",
        "bracketOrder",
        "oneCancelsAll",
    }
    assert classes == {"Order", "LimitOrder", "BracketOrder", "ShinyNewThing"}
    assert messages == {1, 3, 4, 21, 200}
    assert messages - KNOWN_MESSAGES == {200}


# --- the reader, against fixture sources -------------------------------------------------------

REFUSED = {
    "a placement": "ib.placeOrder(contract, order)\n",
    "a modification, which is a placement": "order.lmtPrice = 1.0\nib.placeOrder(contract, order)\n",
    "a cancellation": "ib.cancelOrder(order)\n",
    "a global cancel": "ib.reqGlobalCancel()\n",
    "an exercise": "ib.exerciseOptions(contract, 1, 1, 'U1', 0)\n",
    "a what-if, which is message 3": "state = ib.whatIfOrder(contract, order)\n",
    "an async variant": "async def f(ib):\n    await ib.whatIfOrderAsync(contract, order)\n",
    "a bracket": "parent, profit, stop = ib.bracketOrder('BUY', 1, 10.0, 11.0, 9.0)\n",
    "an OCA group": "ib.oneCancelsAll(orders, 'g', 1)\n",
    "the method held, not called": "place = ib.placeOrder\n",
    "through the class": "from ib_async import IB\nIB.placeOrder(ib, contract, order)\n",
    "through the wire client": "ib.client.cancelOrder(7)\n",
    "through the Client this package connects": "client.placeOrder(1, contract, order)\n",
    "an order class imported": "from ib_async import LimitOrder\n",
    "an order class aliased": "from ib_async.order import MarketOrder as M\n",
    "an order class under an innocent alias": "from ib_async import Order as Thing\n",
    "an order class through the module": "import ib_async\no = ib_async.Order()\n",
    "an order condition": "from ib_async import PriceCondition\n",
    "a combo leg price": "from ib_async.order import OrderComboLeg\n",
    "an order class as a base": "from ib_async import order\nclass Mine(order.Order): ...\n",
    "an order class in an annotation": "def send(o: 'Order'): ...\n",
    "a lazy import": "def later():\n    from ib_async import StopOrder\n",
    "a star import": "from ib_async import *\n",
    "a star import from the order module": "from ib_async.order import *\n",
    "getattr with the name": "getattr(ib, 'placeOrder')(contract, order)\n",
    "getattr with a sum": "getattr(ib, 'place' + 'Order')(contract, order)\n",
    "getattr with an f-string": "getattr(ib, f\"cancel{'Order'}\")(order)\n",
    "getattr with a join": "getattr(ib, ''.join(['exercise', 'Options']))\n",
    "the name kept in a constant": "VERB = 'reqGlobalCancel'\n",
    "a dotted path to a class": "import pydoc\ncls = pydoc.locate('ib_async.order.LimitOrder')\n",
    "methodcaller": "import operator\noperator.methodcaller('cancelOrder', order)(ib)\n",
    "the class dict": "IB.__dict__['bracketOrder']\n",
    "exec": "exec('ib.placeOrder(contract, order)')\n",
    "eval": "eval('ib.reqGlobalCancel()')\n",
    "a definition by the name": "def placeOrder(ib, contract, order): ...\n",
    "a keyword by the name": "handlers = dict(placeOrder=print)\n",
    "PLACE_ORDER on the wire": "client.send(3, 1, contract)\n",
    "REQ_GLOBAL_CANCEL on the wire, starred": "ib.client.send(*[58, 1])\n",
}


@pytest.mark.parametrize("source", REFUSED.values(), ids=REFUSED.keys())
def test_an_order_is_refused(source: str) -> None:
    assert breaches_in(source) != [], f"the lint did not see: {source!r}"


ALLOWED = {
    "connecting the Client": "from ib_async.client import Client\nclient = Client(reader)\n",
    "a quote": "client.reqMarketDataType(4)\nclient.reqMktData(7, contract, '', True, False, [])\n",
    "a contract": "from ib_async.contract import Contract\nclient.reqContractDetails(7, Contract(symbol='SPX'))\n",
    "cancelling DATA": "client.cancelMktData(7)\n",
    "reading orders that exist": "ib.openOrders()\nib.trades()\nib.reqCompletedOrders(False)\nib.reqOpenOrders()\n",
    "reading a trade's order": "from ib_async import Trade\nprice = trade.order.lmtPrice\n",
    "a read message on the wire": "ib.client.send(1, 11, 7, contract)\n",
    "the docstring may say it": '"""Never calls placeOrder or builds a LimitOrder."""\n',
    "prose that contains a word": "log.info('Order of work: placing nothing')\n",
    "a comment may say it": "x = 1  # ib.placeOrder is refused here\n",
    "a name that merely contains one": "replaceOrders = 1\nmy_cancelOrder_count = 2\n",
}


@pytest.mark.parametrize("source", ALLOWED.values(), ids=ALLOWED.keys())
def test_reading_the_market_is_allowed(source: str) -> None:
    """The other direction: the client connects, prices, resolves contracts, and a rule that
    refused any of it would be deleted the day it was met."""
    assert breaches_in(source) == []


def test_a_finding_names_its_line_and_what_it_reached() -> None:
    assert breaches_in('"""The IB client."""\n\nib.placeOrder(contract, order)\n') == [(3, "references .placeOrder")]


def test_the_strings_are_read_without_docstrings() -> None:
    """The half of the reader this lint and the backend's boundary lint share."""
    tree = ast.parse('"""placeOrder"""\nX = "place" + "Order"\n')
    assert [s for _, strings in every_string(tree) for s in strings] == [(2, "placeOrder")]
    assert len(docstrings(tree)) == 1
    assert folded(ast.parse("'a' + 'b'", mode="eval").body) == "ab"


def test_every_file_under_src_is_read(tmp_path: Path) -> None:
    for rel, source in (("optionality/a/b/deep.py", "ib.cancelOrder(o)\n"), ("stray.py", "ib.reqGlobalCancel()\n")):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(source)
    assert [f.split(":")[0] for f in library_breaches(tmp_path)] == ["optionality/a/b/deep.py", "stray.py"]
