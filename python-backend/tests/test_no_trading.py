"""The backend places, modifies, cancels and exercises no order (ADR 0021, Decision 8).

The TypeScript cannot trade because its IB Gateway client has no order message to send (ADR 0019).
The Python cannot say that: it reaches the gateway through `ib_async`, which was chosen BECAUSE it
can trade (Decision 7), so `ib.placeOrder` is one attribute away from every line that holds an `IB`.
Until a trading ADR designs it, three locks stand in for the missing message: the gateway's
Read-Only API switch, `ib_async`'s `readonly=True` (one flag, so not counted), and this lint.

**What it refuses**, anywhere under `python-backend/src/` except inside `optionality_backend/trading/`:
every name in `ORDER_CALLS` and `ORDER_CLASSES` — as an attribute (`ib.placeOrder`, called or not),
a bare name, an import or its alias, a definition, an argument or keyword name, and a string that IS
the name or ends a dotted path to it (`getattr(ib, "placeOrder")`, folded where literals are added or
joined); a star import from an IB client, which brings the order classes in unnamed; code handed to
`exec`/`eval`/`compile` that names one; and an order message sent straight down the wire,
`ib.client.send(3, ...)`, which skips every method name there is.

**How the names were derived** — from `ib_async` 2.1.0 itself, read by `derive()` below from its
source rather than typed from its documentation, and compared against the installed library by
`test_the_names_are_what_ib_async_says`:

1. The WIRE. Every method of `ib_async.client.Client` sends exactly one message, and its id is the
   first field. Four of IBKR's outgoing messages act on an order: `PLACE_ORDER` (3), which also
   MODIFIES one — a modification is a placement under an id already in use — `CANCEL_ORDER` (4),
   `EXERCISE_OPTIONS` (21) and `REQ_GLOBAL_CANCEL` (58). The ids are IBKR's protocol table; the
   method names that send them are read out of `client.py`: `placeOrder`, `cancelOrder`,
   `exerciseOptions`, `reqGlobalCancel`. Every other id `ib_async` sends must be in
   `KNOWN_MESSAGES`, so a new message in an upgrade fails here until a person has classified it.
2. The CALLERS. Every method of `ib_async.ib.IB` that calls one of those through `self.client`,
   and then every method that calls one of THOSE through `self`, to a fixed point: adds
   `whatIfOrderAsync` (a placement flagged what-if, still message 3) and `whatIfOrder`.
3. The BUILDERS. Every `IB` method that constructs an order class or takes one as an argument:
   adds `bracketOrder` and `oneCancelsAll`, which send nothing but exist only to feed `placeOrder`.
4. The CLASSES, default-deny: every class `ib_async/order.py` defines, except the four that describe
   what already happened — `Trade`, `OrderStatus`, `OrderState`, `OrderStateNumeric`. A new class
   there is refused until it is shown to be a read.

**Considered and left out**, because they act on no order: `reqAutoOpenOrders` (15) binds orders
placed in TWS to client 0 and is called by `ib_async`'s own `connect` when the client id is 0 —
deriving through it put `connect` on the list, which would forbid the service its only job —
`replaceFA` (19), which rewrites the advisor allocation, and every read of orders that exist:
`openOrders`, `trades`, `reqCompletedOrders`, `reqExecutions`. Reading the account is not trading.

**The door is fixed**, as `tools/check-seams.mjs` fixes its `never`: `DOOR` is asserted to be exactly
`optionality_backend/trading`, and that directory is asserted NOT TO EXIST. Creating it is the
deliberate act — an ADR, and an edit to this file that a reviewer sees — and nothing inside
`src/` can widen the exemption, because nothing inside `src/` is read to decide it.

It is a lint and not a sandbox: `getattr(ib, base64.b64decode(...))` defeats it, and so does a
message list built in one statement and sent in another. It exists so trading cannot happen BY
ACCIDENT, which is the ADR's word; the gateway's Read-Only switch is the lock that holds against
intent. Checked against a FIXTURE TREE rather than this repository, for `check-seams`' reason: a
guard tested only against a clean tree passes while holding nothing.
"""

