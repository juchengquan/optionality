"""`start` for the MCP door's suite: the HTTP suites' fixture, because the door is driven through the app
as `__main__` mounts it, on the same harness."""

from entrypoints.http.conftest import start

__all__ = ["start"]
