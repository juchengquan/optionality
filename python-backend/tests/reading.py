"""How the backend's two lines read a file: its AST, and the strings in it.

Shared by `test_library_boundary.py` and `test_no_trading.py`, which both have to see a name that
is written as a STRING — `importlib.import_module("optionality._ported")`,
`getattr(ib, "placeOrder")` — because a lint that reads only import statements and attribute
access is walked round by the first person who wants to.

The string reader itself is the library's, `optionality.no_trading`, imported by name like any
public module: the library holds itself to the no-trading rule too, with the same reader, and one
reader cannot fold `"place" + "Order"` differently in the two packages. What stays here is the one
thing that is the backend's own — where its files are.

Not a test module, so pytest collects nothing here.
"""

from pathlib import Path

from optionality.no_trading import every_string

__all__ = ["every_string", "python_files"]


def python_files(root: Path) -> list[tuple[Path, Path]]:
    """Every `.py` file under `root/src`, with its path relative to `root`. `root` is shaped like
    `python-backend/`, so a fixture tree and the real one are read the same way."""
    return [(path, path.relative_to(root)) for path in sorted((root / "src").rglob("*.py"))]
