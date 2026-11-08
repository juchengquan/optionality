# 19. A Reference names its source, and the proxy goes

Date: 2026-11-08

## Status

Accepted. Decided with the owner on 2026-11-08, six days after ADR 0018 and on the strength of
measurements that did not exist when it was written.

Supersedes the second half of **ADR 0018** — "and SPX is reached by a scaled proxy". The rest of
0018 stands: References live in the database, are never auto-disabled, a missing figure is a dash,
the strip sits below `TopLine` and is never urgency-coloured, and `domain/reference.ts` still owns
which field is true.

Amends **ADR 0015**: its bounded-call invariant is widened from the Provider to any market-data
source, and its one-Provider rule is stated as not reaching a Reference. The Provider-only wording
is **deprecated** rather than quietly replaced, so a reader of the history sees the rule got wider
and why.

Amends **CONTEXT.md**: `Reference` loses its proxy clause and gains a source.

## Context

ADR 0018 chose `SPY ×10` because the index could not be had. That premise was true of moomoo and
false of the world, which a day of probing on 2026-11-08 established:

- **moomoo refuses every index as a class.** Asked for `US..VIX`, whose own static info it returns
  as "CBOE Volatility S&P 500 Index", its snapshot answers `US stock indices are not supported`.
  The refusal names no code, which is why the containment loop cannot drop it and the whole batch
  dies — the reasoning 0018's invariant note argued, now in moomoo's own words.
- **IBKR serves them.** SPX, VIX, the whole VIX term structure, SKEW, OEX, NDX and the Nasdaq
  Composite all resolve as contracts and return figures: delayed on the free tier, real-time with
  the `Cboe Streaming Market Indexes` subscription at USD 3.50/month, flat, no prerequisite.
- **Yahoo serves them free and real-time**, `^GSPC` at zero delay matching Cboe's own published
  close to the penny.
- **And the proxy's error was measured for the first time.** SPY closed at 735.29 against an SPX
  of 7376.86 — the strip would have read **7352.90, twenty-four points low, 0.32%**. Tracking
  error, dividends and different session hours, exactly as 0018 predicted, now with a number.

The owner's judgement on that number was not that it is too large. It is that a scaled stand-in is
a simulation rather than a reading, and does not belong on a page used to decide whether to close a
position.

## Decision

1. **A Reference may be fetched from a source other than the Provider, and must name it.** The
   one-Provider rule exists for two stated reasons — doubled entitlements, and no answer to which
   figure an alarm fires on — and neither reaches a Reference: nothing on the strip alarms, nothing
   derives from it, and it is one bounded call either way. The unstated reason is the real
   constraint: a figure on screen is acted on by a person whether or not code depends on it. So the
   answer is a label, not a prohibition.

2. **The source is an explicit vendor** — `moomoo`, `ibkr`, `yahoo` — never "the Provider". A row
   reading "from the Provider" would silently change meaning the day `OPTIONALITY_PROVIDER`
   changes: a different company's figure for the same ticker, under the same unchanged label. And a
   label that says `(Provider)` tells the reader nothing they did not already know.

3. **No proxies, and `scale` is dropped.** The decision kills `SPY ×10`; it would have spared
   `DJX ×100`, which is a unit conversion rather than a stand-in and exact by definition — except
   the Dow arrives as `^DJI` under its own name, so nothing needs scaling at all. A nullable column
   nothing sets is how a field survives for years, so it goes. `label` is KEPT and matters more than
   before: `^GSPC`, `US..SPX` and `SPX` are three vendors' names for one index, and none of them is
   what the owner calls it.

4. **The bounded-call invariant covers any market-data source, not the Provider.** Left
   Provider-specific, it would have permitted an unbounded call to a Reference source — a loophole
   created by this very change. The count is **one bounded call per source in use**, not per
   Reference: three figures from IBKR remain one IBKR call.

5. **Containment holds between sources.** A logged-out IB Gateway must leave a moomoo-sourced
   figure showing, not dash it alongside. This is the same argument that gave References their own
   call in 0018, one level up: there, so a bad code could not blank the watchlist; here, so a dead
   vendor cannot blank a live one.