import ast
import importlib.util
import re
import tomllib
from pathlib import Path

import pytest
from reading import docstrings, every_string, folded, python_files

BACKEND = Path(__file__).resolve().parents[1]
PACKAGE = "optionality_backend"
#: the one place an order may be named, relative to `src/`. It does not exist; see the docstring
DOOR = ("optionality_backend", "trading")

# What places, modifies, cancels or exercises an order, or builds one to be placed: `derive()`'s
# answer for ib_async 2.1.0, written down so the lint needs no ib_async to run. One set per step of
# the derivation, numbered as the docstring numbers them.
#: 1. the Client methods that send an order message
WIRE = frozenset({"placeOrder", "cancelOrder", "reqGlobalCancel", "exerciseOptions"})
#: 2. the IB methods that reach one of those
CALLERS = frozenset({"whatIfOrder", "whatIfOrderAsync"})
#: 3. the IB methods that build an order or take one
BUILDERS = frozenset({"bracketOrder", "oneCancelsAll"})
ORDER_CALLS = WIRE | CALLERS | BUILDERS
#: 4. every class `ib_async.order` defines but the four reads: the orders, and their parts
ORDERS = frozenset({"Order", "LimitOrder", "MarketOrder", "StopOrder", "StopLimitOrder", "BracketOrder"})
PARTS = frozenset({"OrderComboLeg", "OrderCondition", "PriceCondition", "TimeCondition", "MarginCondition"})
MORE_PARTS = frozenset({"ExecutionCondition", "VolumeCondition", "PercentChangeCondition"})
ORDER_CLASSES = ORDERS | PARTS | MORE_PARTS
FORBIDDEN = ORDER_CALLS | ORDER_CLASSES

#: IBKR's outgoing messages that act on an order, by id (the protocol's own names)
WRITE_MESSAGES = {3: "PLACE_ORDER", 4: "CANCEL_ORDER", 21: "EXERCISE_OPTIONS", 58: "REQ_GLOBAL_CANCEL"}
#: every message ib_async 2.1.0 sends, measured: the four above, and requests for or cancellations
#: of DATA — market data, history, news, scanners, account and order reads — plus the handshake.
#: An id outside this set is a message nobody has classified
KNOWN_MESSAGES = frozenset(range(1, 26)) | frozenset(range(49, 60)) | frozenset(range(61, 105))
#: the classes in `ib_async/order.py` that describe what already happened rather than what to send
READ_CLASSES = frozenset({"Trade", "OrderStatus", "OrderState", "OrderStateNumeric"})
#: the clients a star import would bring the order classes in from
CLIENTS = {"ib_async", "ib_insync", "ibapi"}
#: what puts raw fields on the wire
SENDS = {"send", "sendMsg"}
#: what runs a string as code
EVALUATORS = {"exec", "eval", "compile"}


_NAMES = "|".join(sorted(FORBIDDEN, key=len, reverse=True))
#: a string that IS a forbidden name, or ends a dotted path to one: `"placeOrder"`,
#: `"ib_async.order.LimitOrder"`. Whole strings only, so prose may still say "Order of work"
NAMED = re.compile(rf"(?:\w+\.)*({_NAMES})")
#: a forbidden name as a token inside code handed to `exec`
TOKEN = re.compile(rf"(?<!\w)({_NAMES})(?!\w)")


# --- the derivation ----------------------------------------------------------------------------


def class_in(path: Path, name: str) -> ast.ClassDef:
    tree = ast.parse(path.read_text())
    return next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == name)


def methods(cls: ast.ClassDef) -> list[ast.FunctionDef | ast.AsyncFunctionDef]:
    return [n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]


