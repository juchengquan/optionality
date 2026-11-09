"""What in `ib_async` trades, named once, and the reader that finds it in Python source (ADR 0021, Decision 8).

The TypeScript cannot trade because its IB Gateway client has no order message to send (ADR 0019).
The Python cannot say that: `optionality.ibkr` reaches the gateway through `ib_async`, which was
chosen BECAUSE it can trade (Decision 7), so an order is one attribute away from every line that
holds its `Client`. Until a trading ADR designs it, a lint stands in for the missing message, and
this module is that lint's whole content: the names, and `breaches_in`, which reads one file.

**Who uses it.** Two packages hold the same rule, and both read it from here:

* this library — `tests/test_no_trading.py` refuses every name below anywhere under `python/src`,
  because the IB Gateway client is the library's, and so is the `ibkr` extra that installs
  `ib_async` into a notebook's environment.
* the backend — `python-backend/tests/test_no_trading.py` refuses them outside an
  `optionality_backend/trading/` that does not exist until a trading ADR creates it.

One list, so the two cannot drift; in the library, because the library is the one that brings
`ib_async` in, and because the backend may import the library's public modules while the library
may import nothing of the backend's. The library's suite also holds the list to the installed
`ib_async` (`test_the_names_are_what_ib_async_says`), so an upgrade is re-derived where it lands.

**What it refuses**: every name in `ORDER_CALLS` and `ORDER_CLASSES` — as an attribute
(`ib.placeOrder`, called or not), a bare name, an import or its alias, a definition, an argument or
keyword name, and a string that IS the name or ends a dotted path to it (`getattr(ib,
"placeOrder")`, folded where literals are added or joined); a star import from an IB client, which
brings the order classes in unnamed; code handed to `exec`/`eval`/`compile` that names one; and an
order message sent straight down the wire, `client.send(3, ...)`, which skips every method name
there is. Docstrings and comments may say anything: describing the rule is not breaking it.

**How the names were derived** — from `ib_async` 2.1.0 itself, by `derive()` in the library's
`tests/test_no_trading.py`, which reads its source rather than its documentation:

1. The WIRE. Every method of `ib_async.client.Client` sends exactly one message, and its id is the
   first field. Four of IBKR's outgoing messages act on an order: `PLACE_ORDER` (3), which also
   MODIFIES one — a modification is a placement under an id already in use — `CANCEL_ORDER` (4),
   `EXERCISE_OPTIONS` (21) and `REQ_GLOBAL_CANCEL` (58). The methods that send them are read out of
   `client.py`. Every other id `ib_async` sends must be in `KNOWN_MESSAGES`, so a new message in an
   upgrade fails until a person has classified it.
2. The CALLERS. Every method of `ib_async.ib.IB` that calls one of those through `self.client`, and
   every method that calls one of THOSE through `self`, to a fixed point: `whatIfOrderAsync` (a
   placement flagged what-if, still message 3) and `whatIfOrder`.
3. The BUILDERS. Every `IB` method that constructs an order class or takes one as an argument:
   `bracketOrder` and `oneCancelsAll`, which send nothing but exist only to feed a placement.
4. The CLASSES, default-deny: every class `ib_async/order.py` defines, except the four that describe
   what already happened — `Trade`, `OrderStatus`, `OrderState`, `OrderStateNumeric`.

**Considered and left out**, because they act on no order: `reqAutoOpenOrders` (15), which
`ib_async`'s own `IB.connect` calls when the client id is 0 — deriving through it put `connect` on
the list — `replaceFA` (19), and every read of orders that exist. Reading the account is not trading.

It is a lint and not a sandbox: `getattr(ib, base64.b64decode(...))` defeats it, and so does a
message list built in one statement and sent in another. It exists so trading cannot happen BY
ACCIDENT, which is the ADR's word; IB Gateway's Read-Only API switch is the lock that holds against
intent. `ib_async`'s `readonly=True` is not one: it skips two order fetches at connect and refuses
nothing.
"""

import ast
import re

# What places, modifies, cancels or exercises an order, or builds one to be placed: the derivation's
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
CLIENTS = frozenset({"ib_async", "ib_insync", "ibapi"})
#: what puts raw fields on the wire
SENDS = frozenset({"send", "sendMsg"})
#: what runs a string as code
EVALUATORS = frozenset({"exec", "eval", "compile"})

