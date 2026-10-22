# 15. Market data comes from one Provider, chosen before the service starts

Date: 2026-10-22

## Status

Accepted. Decided with the owner on 2026-10-22, before any second provider exists: there is no
IBKR account on this machine, and the port lands ahead of anything that would use it. The plan the
decisions came out of is a separate artifact; this records what was settled and why.

## Context

Everything the service knows about the market arrives through one function:

    export type QuoteFetcher = (codes: string[]) => Promise<QuoteRecord[]>;

It is declared in `quotes.ts` rather than inside `opend/`, and `main.ts` constructs one client and
hands `opend.asFetcher()` to the sweeper, the routes and the bot. Above that line the system is
already vendor-agnostic: `fetchResilient`, the sweep, the alarm evaluation, the quarantine,
`/quotes` and the bot's tables all read a `Quote`, which is `Record<string, unknown>` — an untyped
bag of whatever arrived.

So a second provider is not an architectural question. Three narrower things stand in the way, and
only one of them is code.

**The identity of a Contract is a string we build in moomoo's spelling.** `buildSpxCode` lives in
`domain/` — the canonical layer, golden-cased and mirrored in Python — and returns
`US.SPXW261130C8100000`. It has no inverse anywhere. The grammar of that string is written out
three times for DISPLAY (`bot/format.ts`, the frontend's `shortContract` and `shortDate`) and never
once as a parse the domain owns. IBKR addresses contracts by numeric `conid`, so it needs exactly
the parse that does not exist.

**The containment reads moomoo's prose.** `fetchResilient` survives an unknown contract by matching
`/Unknown stock\.?\s+([A-Z0-9.]+)/` against the error text and retrying without the named culprit;
its own comment says that naming "is what makes containment safe". IBKR has no such sentence — a
snapshot for an unresolvable conid simply comes back without it.

**A figure that never arrives is silent.** `sweeper.ts` answers a missing value with
`console.warn` and `continue`. No Telegram notice, no disable, nothing on the dashboard. That is
tolerable while one provider supplies everything and intolerable the moment a provider might not,
because IBKR serves option greeks only to an account entitled to both the option (OPRA) and the
underlying — and for SPX the index is a separate CBOE subscription that OPRA does not include.
Five of the nine live monitors watch `option_delta`. On an unentitled account they would never be
evaluated, and the only evidence would be a log line every fifteen seconds.

Two measurements bounded the work. Every monitor in the live database watches one of two fields,
`mid_price` (4) and `option_delta` (5) — and `mid_price` is ours, computed as `(bid + ask) / 2` in
`opend/snapshot.ts`, never sent by moomoo. So the contract a provider must meet is about ten
fields, not moomoo's forty.

## Decision

- **One Provider per deployment**, settled in `.env` before the process starts and never mixed.
  Two at once doubles the market-data entitlements and leaves no answer to which figure an alarm
  should fire on when they disagree.
- **IBKR, when it comes, speaks the Client Portal Web API over plain `fetch`** — no third-party
  client. One bounded `GET /iserver/marketdata/snapshot` per batch is the shape the invariant
  already names, and the alternative (`@stoqey/ib`: one maintainer, last pushed March 2025,
  trailing the official client) is a dependency this service would load directly under node with
  no build step.
- **`parseSpxCode` joins the domain** as `buildSpxCode`'s inverse, with golden cases and the Python
  port every exported domain function has (ADR 0014). A Provider translates from the parse; the
  code stays the system's identity for a Contract, and the three display regexes can finally read
  one grammar instead of each knowing it.
- **The port returns what it got and what it could not**:
  `(codes) => Promise<{ records, unknown: string[] }>`. Each Provider knows its own failure in its
  own terms, and `fetchResilient` stops knowing a vendor's error grammar.
- **A Monitor whose figure has not arrived for N consecutive sweeps is quarantined with a notice**,
  exactly as an unknown Contract is: disabled, said out loud, never deleted. OBSERVED rather than
  declared — a Provider cannot truthfully announce which fields it supplies, because that depends
  on the account it speaks for and not on its code, so a declaration would pass while the data did
  not arrive.

## Consequences

- The port's signature change is mechanical but wide: the sweeper, the bot, three routes and every
  test fake. The compiler drives it, and for moomoo the behaviour is unchanged.
- The regex moves INTO `opend/client.ts`. moomoo's error prose becomes moomoo's business, which is
  where it belonged; nothing above the port can parse a vendor message again without noticing.
- `parseSpxCode` must be ported to Python and golden-cased, or `make test` goes red. That is the
  cost of the identity staying in the domain, and it is the cheapest of the three options
  considered.
- **The vendor's name leaves the API contract.** `Deps.opendReachable` becomes provider-neutral and
  `/health`'s `opend: true` becomes the Provider's own name and state. The dashboard reads that
  field, and zod's `.parse()` strips what it does not list, so the compiler catches the frontend.
- CLAUDE.md's invariant "Every OpenD call is a single bounded one" names one vendor and will be
  reworded. The invariant itself does not change: one bounded call per sweep, per `/quotes`, per
  `/positions/values`, per probe.
- The quarantine extension fixes a live moomoo bug. A field that stops arriving today is already
  silent, and the change also catches a subscription lapsing mid-life rather than only at startup.
  It is worth shipping whether or not a second Provider ever lands.
- Conids are cached in memory and rebuilt at boot, NOT stored. A vendor id in the schema would
  need an answer for what happens to those rows when the Provider changes or an id is reissued,
  and twelve lookups at ten requests a second cost about a second, once.
- `position_samples` keeps its Contract-code keys. The identity of a Contract does not change
  because the Provider did, so no migration and no reinterpretation of stored history.
- Out of scope, explicitly: placing orders (a Provider answers one question and cannot act),
  importing positions or fills from the broker, and running two Providers for comparison or
  failover.
- Unresolved until an account exists: whether greeks arrive at all on the owner's subscriptions,
  the real cost of the documented pre-flight (the first snapshot returns no data), what a dead
  gateway session looks like from inside the service, and whether `update_time` — moomoo's naive
  US-Eastern LAST TRADE stamp — has any Client Portal equivalent. The field IDs for bid, ask and
  last were taken from a cached reference and are not verified.