6. **The IBKR connection is held open and shared.** Opening one per dashboard refresh is a
   handshake and a session start 5,760 times a day to read two numbers — the waste `opend/client.ts`
   already rejected for websockets. Held, it occupies one client id permanently, which is why those
   ids are the owning process's port. If IBKR later becomes the Provider it uses the SAME client,
   not a second one beside it: two connections to one gateway for the same data, each with its own
   id and handshake, is a trap worth closing before it exists.

7. **Freshness is labelled from what the source said, never from configuration.** IBKR reports the
   grade it actually served, and it contradicted a request once on 2026-11-08 — asked for delayed,
   it granted live. So the gateway's answer is read rather than our request assumed. Translated at
   the edge into two independent flags, because the four grades are two questions:

   |                   | updating        | last known       |
   |-------------------|-----------------|------------------|
   | **live-entitled** | `(ibkr)`        | `(ibkr, last known)` |
   | **delayed tier**  | `(ibkr, delayed)` | `(ibkr, delayed, last known)` |

   `delayed` is a fact about the subscription and will not change during the day. `last_known` is a
   fact about right now. Both are **nullable**, and null is not false: moomoo reports no grade at
   all, and rendering that as a bare `(moomoo)` would read as "live and updating" when the honest
   answer is "it never said". So a source that reports no freshness says nothing on the strip, and
   the Service panel — where References are added — records which sources report it and which do
   not. Minutes appear only where the source states them: Yahoo reports
   `exchangeDataDelayedBy: 15`, IBKR reports a tier and no duration, so `(yahoo, 15m late)` and
   `(ibkr, delayed)` are each what their vendor actually said.

   No flag is invented for "live-entitled but not actually updating". That happened on 2026-11-08 —
   eighteen identical readings over three minutes — and no grade detects it. A label implying a
   freshness check the service does not perform would be worse than silence.

8. **Creation stays strict, against the named vendor.** A dash already means "no figure right now",
   which happens innocently and constantly; if a typo also produced a dash, a permanently broken
   row would be indistinguishable from a temporarily quiet one for ever, and `VIX` from `VXI` by
   looking. The cost is real: IB Gateway logs out every Sunday by design, so adding an IBKR
   Reference requires logging in first. That is one extra step on a rare action, for a strip that
   needs the login anyway to show anything.

9. **Three sources, built in this order: moomoo, IBKR, Yahoo.** moomoo first because it needs no new
   client and lands the schema while `reference_securities` holds **zero rows** — dropping a column
   will never be cheaper. IBKR next: official, measured, and the only route to a real VIX.
   Yahoo last and behind one file, pinned to an exact version.

### Rejected

**Keeping the proxy until IBKR lands.** It would avoid a quiet strip, but the owner's objection is
to the arithmetic itself, and `SPY 735.29 (moomoo)` is a true statement about a thing worth reading.
So the plumbing lands now with SPY shown as SPY, and nothing goes dark.

**Hand-rolling Yahoo with no dependency.** Attempted and abandoned on measurement: a plain Node
`fetch` is refused with `429 Too Many Requests` from both hosts and every endpoint, and so is the
cookie-then-crumb exchange. `yahoo-finance2` succeeds from the same Node process at the same
minute. The library does something the hand-rolled flow does not, and reverse-engineering it would
produce code that works until Yahoo changes something unannounced.

The cost of not hand-rolling was argued here as **111 transitive packages**, including an MCP SDK
and an HTTP server, and that figure was wrong — it was measured by installing the library into an
EMPTY directory, which counts the whole tree rather than what it adds to this one. Installed for
real, this repository went from 596 packages to **607: eleven added**, none of them an MCP SDK or
an HTTP server. Those two were already in the tree before this change. The corrected figure is in
the record because the inflated one was part of the argument for rejecting Yahoo, and the owner
chose it anyway.

