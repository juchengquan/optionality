# 18. References stay on the page, and SPX is reached by a scaled proxy

Date: 2026-11-02

## Status

Accepted. Decided with the owner on 2026-11-02. Amends the Provider invariant in CLAUDE.md, whose
list of bounded calls gains one, and adds two terms to CONTEXT.md while narrowing the wording of a
third. Does not amend ADR 0015: one Provider still answers, chosen before the service starts, and
nothing here mixes two.

## Context

The owner asked for some tickers to stay on the page for reference, and named SPX and VIX. Nothing
in the service could carry them: `buildSpxCode` is the only code generator and it writes
`US.SPXW` + six digits + C/P + strike×1000, so an index has no spelling here, and every figure on
the dashboard hangs off a Monitor, which is a rule with a threshold. There was no way to show a
live figure that never alarms.

**The index is not reachable through moomoo.** Measured against the live OpenD on 2026-11-02,
because it is a fact about the account rather than about the code and no test may reach a gateway.
Fourteen spellings, four indices, three quote endpoints:

    US..SPX   THREW US stock indices are not supported    US.$SPX    THREW Unknown stock. $SPX
    US..DJI   THREW US stock indices are not supported    US.^SPX    THREW Unknown stock. ^SPX
    US..IXIC  THREW US stock indices are not supported    US.SPX     unknown
    US..VIX   THREW US stock indices are not supported    US.INX / US.SPX500 / US.SPXUSD  unknown

    GetSecuritySnapshot  US..SPX  ✗ US stock indices are not supported
    Sub (subscribe)      US..SPX  ✗ US stock indices are not supported
    GetBasicQot          US..SPX  ✗ US stock indices are not supported
    GetStaticInfo        US..SPX  ✓ id 200003, secType 6, "S&P 500 Index"

The refusal is about the security CLASS, not the name: every correctly spelled index is recognised
and declined, every misspelling comes back unknown. moomoo hands the correct spelling out itself —
`stock_owner` on each of the owner's own options reads `US..SPX` — and `GetStaticInfo` will give
its name and type. It will not quote it, through any endpoint. futu's own code table agrees,
listing the S&P 500 as `US..SPX` and flagging indices as not available yet. This cannot be
reproduced without a live OpenD, which is why the output is recorded here.

**ETFs quote normally.** `US.SPY`, `US.VIXY` and `US.QQQ` all answered, with name, bid, ask, a
real mid and prev close — 21 fields against an option's 37. Two readings came out of that which
reasoning had got wrong:

- A non-option carries a two-sided quote, so it has a mid like anything else. `snapshot.ts`
  already guards the option block with `if (ex)` and maps the rest, so an ETF needs no mapping work.
- `last_price` is the WORSE figure: SPY's last trade read 755.72 while its live mid was 758.73,
  stale from the previous session while the book was current pre-market.

**A refused code cannot be contained.** `opend/client.ts`'s containment loop drops a code moomoo
NAMES as unknown and re-throws everything else, deliberately, so that an outage cannot present as
a watchlist of unknown contracts. A class refusal names no culprit, so it re-throws. A Reference in
the sweep's batch would therefore kill every sweep every fifteen seconds and take the healthy
rules dark with it — the failure of #175, from a code a reasonable person would type first.

**VIX has no honest proxy.** VIXY holds short-term VIX futures and bleeds on the roll, so its
level says nothing about where VIX is. The question VIX was wanted for — whether a pace gap is the
market's or the position's — is already better served by `option_implied_volatility`, which arrives
per contract and is what the Vol part is built from.

## Decision

A **Reference** is a Security kept on the page to read the market by. It never alarms, need not be
held, and no rule reads one. **Security** joins the glossary as the parent of Contract: anything a
Provider can quote, named by a code — which the service builds itself for a Contract and is given
for everything else. Without that parent, admitting `US.SPY` would have falsified Contract's claim
that a code is "built from those three facts", and widening Contract was not available because Leg
is defined on top of it. `On-pace`'s "a REFERENCE, never a rule" becomes "a guide, never a rule",
so that sentence stops reading as a type claim about a thing On-pace is not.

1. **Any code may be a Reference**, validated by the same strict live probe that gates monitor
   creation. The input is a raw code, not an expiry/type/strike, because `buildSpxCode` cannot
   write `US.SPY`. Allowing options in costs nothing on the way in and gives, free, the ability to
   watch a strike with no rule on it.
2. **References live in the database, not in `.env`.** They are a list that grows, which is data
   rather than a behaviour knob. CLAUDE.md's "No DB config layer" is not weakened: this is a table
   of subjects, like monitors and positions.
