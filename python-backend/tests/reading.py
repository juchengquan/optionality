"""How the backend's two lines read a file: its AST, and the strings in it.

Shared by `test_library_boundary.py` and `test_no_trading.py`, which both have to see a name that
is written as a STRING — `importlib.import_module("optionality._ported")`,
`getattr(ib, "placeOrder")` — because a lint that reads only import statements and attribute
access is walked round by the first person who wants to.

Not a test module, so pytest collects nothing here.
"""

import ast
from pathlib import Path

#: the fields of a compound statement that hold OTHER statements, which `ast.walk` visits on their
#: own: reading them here as well would count a string twice
NESTED = {"body", "orelse", "finalbody", "handlers", "cases"}


def python_files(root: Path) -> list[tuple[Path, Path]]:
    """Every `.py` file under `root/src`, with its path relative to `root`. `root` is shaped like
    `python-backend/`, so a fixture tree and the real one are read the same way."""
    return [(path, path.relative_to(root)) for path in sorted((root / "src").rglob("*.py"))]


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
        return None if None in pieces else "".join(pieces)
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "join"
        and len(node.args) == 1
        and isinstance(node.args[0], (ast.List, ast.Tuple))
    ):
        sep = folded(node.func.value)
        pieces = [folded(e) for e in node.args[0].elts]
        return None if sep is None or None in pieces else sep.join(pieces)
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
        return [(node.lineno, value)]
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
