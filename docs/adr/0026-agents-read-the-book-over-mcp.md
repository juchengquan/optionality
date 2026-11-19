# 26. Agents read the book over MCP

Date: 2026-11-18

## Status

Accepted and built (#447). Decided by the owner on 2026-11-18, and amended the same day: the
histories take a name. Both backends carry it, in lockstep (ADR 0021).

Decision 5, "no tool prices an arbitrary contract", is **superseded by ADR 0027** (2026-11-19): the
`price_spreads` tool prices any SPX structure through a bounded, capped call of its own.

**Amended by ADR 0028** (2026-11-19, #456): every tool is one GET the API serves, or one of the WRITES
`server.json` lists — `add_rule` and `edit_rule`, off unless `MCP_WRITES` is on — and the door is handed a
`Write` beside its `Read`, held to `POST /monitors` and `PATCH /monitors/{id}`. Decision 4, "read-only",
holds while that switch is off, the default.

**Amended 2026-11-19** (#454, below): a tool's `data` is its GET's body with its figures rounded by
key; "that GET's body" and "The text is canonical" are read with that amendment.

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
`^[A-Za-z0-9_-]{1,64}$` before any path is built from it (since the amendment below, the RESOLVED id). A request with an `Origin` is refused 403:
only a browser sends one, and the transport asks a server to refuse it against DNS rebinding.

**The text is canonical** (its figures rounded first, since the amendment of 2026-11-19): an answer is
written with every object's keys sorted, no whitespace, and
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

## Amendment, 2026-11-18: the histories take a name

The owner's decision ("option A"), from a live agent test: asked how `1218-6800` had moved, an agent
called `monitor_history {"id": "1218-6800"}`, got a 404, and recovered only by searching `watchlist`
for the id — three calls for one question. **`holding_history` and `monitor_history` now read their
`id` as an id OR a name** (the argument keeps its name, for the clients already calling it):

- A holding: its exact id, else its name (unique, `ix_positions_name`), open or closed — resolved in
  `GET /positions`, which lists both.
- A rule: its exact id, else its `code` as stored (a combo's name, `1218-6800`; a contract's
  `US.SPXW261218P6800000`), or a contract as the page and the bot write it (`20261218 P6800`, the older
  `261218 P6800`) read by `expandSpxShort`, the parser `/unwatch` uses — resolved in `GET /monitors`.
- Exact after JavaScript's `trim`: case is the owner's (two names differing in case are two names), except
  in a contract written the page's way, which the parser upper-cases as it always has.
- One match is answered exactly as the GET by its id, and `source` names that id, so the agent learns it.
  Several (a contract watched for its Δ and its price) is a tool error listing each as `id — rule`, in the
  rule's short form; none is a tool error saying what was tried.

The door still reads through `Read` alone: the list GET is one the API already serves, and the only new
imports are the library's pure `domain/contract` and `domain/alarm`, for the parser and the words. **What
the caller typed never reaches a path** — only an id read back from the list, held again to
`^[A-Za-z0-9_-]{1,64}$` — so a name like `../quotes` is looked up and not found. The argument's own
pattern widens from that id pattern to any 1–64 characters with no control character
(`U+0000–U+001F`, `U+007F–U+009F`) and no surrogate, the length counted in UTF-16 units as JavaScript
counts it (the Python matches against that view of the string, so a character beyond the BMP is refused
in both). Neither tool is live, so neither is cached: each call reads the list afresh. Door scenarios hold
every road in both backends: by id, by combo name, by contract code, by the page's spelling, by a
holding's name and a closed holding's, an ambiguous contract, no match, a path-like name and a refused one.

## Amendment, 2026-11-19: the figures are rounded

The owner's decision on #454. An agent read `"value":-4.100000000000001` for a spread and
`0.014551340999999995` for its delta: float noise from summing legs, which the API serves as computed.
**The MCP door now rounds its answers' figures** — in this door only: the HTTP API, the dashboard, the bot
and the routes' door scenarios keep the unrounded figures, and nothing a figure IS changes.

- **By key, per tool, from shared ground.** Each tool in `schema/mcp/server.json` carries a `round`
  table: `keys` (a key and its places, for a number under it or each number in a list under it, as
  `breakevens`), `maps` (a key whose value is a map of a leg's readings by contract code, and the places
  of its every value) and `by_field` (the keys of a rule's own figures). `rounding.by_field` gives those
  by the rule's `field`. Both backends read the one table and walk the body by one rule (`byKey`,
  `by_key`): a number takes the places of the key directly above it, and an object starts afresh. A key
  no table names is never rounded.
- **What to.** Prices in points, money and SPX levels — every quote's prices, `value`, `natural`,
  `combo_value`, `cost_to_close`, `entry`, `exit`, the schedule's costs, `realized_points`, a history's
  `price`, `pnl`, the payoff, `spx`, `breakevens`, the short strikes' `points` and `one_sigma`, a
  Reference's `figure` — to **2**. `option_delta`, `option_theta`, `option_vega` and
  `option_implied_volatility` wherever they appear, a short strike's `delta`, and every value in a
  `legs_delta`, `legs_vega` or `legs_iv` map (the holdings' included, the owner's ruling in the build) to
  **4**. `option_gamma` to **6**, because a spread's gamma (about −0.00004) reads 0 at four. The other
  fractions — `sigma`, `captured`, a Reference's `change`, a rule's `fill` — to **4**. The watchlist's
  `quote` is moomoo's whole record, so its other figures too (decided in review, #455): `open_price`,
  `high_price`, `low_price`, `prev_close_price`, `avg_price` and `turnover` to 2; `option_rho`,
  `option_premium`, `amplitude`, `turnover_rate` and `bid_ask_ratio` to 4; its volumes, open interest,
  lot and contract sizes, strike and days never. A rule's `watched`, `threshold` and `distance` by its
  `field`, and `rounding.by_field` places EVERY field a rule may watch (`WATCHABLE_FIELDS`) — each at the
  places that figure takes in a quote, null for one never rounded — held so by a test in each language;
  a history's `price_rule.threshold` is a price rule's, so 2. Never: ids, counts, `dte`, `qty`,
  `strike`, `contracts`, contract sizes, the payoff's slopes, `delayed_by_minutes`, the health settings
  and times.
- **How.** Half away from zero on the value the double HOLDS, to a JSON number: JavaScript's `toFixed`,
  which the Python reproduces as `optionality.js.to_fixed` and never `round()` (half to even). So 0.125
  is 0.13, and 2.675 — stored as 2.67499… — is 2.67 (the owner's ruling in the build). A zero rounded
  from a negative is written 0, never -0. Null stays null; a figure already short is unchanged. Held to
  one set of cases in both languages, `testdata/mcp/rounding.json`.
- **A tool error's text is not rounded**: it is the service's own words.
- **The text is still canonical**, as above, written from the rounded body. A test in each language
  walks every `POST /mcp` scenario's `data` and fails on a non-integer number under a key no table names,
  or one not rounded to its key's places.

## Consequences

- The market-data invariant gains no call: the MCP's live reads ARE the existing `/quotes`,
  `/positions/values` and `/references` calls, made at most once per 5 seconds whoever asks.
- A new tool is a line in `schema/mcp/server.json`, a GET the API already documents, a scenario, and
  the two lists the suites state. A tool that needs a figure no GET serves needs a route first.
- On-demand quotes for an arbitrary contract (decision 5's "later expansion") would be the first tool
  that is not a GET the dashboard makes; it would need its own bounded call and its own ADR.