3. **A Reference carries a `scale` and a `label`.** SPY quotes at 758.73 against strikes of 6950
   and 8100; unscaled, the strip charges a mental ×10 at every glance. The strip shows the
   arithmetic — `SPX (via SPY ×10) → 7587` — and never prints a figure that reads as the index
   itself, because SPY×10 is not SPX: there is tracking error, there are dividends, and the two
   trade different sessions. `scale` is nullable, meaning ×1.
4. **Reference quotes come from a bounded call of their own**, behind `GET /references`, and the
   Provider invariant gains it. Sharing `/quotes`' batch would cost no extra call but would let one
   bad Reference blank the whole watchlist. The watchlist is what the owner acts on; a backdrop
   must never be able to blank it. References are NOT in the sweep, which is forced rather than
   chosen — see the containment finding above — and they never alarm, so the sweep has no use for
   them.
5. **On a thrown reference fetch, the reference path retries one code at a time**, bounded by the
   number of References. The culprit shows a dash and the rest still read. This is NOT fixed in the
   shared `batch()`: there a persistently refused code would mean eight calls every fifteen
   seconds, worse than failing and a risk to the sweep watchdog. The reference path can afford what
   the sweep cannot.
6. **A Reference is never auto-disabled, never notified and never deleted.** Its absence is not an
   event. Quarantine does not transfer — it is defined as a Monitor the service disabled because it
   cannot be EVALUATED, and a Reference evaluates nothing — and nothing would be in a position to
   do it, since no sweep reads References and routes here do not write state. A missing figure is a
   dash, and removing the row stays the owner's decision.
7. **The strip sits below `TopLine` and above the Single-leg table.** Not above it: `TopLine`
   appears rather than reports, and its own comment says why — "a line that is almost always the
   same becomes furniture and stops being read, which fails on the one day it matters". A Reference
   strip is that furniture by design, so it must not occupy the position that has to stay
   conspicuous. It is never urgency-coloured and never enters `needs()`.
8. **`domain/reference.ts` owns the figure**, cased and ported. The decision it carries is not the
   multiplication — it is WHICH FIELD is true: prefer `mid_price`, fall back to `last_price` where
   there is no two-sided quote, and answer "no figure" where neither arrived. The measurement above
   is why that ordering is not obvious, and a missing mid times a scale of 10 is `0`, which prints
   as a price. The change against prev close is scale-free and stays so.
9. **Dashboard only.** No bot command. The bot is the channel for being away from the screen when
   something needs you; a backdrop meant to be read beside the strikes has little value pushed to a
   phone, and each command costs a Provider call. `/reference` stays cheap to add later.

`verifyContracts` is corrected as part of this: on a thrown Provider error it answers "cannot
verify contract: OpenD unreachable", so adding `US..SPX` would report an outage that has not
happened. It must distinguish a Provider that could not be reached from one that answered and
declined. The decision half is `domain/quote.ts`, so this is cased and ported too.

### Rejected

- **Migrating to IBKR**, which does serve SPX and VIX spot. `backend/src/ibkr/` is EXPERIMENTAL,
  "proved against a stub gateway and never against a real one", ADR 0015's five first-contact
  questions are unanswered, and a Provider is "settled before it starts and never mixed with
  another" — so this is not "add indices", it is a Provider migration. Left open: if that migration
  ever happens, a Reference on `US..SPX` with no scale is the whole of what changes here.
- **Deriving SPX from the option chain** by put-call parity. Both sides are already fetched, but it
  would be a computed number rather than a Quote, and a Reference is defined as something nothing
  is derived from.
- **A fixed `.env` list**, rejected by the owner on the grounds that a list is not a single value.
- **VIXY as a VIX proxy.** Its level carries no information about VIX.

## Consequences

The service shows a figure that no rule reads, for the first time. Every existing figure justified
itself by being alarmable; this one justifies itself by being read, which is a weaker claim and the
reason `Reference` is defined as narrowly as it is.

The Provider invariant now lists five bounded calls where it listed four, and the dashboard's poll
makes two where it made one — three while the Holdings panel is open, which already polls
`/positions/values` on its own. At a 15-second cadence that is eight a minute, against a snapshot
limit nowhere near it and a subscription quota measured at 100 free. ADR 0010's warning that
polling is not free still holds and is now closer to mattering.

A new `domain/` module means `make cases` regeneration, a Python port, both FINGERPRINT stamps
moving, and `agrees()` reporting a disagreement until a fresh `make py-cut`. That is the price of
"the directory is the fact" and it is being paid deliberately: the alternative was to put pure
arithmetic in `routes/` to stay out of `domain/`, which would have dodged the guard while keeping
the logic backend-side.

The strip must wrap at 390px, which needs a browser test beside the existing "never lets anything
push the page sideways" — a green suite can hide an unusable UI.

What is NOT settled: whether a Reference on an option ever earns its place beside a Monitor on the
same contract. The capability falls out of decision 1 at no cost and may simply go unused.
