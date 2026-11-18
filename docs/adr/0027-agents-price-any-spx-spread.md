# 27. Agents price any SPX spread

Date: 2026-11-19

## Status

Accepted and built (#452). Decided by the owner on 2026-11-19. Both backends carry it, in lockstep
(ADR 0021).

**Supersedes ADR 0026's "no tool prices a contract the service does not already watch"** (its decision
5, and the sentence in `schema/mcp/server.json`'s instructions), and **widens CLAUDE.md's first
invariant** — every call for market data is a single bounded one — by one more such call, named below,
with a cap of its own. Everything else in ADR 0026 stands: the door is read-only, every tool is a GET of
the API's own, and the other eight tools are unchanged.

## Context

An agent reading the book over MCP sees only what the service already watches or holds. It cannot ask
what a candidate — a December put spread nobody has entered — is worth now, which is the question that
comes before every trade. ADR 0026 refused it on purpose: every live read was then a call the dashboard
already made, so the market-data budget (moomoo's 60 snapshot calls per 30 seconds, shared with the
alarm sweep) could not be spent by an agent in a loop. Pricing an arbitrary structure is a NEW call, so
it needs a decision of its own and a bound of its own. The owner's decisions on #452, final:

1. **Scope:** any SPX structure an agent names, not only watched or held ones.
2. **The door stays GET-only**, the legs in the query; a POST is for later, if ever.
3. **Batching:** several structures per call, in ONE bounded batch, with `POST /spreads`' caps.
4. **A service-wide cap**, `SPREAD_QUOTE_CALLS_PER_30S` (default 12), counting every caller, plus a 5s
   cache keyed by the normalised request.
5. **Output:** per-leg quotes, the value, the natural bid and ask, signed Greeks, `spx` and the short
   strikes, `dte`, the payoff at expiry and the market's `phase`. No probability, no expected move.
6. **Out of hours as `/quotes`:** no last-trade fallback; Greeks still served; the stored
   regular-session close beside each leg as `last_known`, never summed.
7. **Payoff basis:** the `entry` given, else the mid now, else the shape alone.
8. **Surfaces:** the HTTP route and the MCP tool. No dashboard, no bot command.

## Decision

**`GET /spreads/quote?spread=<expiry>:<legs>[@<entry>][&spread=…]`**, one `spread` per structure:
`?spread=20261218:-P6800,%2BP6750&spread=20261218:-C7300,%2BC7350x2@-1.25`.

- `<expiry>` is `YYYYMMDD` or `YYYY-MM-DD`. A leg is `-` (short) or `+` (long), `C` or `P`, a whole
  strike above zero of at most six digits (an exact double, so both languages build one code; a
  longer one is the leg's 422), and an optional `x<n>`, the quantity 1–10 (absent is 1, as `qty` everywhere). A raw
  `+` in a query string arrives as a space, so a space where a sign goes reads as `+`.
- `@<entry>` is the structure's Entry in points per contract, signed like a Position's: a credit
  received is positive.
- SPX/SPXW only: every code is `buildSpxCode`'s.
- **Refused with 422 and the reason, before any Provider call**: no `spread`, a structure or leg that is
  not the grammar, a quantity outside 1–10, an expiry before New York's market day (the sweep's own rule
  for an expired rule, `expiry < today`; `POST /spreads` has no rule of its own and leaves it to its
  probe), more than 6 legs in a structure, more than 32 in the request (`POST /spreads`' caps, and its
  sentence for the second). Nothing else is refused: a contract named twice in one structure is priced as
  named.

**One bounded call.** Every distinct code of every structure, sorted, goes in ONE batch through the
Provider's `fetchQuotes` — the call `/quotes` and the creation probes make. A code the Provider names
unknown fails only the structures that hold it; a Provider that throws is the whole answer's **502**,
in `/quotes`' words.

**The cap and the cache are the route's**, so the HTTP door and the MCP door share both
(`price-spreads.ts`, `price_spreads.py`, one instance per app):

- **Cache:** an answer's BATCH is kept for 5 seconds (`SHARED_FOR_MS`), keyed by the request
  normalised — each structure's expiry, its legs and its entry in a fixed order, the structures in a
  fixed order — so the same structures asked in another order are the same key, and are answered in the
  order asked. A batch still in flight is joined. A batch that failed (the 502) is kept as the batch is,
  so a Provider that is down is asked once per window, as ADR 0026's door does. A cached answer spends
  nothing from the cap, and is the same answer, figures and `fetched_at` alike: everything time-bound in
  it is reckoned at the instant the batch was fetched.
- **Cap:** at most `SPREAD_QUOTE_CALLS_PER_30S` Provider calls by this route in any 30 seconds, whoever
  asks. One more is **429** in the error shape, saying in whole seconds when the next is allowed. A
  failed call counts: it was made. At least 1 (`.env`'s guard refuses 0, which would be a 429 with no
  answer to "when").

**The answer** is `{phase, fetched_at, spreads}`, `phase` the domain's `marketPhase` and `fetched_at`
the batch's, in `DISPLAY_TZ`. Each structure, in the order asked:

- `expiry` (YYYY-MM-DD), `dte`, `entry` (as given, or null), and `legs`, in the order given: `side`,
  `option_type`, `strike`, `qty`, `code`, the quote's `bid_price`, `ask_price`,
  `option_implied_volatility`, `option_delta`/`gamma`/`theta`/`vega`, `option_contract_size` and
  `fetched_at` (each a finite number or null), `mid_price` by `midPrice`'s one rule from those two
  sides, `error` (`unknown contract`, `no quote returned`, or `no two-sided quote`; null where the leg
  has a mid), and `last_known`.
- `value`: the signed mid sum under the legs' signs and quantities (`comboFieldSum`); null where any
  leg has no mid — no partial sums.
- `natural`: `{bid, ask}`, the worst-case fill (`naturalPrice`, a new domain function in `quote.ts`,
  cased and ported): `ask` is what OPENING costs — each long bought at its ask, each short sold at its
  bid — and `bid` what CLOSING gets, the reverse; signed as `value`, so `bid ≤ value ≤ ask`. Null where
  any leg has no two-sided quote.
- `greeks`: the signed sums of Δ Γ Θ ν, never IV; each null where any leg lacks it.
- `spx` and `spx_reason`: the batch's own `derivedSpx`, said as `sessionSpx` says it — as `/quotes`.
  `short_strikes`: each short leg against it (`strikeDistances`), as a combo on `/quotes` has them.
- `payoff` (`payoffAtExpiry`, one contract) and `payoff_basis`: from `entry` where given (`entry`);
  else from the mid now (`mid`, the Entry that opening at `value` would be: `-value`); else `shape` —
  the legs' value at expiry by strike, with `breakevens`, `max_profit` and `max_loss` null, since a
  P&L needs a price paid.
- `error`: `unknown contract: <codes>` where the Provider named any of its contracts unknown. Such a
  structure's `value`, `natural`, `payoff` and `payoff_basis` are null and its `greeks` all null; its
  legs are still listed, each with what the batch had.

**Out of hours, as `/quotes`.** A leg with no two-sided quote — moomoo's 0/0 while nothing trades — has
no mid and says so, and its structure's `value` and `natural` are null; IV and Greeks are served
whenever the Provider serves them. In the Curb and overnight the live quote is used wherever there is
one, as `/positions/values` does. Nothing falls back to a last trade.

**`last_known`** is the latest stored REGULAR-SESSION close of that contract — `{price, observed_on,
observed_at, timing}`, as `monitor_closes` gives a rule's — or null. It is read from `watch_samples`,
the one table that stores a contract's own mid (`legs_mid`), from any watched set holding the contract,
chosen by `closeSample` over the latest `LAST_CLOSE_DAYS` priced days, today's left out while the
session runs, as `lastCloses` does. `position_samples` store a holding's Cost to close and no leg's
price (CLAUDE.md), so a contract only ever held, never watched, has none. It is context beside the leg
and is never summed into `value`, `natural` or `payoff`.

**The MCP tool `price_spreads`** (`schema/mcp/server.json`, `live: true`) takes structured JSON:
`{"structures": [{"expiry", "legs": [{"side", "option_type", "strike", "qty"?}], "entry"?}]}`, with
the caps in its schema. The door checks only what it needs to WRITE the query — the shape and the
types, in its own words — and encodes it (each number as JavaScript writes it, `js_string` in the
Python; the query URI-encoded), then GETs `/spreads/quote`. Every other refusal is the route's 422,
returned as a tool error in the route's words, so the rules are said once. **The door does not cache
it** (`"cached_by": "route"` in the table): the route already shares its batch, and a second 5s cache in
front would serve a batch up to ten seconds old. The answer is `{source, read_at, data}` as for every
tool; `data.fetched_at` is when the prices were read.

**Door scenarios** hold every status, both doors and both backends. A scenario may now state
**`earlier`** requests — each with its instant, run through the same app before the event, their answers
unrecorded and their calls forgotten, and held to changing no row — because a cap and a cache live in
memory, as the engine's run of failures does in `sweeps`.

## Consequences

- The market-data invariant gains one named call, bounded twice: at most 32 legs, and at most
  `SPREAD_QUOTE_CALLS_PER_30S` calls in 30 seconds whoever asks — at the default, 12 of moomoo's 60.
  The sweep's own call, `/quotes`' and the page's are untouched.
- An agent can price what it has not entered; the dashboard and the bot cannot, by decision 8.
- `naturalPrice` is the domain's; the cap, the cache and the grammar are the backend's, ported module
  for module.