def an_int(node: ast.AST) -> int | None:
    # `type(...) is int` and not isinstance: a bool is an int too, and `send(True)` sends no message
    return node.value if isinstance(node, ast.Constant) and type(node.value) is int else None


def messages_of(fn: ast.AST) -> set[int]:
    """The message ids a `Client` method sends: the first field of `self.send(...)`, or of the list
    it stars into `send` — `placeOrder` builds `fields = [3, ...]` and sends `*fields`."""
    starred = set()
    ids = set()
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
    return ids - {None}


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
    from its source by AST — never imported, so deriving cannot run its code. The module docstring
    says what each step means; this is the steps."""
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


# --- the lint ----------------------------------------------------------------------------------


def through_the_door(rel: Path) -> bool:
    """Whether `rel` (relative to the backend) is a file INSIDE `src/optionality_backend/trading/`.
    Exactly that directory: not a `trading.py`, not a `trading/` anywhere else."""
    under_src = rel.parts[1:]
    return len(under_src) > len(DOOR) and under_src[: len(DOOR)] == DOOR


def message_sent(call: ast.Call) -> int | None:
    """The order message a raw `send(...)` puts on the wire, if it is one."""
    func = call.func
    name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else None
    if name not in SENDS or not call.args:
        return None
    first = call.args[0]
    if isinstance(first, ast.Starred) and isinstance(first.value, (ast.List, ast.Tuple)) and first.value.elts:
        first = first.value.elts[0]
    message = an_int(first)
    return message if message in WRITE_MESSAGES else None


def file_breaches(tree: ast.AST) -> set[tuple[int, str]]:
    found: set[tuple[int, str]] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr in FORBIDDEN:
            found.add((node.lineno, f"references .{node.attr}"))
        elif isinstance(node, ast.Name) and node.id in FORBIDDEN:
            found.add((node.lineno, f"references {node.id}"))
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                if alias.name.split(".")[-1] in FORBIDDEN or alias.asname in FORBIDDEN:
                    found.add((node.lineno, f"imports {alias.name}"))
                star = alias.name == "*" and isinstance(node, ast.ImportFrom) and node.module
                if star and node.module.split(".")[0] in CLIENTS:
                    found.add((node.lineno, f"star-imports {node.module}, which brings the order classes in unnamed"))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name in FORBIDDEN:
            found.add((node.lineno, f"defines {node.name}"))
        elif isinstance(node, (ast.arg, ast.keyword)) and node.arg in FORBIDDEN:
            found.add((node.lineno, f"names {node.arg} as an argument"))
        elif isinstance(node, ast.Call):
            message = message_sent(node)
            if message is not None:
                found.add((node.lineno, f"sends {WRITE_MESSAGES[message]} ({message}) down the wire"))
            if isinstance(node.func, ast.Name) and node.func.id in EVALUATORS:
                for arg in node.args:
                    code = folded(arg)
                    if code is not None and (match := TOKEN.search(code)):
                        found.add((node.lineno, f"evaluates code that names {match.group(1)}"))
    for _, strings in every_string(tree):
        for line, value in strings:
            if match := NAMED.fullmatch(value.strip()):
                found.add((line, f"names {match.group(1)} in a string"))
    return found


def breaches(root: Path) -> list[str]:
    """Every order reference in `root/src` outside the door, as `file:line what`."""
    lines = []
    for path, rel in python_files(root):
        if through_the_door(rel):
            continue
        lines += [f"{rel}:{line} {what}" for line, what in sorted(file_breaches(ast.parse(path.read_text())))]
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


def test_the_adr_names_are_refused() -> None:
    """The four Decision 8 names, held even where `ib_async` is not installed to re-derive them."""
    assert {"placeOrder", "cancelOrder", "reqGlobalCancel", "exerciseOptions"} <= ORDER_CALLS
    assert {"Order", "LimitOrder", "MarketOrder"} <= ORDER_CLASSES
    assert not READ_CLASSES & ORDER_CLASSES


# --- the derivation, against the real library --------------------------------------------------


def installed() -> Path | None:
    """`ib_async`'s package directory, found without importing it."""
    spec = importlib.util.find_spec("ib_async")
    if spec is None or not spec.submodule_search_locations:
        return None
    return Path(next(iter(spec.submodule_search_locations)))


