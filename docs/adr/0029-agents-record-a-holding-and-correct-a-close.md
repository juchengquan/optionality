# 29. Agents record a holding and correct a close, behind a second switch

Date: 2026-11-19

## Status

Accepted and built (#458). Decided by the owner on 2026-11-19. Both backends carry it, in lockstep
(ADR 0021).

**Amends ADR 0028**: its allow-list of two writes becomes FOUR — `POST /positions` and `PATCH
/positions/{id}` join `POST /monitors` and `PATCH /monitors/{id}` — and "no holdings, no closes" becomes
"no close, no delete, and of a holding only these two". Everything else in ADRs 0026, 0027 and 0028
stands: the same `Write`, the same `allowedWrite`, the same cap, the same notice path and the same log.

## Context

Agents add and edit watch rules over MCP (ADR 0028). The second tier lets them write to the BOOK
itself, narrowly: record a holding the owner has just opened, and correct a closed holding's exit or
close day when it was typed wrong. The owner's decisions on #458, final:

1. **The second tier is exactly** record a holding (`POST /positions`) and correct a close's exit or
   date (`PATCH /positions/{id}`).
2. **Never available to agents**: closing a holding (it cannot be undone through the API and it
   silences the holding's alarms), correcting a leg quantity, editing an entry, contracts or
   `opened_at`, `POST /spreads` with *held* (it can replace watch rules), deletes, and total-entry.
3. **Its own switch**, `MCP_WRITES_POSITIONS`, effective only while `MCP_WRITES` is on too, so turning
   rule writes on never turns writes to the book on.
4. **One cap**: `MCP_WRITES_PER_10_MIN` is shared by rule and position writes.
5. **`record_holding`'s input mirrors `price_spreads`'**; `entry`, `contracts` and `opened_at` are
   required; `opened_at` can be neither in the future nor more than 5 days back.
6. **`correct_close`** changes `exit` and `closed_on` only, the holding found by id or name.
7. **A Telegram line per write**, and a record names the rules the new holding took over.
8. **A watch rule a new holding takes over** becomes the holding's rule, and `edit_rule` then refuses
   it, as ADR 0028's decision 9a already says of every holding's rule.

## Decision

**The allow-list holds four pairs**, each a write tool's `method` and `path` in `schema/mcp/server.json`,
and `allowedWrite` (`writes.ts`, `writes.py`) refuses every other before the app is asked:

| tool | write | annotations |
|---|---|---|
| `add_rule` | `POST /monitors` | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` |
| `edit_rule` | `PATCH /monitors/{id}` | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` |
| `record_holding` | `POST /positions` | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` |
| `correct_close` | `PATCH /positions/{id}` | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` |

`POST /positions/{id}/close`, `DELETE /positions/{id}`, `POST /spreads` and every other write stay
refused, and the test of `allowedWrite` in each language states all four pairs and those refusals.
Each write tool names its tier in the table (`"tier": "rules"` or `"tier": "positions"`), which is
what decides the switch it answers to.

**The second switch, `MCP_WRITES_POSITIONS`** in `.env`, read as `MCP_WRITES` is (`1` or `true` on,
`0`, `false` or nothing off, anything else fatal at boot). It is in force only while `MCP_WRITES` is on
as well; on while `MCP_WRITES` is off, the MCP door says so in the log once, when it is built at boot,
and treats it as off. In force or not, the door then behaves as the rule tier does while `MCP_WRITES`
is off: `tools/list` omits `record_holding` and `correct_close`, and a `tools/call` to either is a tool
error naming the switch, made before anything else — no read, no write, nothing counted. `initialize`'s
`instructions` say which writes are on: `server.json`'s `instructions`, then `writes_off`, or
`writes_on` followed by `positions_on` or `positions_off`.

**`record_holding`** takes `{name, expiry, legs: [{side, option_type, strike, qty?}], entry, contracts,
opened_at, strategy?}`: a structure as `price_spreads` takes one, a quantity included, and what a
holding is recorded with. The door writes `POST /positions`' body — `expiry` as `strike_date`, each leg
as given — and refuses, itself and uncounted, before any write:

- a required field missing, or one of the wrong type (a null `entry`, `contracts` or `opened_at` is
  missing: the route would take it as "unknown", which an agent may not leave);
- an `opened_at` after today's New York market day (`marketDate` of the injected clock — never the
  machine's zone, nor UTC's day, which is already tomorrow from 19:00 or 20:00 in New York);
- an `opened_at` more than `OPENED_WITHIN_DAYS` (**5**) calendar days before that day. The constant is
  the door's, stated in the tool's description; a holding opened earlier is recorded on the page.

Everything else is the route's, unchanged: its probe of every leg (one bounded call, the creation
probe the invariant already lists), its 409 on a name already recorded, its other refusals and its
linking of the rules that watch the new holding's contracts (`adoptOrphanMonitors`).