_NAMES = "|".join(sorted(FORBIDDEN, key=len, reverse=True))
#: a string that IS a forbidden name, or ends a dotted path to one: `"placeOrder"`,
#: `"ib_async.order.LimitOrder"`. Whole strings only, so prose may still say "Order of work"
NAMED = re.compile(rf"(?:\w+\.)*({_NAMES})")
#: a forbidden name as a token inside code handed to `exec`
TOKEN = re.compile(rf"(?<!\w)({_NAMES})(?!\w)")


# --- the strings in a file: shared with the backend's boundary lint ----------------------------

#: the fields of a compound statement that hold OTHER statements, which `ast.walk` visits on their
#: own: reading them here as well would count a string twice
NESTED = frozenset({"body", "orelse", "finalbody", "handlers", "cases"})


def folded(node: ast.AST) -> str | None:
    """The string `node` always evaluates to, where that can be read off the page: a literal, two
    of them added, an f-string of literals, or a literal separator joining literals. Anything else
    is a name built at runtime, which no lint can read."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = folded(node.left), folded(node.right)
        return None if left is None or right is None else left + right
    if isinstance(node, ast.JoinedStr):
        pieces = [folded(v.value if isinstance(v, ast.FormattedValue) else v) for v in node.values]
        return None if None in pieces else "".join(p for p in pieces if p is not None)
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "join"
        and len(node.args) == 1
        and isinstance(node.args[0], (ast.List, ast.Tuple))
    ):
        sep = folded(node.func.value)
        parts = [folded(e) for e in node.args[0].elts]
        return None if sep is None or None in parts else sep.join(p for p in parts if p is not None)
    return None


def docstrings(tree: ast.AST) -> set[int]:
    """The docstring nodes, which may say anything: describing a rule is not breaking it."""
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
                found.add(id(first.value))
    return found


def strings_in(node: ast.AST, skip: set[int]) -> list[tuple[int, str]]:
    """Every maximal string in `node`, folded, with its line. Maximal so `"optionality." +
    "_ported"` is read as the one name it makes and not as two harmless halves."""
    if id(node) in skip:
        return []
    value = folded(node)
    if value is not None:
        return [(getattr(node, "lineno", 0), value)]
    return [s for child in ast.iter_child_nodes(node) for s in strings_in(child, skip)]


def statement_strings(stmt: ast.stmt, skip: set[int]) -> list[tuple[int, str]]:
    """The strings of ONE statement, in order, so adjacent path segments can be read together."""
    found = []
    for field, value in ast.iter_fields(stmt):
        if field in NESTED:
            continue
        for child in value if isinstance(value, list) else [value]:
            if isinstance(child, ast.AST):
                found += strings_in(child, skip)
    return found


def every_string(tree: ast.AST) -> list[tuple[int, list[tuple[int, str]]]]:
    """Each statement's line and its strings, docstrings left out."""
    skip = docstrings(tree)
    return [(stmt.lineno, statement_strings(stmt, skip)) for stmt in ast.walk(tree) if isinstance(stmt, ast.stmt)]


# --- the lint ----------------------------------------------------------------------------------


def an_int(node: ast.AST) -> int | None:
    """A literal int — `type(...) is int` and not isinstance: a bool is an int too, and
    `send(True)` sends no message."""
    return node.value if isinstance(node, ast.Constant) and type(node.value) is int else None


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


def breaches_in(source: str, *, strings: bool = True) -> list[tuple[int, str]]:
    """Every order this source names, as `(line, what)`, sorted.

    `strings=False` reads everything but the string literals, for exactly one file: this one, whose
    tables ARE the names. The library's lint fixes that exemption to this file and nothing else.
    """
    tree = ast.parse(source)
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
                if star and node.module.split(".")[0] in CLIENTS:  # type: ignore[union-attr]
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
    if strings:
        for _, pieces in every_string(tree):
            for line, value in pieces:
                if match := NAMED.fullmatch(value.strip()):
                    found.add((line, f"names {match.group(1)} in a string"))
    return sorted(found)
