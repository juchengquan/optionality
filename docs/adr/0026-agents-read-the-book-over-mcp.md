# 26. Agents read the book over MCP

Date: 2026-11-18

## Status

Accepted and built (#447). Decided by the owner on 2026-11-18. Both backends carry it, in lockstep
(ADR 0021).

## Context

Agents — Claude Code and any other MCP client — should be able to read optionality's data, not only
the dashboard and the bot: the book, the rules, their histories, the References and the service's
health. The owner's decisions on #447, final:

1. **Inside the service**: a `/mcp` entrypoint speaking MCP's Streamable HTTP, usable by any MCP client.
2. **Both backends** (ADR 0021): the Python serves the same `/mcp`, and the door scenarios hold the
   answers identical.
3. **Tailnet only**: behind the same Tailscale hostname as the dashboard; nothing public.
4. **Read-only**: no tool adds, edits, mutes, deletes, records or closes anything.
5. **Only the calls the service already makes**: no tool prices an arbitrary contract.
6. **About six tools, mirroring what the page reads**, JSON as the API serves it, each described.
7. **A short shared cache** (~5s, across all agents) for the live reads, each answer saying when it was
   read — so an agent in a loop can never exhaust moomoo's snapshot limit (60 per 30s, shared with the
   sweep) and degrade the alarms.
8. **Money and contract counts as the API serves them** — no filtering.

## Decision

**A third surface, `entrypoints/mcp/`, mounted on the HTTP server at `/mcp`.** A door of its own
(`mcp/index.ts`, `mcp/__init__.py`; `check-seams` and `test_seams.py` declare it), because it is a
different way in for a different client with its own protocol, as the bot is (ADR 0020). `main.ts`
(`__main__.py`) does the wiring: `createApp(deps, { mcp })` is handed the door's handler factory, and
hands it back a **`Read`** — a GET of the app's own, the caller's Authorization header passed on. Neither
surface imports the other.

**Every tool is a GET the API already serves, and nothing else.** A tool's answer is
`{"source": "GET <path>", "read_at": <when it was read, DISPLAY_TZ>, "data": <that GET's body>}`. The
door is handed `Read` and nothing more — no service, no query, no engine — so it cannot compute a figure
the routes do not, cannot disagree with the dashboard, and cannot write: the method is not a parameter of
`Read`. A test in each language holds the door's imports to that (`server.test.ts`, `test_server.py`),
and another holds every tool's path to a GET `/openapi.json` documents.

| tool | GET | live |
|---|---|---|
| `holdings` | `/positions/values` | yes |
| `watchlist` | `/quotes` | yes |
| `positions` (closed trades: those with `closed_on`) | `/positions` | |
| `holding_history` `{id}` | `/positions/{id}/samples` | |
| `monitor_history` `{id}` | `/monitors/{id}/samples` | |
| `monitor_closes` | `/monitors/closes` | |
| `references` | `/references` | yes |
| `health` | `/health` | |

Closed trades are `positions` rather than a filtered list, so the tool's data stays exactly the GET's;
its description says a closed trade is one with `closed_on`.

**The table is shared ground**: `schema/mcp/server.json` — the server's name, its instructions, the
protocol versions it speaks, and each tool's name, title, description, path, input schema and whether it
is live — read by both backends, as `schema/api/` is. The descriptions an agent reads are written once.

**The shared cache** is in the MCP layer (`tools.ts`, `tools.py`): a live tool's read is shared by every
caller for `LIVE_FOR_MS` (5000) after it was made, keyed by the path alone — the live tools take no
arguments, so no argument can bust it — and a read still in flight is joined. A refusal (the Provider
down, a 502) is shared too, so a dead Provider is asked once per window; a read that THROWS is not. The
answer's `read_at` is when the shared read was made. The dashboard's polls and the sweep never pass
through it. Measured by a counting Provider in both suites: fifty calls in a loop, and twenty at once,
make one Provider call; the next window makes the second.

**The protocol is written by hand**, in both languages, rather than with the official SDKs
(`@modelcontextprotocol/sdk`, `mcp`). The door scenarios compare the two backends' answers exactly, and
two SDKs word their own refusals, validate in their own order and carry their own defaults — every
difference a scenario failing for a reason neither backend chose. The subset a stateless read-only server
needs is small: `initialize` (the client's version where it is one of `protocol_versions`, else the
newest), `ping`, `tools/list`, `tools/call`; notifications and client responses are accepted with 202.
**The versions spoken are `2025-11-25` (the newest) and `2025-06-18`** — the two whose Streamable HTTP
rules this server follows. `2025-03-26` allowed batches, which it refuses, and `2024-11-05` is the old
HTTP+SSE transport, so a client asking for either is answered with the newest and decides. A request
carrying an `MCP-Protocol-Version` header that is not one of them is a 400 with a JSON-RPC error and no
id, as the 2025-11-25 transport says. A later revision's new methods — 2026-07-28's `server/discover`
— get `-32601`, which current SDKs fall back from. An integral id is echoed as an integer in both
backends (`1.0` as `1`), because `JSON.parse` cannot tell the two apart.
**Stateless**: no session id, no event stream (`GET /mcp` is the transport's 405). A batch, a body that
is not JSON or not JSON-RPC is a 400 with the JSON-RPC error; an unknown method or tool is a JSON-RPC
error; arguments that are not the tool's, an unknown id and a failed read are a TOOL error (`isError`)
in words an agent can correct from — the service's own `detail` for a refused GET. An id must match
`^[A-Za-z0-9_-]{1,64}$` before any path is built from it. A request with an `Origin` is refused 403:
only a browser sends one, and the transport asks a server to refuse it against DNS rebinding.

**The text is canonical**: an answer is written with every object's keys sorted, no whitespace, and
numbers as JavaScript writes them (`js_string` in the Python), because the scenarios compare the TEXT,
and the two backends build their bodies in their own key order.

**Behind the token**, like every route: `/mcp` is not in `OPEN_PATHS`, and `Read` passes the caller's
Authorization header on, so one token governs both doors. A successful MCP call is not logged — it is a
POST that reads, and an agent in a loop is the flood a GET is.

**Not in `/openapi.json`**: one JSON-RPC endpoint is not an OpenAPI operation, and the tools describe
themselves in `tools/list`. So `hc.types.ts`, whose coverage reads that description, is unaffected;
`coverage.test.ts` holds the MCP scenarios to the tools the door LISTS instead, as the bot's are held to
its "/" menu.

**Reached at `https://<tailnet-host>/opt/api/mcp`.** The tailnet already maps
`/opt/api` to `127.0.0.1:31415` with the prefix stripped, so the app sees `/mcp`: no change to the
Tailscale serve table or `~/recovery.sh` (#447's note suggested an `/opt/mcp` mapping; it is not needed,
and one fewer mapping is one fewer thing `recovery.sh` must rebuild). Connect with
`claude mcp add --transport http optionality https://<tailnet-host>/opt/api/mcp`
(and `--header "Authorization: Bearer <API_TOKEN>"` once a token is set).

## Consequences

- The market-data invariant gains no call: the MCP's live reads ARE the existing `/quotes`,
  `/positions/values` and `/references` calls, made at most once per 5 seconds whoever asks.
- A new tool is a line in `schema/mcp/server.json`, a GET the API already documents, a scenario, and
  the two lists the suites state. A tool that needs a figure no GET serves needs a route first.
- On-demand quotes for an arbitrary contract (decision 5's "later expansion") would be the first tool
  that is not a GET the dashboard makes; it would need its own bounded call and its own ADR.