**`correct_close`** takes `{id, exit?, closed_on?}` and at least one of `exit` and `closed_on`. `id` is
resolved as `holding_history` resolves it (`LOOKUPS`): the holding's id or its name, through `GET
/positions`, only the resolved id reaching the path. Any other argument is refused by the door's
argument check, so no other field of a holding can be reached — and the body the door writes is built
from those two keys alone. The door also refuses, uncounted, an edit that changes nothing: neither
given, or each given equal to what the holding already says (`exit` as a number, `closed_on` as a
date). A null is "not given", so an agent cannot blank an exit; that stays on the page. An OPEN
holding is not the door's to refuse: the route already refuses an exit or a close day on one ("is not
closed: close it first"), so this tool can never close a holding, and that refusal reached the route
and is counted.

**The cap** is ADR 0028's, one memory for all four tools: every write that reaches the route counts,
its refusals included; the door's own refusals do not.

**The notice.** Every write the route accepts sends ONE Telegram line, worded by the domain's
**`agentHoldingNotice`** (`alarm.ts`, beside `agentNotice`, golden-cased, ported as
`agent_holding_notice`), from the holding before (null for a record) and after, and the rules it took
over:

- `🤖 agent recorded dec-condor 20261218 −P6800 +P6750 ×2 @ 1.25, opened 20261119` — the legs written
  as everywhere else (short first, a real minus, a quantity between the sign and the contract,
  `−2P6800`), `×` the contracts (always written, `×1` too), `@` the entry to its typed places (at least
  two, a debit with a real minus), the dates YYYYMMDD;
- `…, opened 20261119, taking over 1218-6800 |value| ≥ 4.51` where the route linked existing rules to
  the new holding — each in the alarms' short form, named as every alarm names it, sorted, joined with
  `, ` and the last with ` and `. They are read from `GET /monitors` after the write (a read, not a
  write, and not counted): the rules whose `positions` hold the new holding's id. A read that fails
  leaves them out, and the log says so; the write stands;
- `🤖 agent corrected the close of dec-condor: exit 0.40 → 0.35, closed 20261118 → 20261119`, saying
  only what changed (a blank exit before is `—`).

A notice that cannot be sent is logged and the write stands, as ADR 0028's. **The log** gives one line
per write attempted, refusals included, as ADR 0028's.

**The answer** is `{source, read_at, data}`: `source` the write made, `data` the route's body rounded as
the `positions` tool's is (#454: `entry`, `exit` and `realized_points` to 2). A refusal by the route is
a tool error in its words: `POST /positions answered 409: position 'dec-condor' already exists`.

## Consequences

- The market-data invariant gains no call: `record_holding`'s probe is `POST /positions`' own
  creation probe, and at most `MCP_WRITES_PER_10_MIN` writes of any kind reach the routes in ten
  minutes.
- An agent can add to the book and correct a close, each change on the owner's phone; it can never
  close, delete, re-shape or re-price a holding.
- A rule a recorded holding takes over leaves the agent's reach (`edit_rule` refuses a holding's rule),
  which the notice says by naming it.
- The read of `GET /monitors` after a record is not atomic with it: a rule the page links in between
  would be named too. It is named because it IS the holding's rule after the write, which is what the
  owner needs to know.