def depends_on_ib_async() -> bool:
    """Whether the backend has declared `ib_async`, directly or through the library's extras."""
    for requirement in tomllib.loads((BACKEND / "pyproject.toml").read_text())["project"]["dependencies"]:
        spec = requirement.lower().replace("_", "-")
        if "ib-async" in spec or re.search(r"optionality\s*\[[^\]]*\b(ibkr|all)\b", spec):
            return True
    return False


def test_the_names_are_what_ib_async_says() -> None:
    """The written-down list against the library it was derived from.

    `ib_async` is not a dependency of the backend yet — it arrives with the client, in phase 4 — so
    this SKIPS where it is not installed. It cannot skip for ever: the moment the backend declares
    it, absence is a failure, so an upgrade of `ib_async` is always re-derived."""
    library = installed()
    if library is None:
        assert not depends_on_ib_async(), "the backend depends on ib_async and it is not installed"
        pytest.skip("ib_async is not installed and not yet a backend dependency (ADR 0021, phase 4)")
    calls, classes, messages = derive(library)
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


# --- the derivation, against a fixture library ------------------------------------------------

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


# --- the lint, against a fixture tree ----------------------------------------------------------


def write(root: Path, rel: str, source: str) -> Path:
    path = root / "src" / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source)
    return path


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
    "PLACE_ORDER on the wire": "ib.client.send(3, 1, contract)\n",
    "REQ_GLOBAL_CANCEL on the wire, starred": "ib.client.send(*[58, 1])\n",
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


ALLOWED = {
    "connecting read-only": "from ib_async import IB\nib = IB()\nib.connect('127.0.0.1', 4001, clientId=7, readonly=True)\n",
    "a quote": "ib.reqMarketDataType(3)\nticker = ib.reqMktData(contract, '', False, False)\n",
    "a contract": "from ib_async import Index, Option\nib.qualifyContracts(Option('SPX', '20261218', 8100, 'C', 'SMART'))\n",
    "cancelling DATA": "ib.cancelMktData(contract)\n",
    "reading orders that exist": "ib.openOrders()\nib.trades()\nib.reqCompletedOrders(False)\nib.reqOpenOrders()\n",
    "reading a trade's order": "from ib_async import Trade\nprice = trade.order.lmtPrice\n",
    "a read message on the wire": "ib.client.send(1, 11, 7, contract)\n",
    "the docstring may say it": '"""Never calls placeOrder or builds a LimitOrder."""\n',
    "prose that contains a word": "log.info('Order of work: placing nothing')\n",
    "a comment may say it": "x = 1  # ib.placeOrder is refused here\n",
    "a name that merely contains one": "replaceOrders = 1\nmy_cancelOrder_count = 2\n",
}


@pytest.mark.parametrize("source", ALLOWED.values(), ids=ALLOWED.keys())
def test_reading_the_account_is_allowed(tmp_path: Path, source: str) -> None:
    """The other direction: the service connects, prices, qualifies contracts and reads what the
    account holds, and a rule that refused any of it would be deleted the day the client lands."""
    write(tmp_path, f"{PACKAGE}/vendors/ibkr.py", source)
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


def test_the_strings_are_read_without_docstrings(tmp_path: Path) -> None:
    """`reading` is shared with the boundary lint; this is the half of it this lint relies on."""
    tree = ast.parse('"""placeOrder"""\nX = "place" + "Order"\n')
    assert [s for _, strings in every_string(tree) for s in strings] == [(2, "placeOrder")]
    assert len(docstrings(tree)) == 1
    assert folded(ast.parse("'a' + 'b'", mode="eval").body) == "ab"
    assert python_files(tmp_path) == []
