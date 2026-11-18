"""The MCP door's one door (ADR 0026): the handler `__main__` mounts at `/mcp` through `create_app`, and
the options it is built with. Port of backend/src/entrypoints/mcp/index.ts.

Behind it: `server.py` (the protocol — MCP's Streamable HTTP, stateless, one JSON-RPC message per POST)
and `tools.py` (the tools, each a GET of the API's own, and the shared cache in front of the live ones).
The table they serve is shared ground, `schema/mcp/server.json`.

A surface of its own rather than routes inside `http/`, because it is a different way in for a
different client — an agent, not the dashboard — with its own protocol, as the bot is (ADR 0020). But it
serves nothing the HTTP door does not: it is handed a GET of the API's own and nothing else, so it can
neither compute a figure the routes do not nor reach a write. It is mounted on the HTTP server because
that is where the tailnet already reaches (`/opt/api/mcp`, behind the same proxy and the same token),
and `__main__` does the mounting: this door imports nothing from `http/`, and `http/` nothing from it.
"""

from .server import McpOptions, mcp_server

__all__ = ["McpOptions", "mcp_server"]