Eleven is still eleven, and two of them are worth naming: `tough-cookie-file-store`, which is how
the library persists the cookie it needs, and `fetch-mock-cache`, a test helper shipped as a
production dependency. Taken deliberately, pinned to an exact version, contained behind one file
as the moomoo SDK is, and recorded here as the weakest link in the service: the only component
with no contract behind it.

Two wrong conclusions were reached on the way to that one and are recorded so the next reader does
not repeat them: that Yahoo's `429` was an authentication requirement (it is not — the crumb
endpoint refuses too), and that Yahoo blocks on TLS fingerprinting because `yfinance` impersonates
Chrome (it does not — `yahoo-finance2` succeeds from plain Node).

**Yahoo only, skipping the subscription.** Yahoo gives index LEVELS free and real-time, but the VIX
family only delayed. For a condor seller a live volatility reading is the figure that cannot be had
any other way, and USD 3.50 buys it.

**Passing IBKR's grade vocabulary through.** `frozen` means "last known because the market is shut",
which is normal and not a fault, and the service's own rule keeps vendor jargon out of the API — the
reason it says "quote" and never "snapshot".

## Work that can proceed in parallel

Four tracks. A and B share only the migration; C and D touch no file the others do.

**A — the schema and the API.** Migration dropping `scale` and adding `source`, the same shape in
`db/schema.sql`, `COLUMNS`/`NULLABLE`/row interface/`SchemaChecks` in `db/rows.ts`, the input schema
losing `Scale` and gaining a source enum, the three routes, `hc.types.ts`. Blocks nothing else once
the row interface exists.

**B — the per-source routing and containment.** `references.ts` grouping rows by source, one bounded
call each, a failure in one leaving the others' figures intact, and the one-at-a-time degrade argued
per source rather than inherited. Needs A's row interface and nothing more; can be built against two
fake sources before either real one exists.

**C — IBKR as a source.** `secType IND` and an index exchange in `ibkr/messages.ts`, the bounded
call, contract resolution with its cache, the grade translation into the two flags, and the shared
client. Independent of A and B — it answers a `QuoteFetcher` and knows nothing about References.

**D — Yahoo as a source.** One file behind the same seam, the dependency pinned, the delay minutes
read from `exchangeDataDelayedBy`. Independent of everything else.

**E — the strip and the Service panel.** Rendering the source, the two flags and the minutes;
dropping the `via X ×N` arithmetic; the Service panel's note on which sources report freshness. Needs
A's API shape. The 320px geometry test from 0018 must be re-measured, since the longest line changes
from `Nasdaq 100 (via QQQ ×25) 14,962.50 -1.23% last` to something with a source and two flags.

## Consequences

**The weakest link in the service is now a scraper's client library.** Every other data path has a
vendor contract behind it. This one has eleven added packages and a block being worked around. It is pinned,
contained behind one file, and expected to break; when it does, a Reference shows a dash with its
reason and nothing else in the service notices. That is the whole reason this is only allowed for a
figure nothing derives from.

**The strip will show dashes more often.** IB Gateway logs out weekly and needs a human at a screen;
moomoo's OpenD exited unattended on 2026-11-08 and cost 646 failed sweeps over 2h42m. A strip fed by
three vendors has three ways to go quiet, and 0018's "a missing figure is a dash, never a fault" is
what absorbs it.

**The dashboard's poll grows by one call per source in use.** Two today, three with IBKR, four with
Yahoo — five while the Holdings panel is open. ADR 0010's warning that polling is not free moves
from "closer to mattering" to "the thing to watch", and the per-source containment is what keeps the
cost bounded rather than multiplicative.

**`domain/reference.ts` loses its scale argument**, which regenerates the golden cases, moves both
FINGERPRINT stamps, and needs the Python port updated — and `agrees()` will disagree until a fresh
`make py-cut`, which is already fifteen changes behind.

**An ADR six days old is being half-reversed.** Worth stating plainly rather than papering over:
0018 was right given what was known, and what changed is that the index turned out to be obtainable.
The lesson is not that the ADR was hasty — it is that "the Provider cannot quote it" was a fact
about one vendor recorded as a fact about the world.
