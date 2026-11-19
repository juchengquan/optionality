# 28. Agents add and edit alarm rules, behind a switch

Date: 2026-11-19

## Status

Accepted and built (#456). Decided by the owner on 2026-11-19. Both backends carry it, in lockstep
(ADR 0021).

**Amends ADR 0026**: "every tool is a GET the API already serves, and nothing else" becomes **every
tool is one GET the API already serves, or one of the WRITES `schema/mcp/server.json` lists**; and
decision 4, "read-only", holds whenever the switch below is off, which is the default. Everything
else in ADRs 0026 and 0027 stands.

## Context

Agents read the book over MCP (ADR 0026) and price any spread (ADR 0027), but cannot act on what they
find. The owner wants a first, narrow step: an agent may add a watch rule and edit one — its
threshold, direction, compare or name, or mute and unmute it. Nothing else: no holdings, no closes, no
deletes, no settings, and never an order. The owner's decisions on #456, final:

1. **The first tier only**: add a rule; edit a rule's threshold, direction, compare, name or enabled.
   No `POST /spreads`, no positions, no deletes, no settings.
2. **Two tools**, `add_rule` and `edit_rule`; muting is `edit_rule` with `enabled: false`. `field` is
   not editable by an agent.
3. **An allow-list** of write routes in `server.json`, held by a test; the door still imports no
   service.
4. **Off by default** (`MCP_WRITES`); off means not listed, and refused.
5. **A Telegram notice per successful write**, a log line per write attempted, and no database column
   recording who wrote. A notice that cannot be sent is logged, and the write stands.
6. **A cap**, `MCP_WRITES_PER_10_MIN`, default 10, counting every write that reaches the route —
   the route's own refusals included.
7. **No quantities**: a `qty` other than 1 is refused and pointed to the page.
8. **`add_rule`'s input mirrors `price_spreads`'**, and the route's defaults apply.
9. **Only a rule muted by hand** (`manual`) can be unmuted by an agent.
9a. **Only a watch rule** can be edited by an agent: a rule linked to a holding is changed on the page
   (decided in the build, 2026-11-19).
10. **MCP annotations** on every tool.
11. **The answer is rounded by #454's table.**

## Decision

**The door is handed a `Write` beside its `Read`** (`ports.ts`, `ports.py`): a method, a path, a JSON
body and the caller's Authorization header, passed on as `Read` passes it, answered with the status and
the body. `app.ts` (`app.py`) builds it as a request of the app's own, exactly as it builds `Read`. The
door wraps it at once in **`allowedWrite`** (`writes.ts`, `writes.py`), the only write any of its code
can reach: a method and path pair not listed for a write tool in `server.json` is refused there, before
the app is asked anything. The pairs are **`POST /monitors`** and **`PATCH /monitors/{id}`**, `{id}`
matching only the service's own ids (`^[A-Za-z0-9_-]{1,64}$`). A test in each language refuses every
other pair, and the import test still holds the door to `ports`, the library's pure domain and nothing
of the service.

| tool | write | annotations |
|---|---|---|
| `add_rule` | `POST /monitors` | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` |
| `edit_rule` | `PATCH /monitors/{id}` | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` |

Every read tool says `readOnlyHint: true` (and, as before, `destructiveHint: false`, `idempotentHint:
true`); every tool says `openWorldHint: false`. The annotations are each tool's in `server.json`, so
both backends list the same. A write tool's entry carries its `method` beside its `path`; a tool with
no `method` is a GET.

**The switch, `MCP_WRITES`** in `.env`: `1` or `true` is on, `0`, `false` or nothing is off, and
anything else stops the service at boot, as a mistyped knob does. Off — the default — `tools/list`
omits the two write tools, and a `tools/call` to either is a tool error saying writes are off, made
before anything else: no read, no write, nothing counted. `initialize`'s `instructions` say which:
`server.json`'s `instructions`, then its `writes_on` or `writes_off` sentence.

**`add_rule`** takes `{expiry, legs: [{side, option_type, strike, qty?}], field?, threshold,
direction?, compare?, name?}` — a structure as `price_spreads` takes one, so an agent can pass one
from the other. The door writes `POST /monitors`' body: `expiry` as `strike_date`; ONE leg as the
single-contract body (`option_type`, `strike`; its side means nothing to a rule on one contract);
two or more as the combo body, each `side` as its `sign` (short −1, long +1). `field`, `direction`,
`compare` and `name` are passed only when given, so the route's own defaults apply. The door refuses,
itself and before any route call: a `qty` other than 1, pointing to the page; a combo with no `name`,
as the route requires one; a `name` on one contract, whose code is its contract (the route would drop
it in silence); and an argument of the wrong shape or type. Every other refusal is the route's —
its probe and its words, unchanged.

**`edit_rule`** takes `{id, threshold?, direction?, compare?, name?, enabled?}` and at least one change.
`id` is resolved exactly as `monitor_history` resolves it (`LOOKUPS`, ADR 0026's amendment of
2026-11-18): the rule's id, its code or combo name, or its contract as the page writes it, through
`GET /monitors`; ambiguity and no match are tool errors in the same words, and only the resolved id
reaches the path. `field` is not an argument. **Only a WATCH rule** (the owner's decision of
2026-11-19, in the build): a rule linked to any holding — its `positions` non-empty or its `scope` set, as
that `GET /monitors` row serves it — is refused by the door, before any write and uncounted, with words
saying a holding's rules are changed on the page. **Accepted, by the owner in review of #457**: the check
reads the row and then writes, so a holding recorded in that window can link the rule after the check
passed and the edit still lands on it. Closing that window needs the route to refuse it (a route change),
which is out of this ADR's scope. `add_rule` is not held to it: a rule the route links to a holding as it
creates it is allowed, and its notice names the holding. **Unmuting**: `enabled: true` on a rule that is OFF for
any reason but `manual` — quarantined (`unknown-contract`, `no-figure`, `unreadable`), `expired`,
`holding-closed` — is refused by the door with that reason, read from the same `GET /monitors` row,
before any write. So is **`enabled: false` on a rule already off for such a reason**: the route records a
mute as `manual`, so muting a quarantined rule again would make it one this door could then unmute
(found in review of #457). An edit that leaves `enabled` alone keeps the reason — the route rewrites it
only when `enabled` is given. A rule already on may be sent `enabled: true`, and one muted by hand
`enabled: false`; neither changes anything.

**The cap**, `MCP_WRITES_PER_10_MIN` (default 10, at least 1): at most that many writes reach the route
in any 600 seconds, service-wide and over MCP only — the page and the bot are not counted. Every write
that reaches the route counts, its refusals included (a refused probe still cost a Provider call). The
door's own refusals do not. One more is a tool error saying, in whole seconds, when the next is
allowed. Kept in memory, like ADR 0027's cap: a restart forgets it.

**The answer** is `{source, read_at, data}`, as every tool's: `source` the write made (`POST /monitors`,
`PATCH /monitors/<id>`), `read_at` when it was made, and `data` the route's body, its figures rounded
by #454's table (`threshold` and `last_value` by the rule's `field`). A refusal by the route is a tool
error in the route's own words: `POST /monitors answered 422: <detail>`.

**The notice.** Every write the route accepts sends ONE Telegram message, in the alarm messages' short
form (#388), worded by the domain's **`agentNotice`** (`alarm.ts`, golden-cased, ported as
`agent_notice`) from the rule before and after:

- `🤖 agent added 1218-6750 |value| ≥ 3.00`, and where the route linked the new rule to holdings, each
  named, sorted by name: `🤖 agent added 20261218 P7100 |Δ| ≥ 0.20 on 1016_IC` (review of #457)
- `🤖 agent muted 20261218 P6800 |Δ| ≥ 0.20`, `🤖 agent unmuted …`
- `🤖 agent: 1218-6800 |value| ≥ 4.51 → ≥ 4.80` — the rule before, then after, its subject not
  repeated where it is the same (`→ value ≥ 4.80` where the compare changed it);
- `🤖 agent: 1218-6800 → dec-puts |value| ≥ 4.51` for a rename; and the pieces together where one
  edit makes several changes (`🤖 agent muted 1218-6800 |value| ≥ 4.51 → ≥ 4.80`);
- `🤖 agent: 1218-6800 |value| ≥ 4.51, unchanged` where the edit changed nothing said here.

A rule is named as every alarm names it (`contractName`): a contract as `20261218 P6800`, a combo by its
name. It is sent through the service's notifier, handed to the door by `main.ts`: Telegram not
configured is logged and sends nothing; a send that fails is logged; either way the write stands.

**The log**: one line for every write the door attempts — the tool, its arguments, and the outcome
(written, the route's refusal, or the door's) — refusals included. Reads stay unlogged.

**Door scenarios** hold it in both backends. An HTTP scenario's `expect` now carries `messages`, the
Telegram messages the event sent, where it sent any (absent where none), as a sweep's does.

## Consequences

- The market-data invariant gains no call: `add_rule`'s probe is `POST /monitors`' own creation probe,
  and at most `MCP_WRITES_PER_10_MIN` of them reach it in ten minutes.
- An agent can change what alarms the owner — never silently, since each change is on the phone, and
  never on a holding, a close or anything else.
- A new write tool is a line in `server.json` with its method, a route the API already serves, its
  scenarios, and an ADR: the allow-list is read from that table, and its test states the whole list.
- The live reads' 5-second cache is not cleared by a write: a `watchlist` read within 5 seconds of
  `add_rule` may not show the new rule yet. The write's own answer is the rule as written.
