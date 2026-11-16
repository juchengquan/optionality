# 24. SPX's price is derived from the options' premiums

Date: 2026-11-11

## Status

Accepted and built. The owner accepted the method on 2026-11-11 ("accept, build #288"), on the
market-hours check reported in #288. Both backends carry it, in lockstep (ADR 0021). **Amended
2026-11-16 (#416)**: outside the regular session the price is said stale (last section).

Decides what **ADR 0023** left pending: SPX's price, live and in each sample, which the strike
strip, the price map and the payoff's spot marker wait on. Amends **ADR 0011**, whose daily sample
gains a column.

## Context

The redesigned dashboard places strikes against the index: a dot on a strike strip, a line through
the price map, a marker on the payoff, and a distance in points and σ. That is a derivation, so it
cannot borrow the Reference strip's SPX — a Reference is a figure nothing derives from (ADR 0018),
and the index is not quotable from moomoo at all (it refuses `US..SPX` as a class).

But the service already holds the index's level without asking for it. moomoo serves each option's
`option_premium`: how far the index must move for the option to break even at expiry, as a
percentage of the index, worked out from the option's LAST price against the index as moomoo
quotes it at that moment. Inverted with that same last, with p = premium / 100:

    call  S = (K + last) / (1 + p)        put  S = (K − last) / (1 − p)

What was not known was whether the figure is current, and what to do about stale lasts.

## The check

A read-only probe ran the whole 2026-11-10 session, 09:30–16:00 New York: one bounded OpenD batch a
minute over 70 contracts (the watchlist's 14 legs, and calls and puts at 7 strikes near the money
on four expiries), with Yahoo's `^GSPC` fetched at the same instant. 390 batches had a live
control. `^GSPC` ranged 7494–7543.

- **Against `^GSPC`**, the batch median of the inversions: median 0.05 points, p95 0.64, max 2.9.
  The watchlist's 14 legs alone gave the same. One contract alone: median 0.07, p95 0.65.
- **The age of the last does not matter.** The error was the same for a last under a minute old and
  one over 13 hours old (median 0.07, p95 about 0.65 either way): moomoo recomputes the premium
  against the live index with whatever last it holds.
- **The mid is the wrong input**: inverted with it, median 2.6 points and p95 29.
- **Current, not lagging**: against `^GSPC` a minute earlier or later the median is 1.6–1.7 points;
  against the same minute, 0.04. Minutes when `^GSPC` moved 6 points or more had a p95 of 0.69.
- **Put-call parity**, which shares nothing with Yahoo: a line through each expiry's call-minus-put
  mids gives its forward and discount factor. Taking S as the derived figure or as `^GSPC` gives
  the same F − S to 0.02–0.03 points and the same implied carry to 0.05 %/yr on all four expiries,
  and the carries (2.7–3.7 %/yr) agree with the discount factors' rate (4.5–4.8 %/yr) less SPX's
  dividend yield.
- **At and after the close**: at 16:00:02 the figure was 0.42 points from Yahoo's close, and one
  batch the evening before was 0.01 from it. 16:00–16:15, when the index has closed and options
  still trade, was not measured.

## Decision

SPX's price is `derivedSpx` (domain, `quote.ts`): the MEDIAN, over every SPX option in the batch
carrying both a last price and a premium, of the inversion above, rounded to two places.

- **No staleness filter**, because the check found none was needed: it would only throw away
  contracts.
- **Never the mid**, and **never a Reference**: it reads only the options' own records.
- A last of zero or less is no trade and is left out; a negative premium (a deep put below its
  intrinsic value) is taken as it comes; an inversion that is not a positive finite number is left
  out.
- **No figure** is null with a reason: no SPX option in the batch; a Provider that serves no premium
  (IB Gateway, Yahoo); or premiums with no last trade beside them.

It is served on every row of `/quotes` and of `/positions/values` as `spx` and `spx_reason` — the
same on every row, as `contract_size` already is, because each response is ONE batch and the
figure belongs to that batch's instant (ADR 0010). Both responses stay lists. The sweep stores it
in each daily sample, `position_samples.spx` (migration 0010), derived from the sweep's own batch;
a sample whose SPX moved while its marks sat still is rewritten in the hours like any other figure,
and the column is no part of `takesSample`'s completion rule. Rows written before 0010 are null.

## Consequences

- **The measured error is one session's.** It is small against anything it is drawn beside —
  strikes are 5 points apart — but a session that behaves differently would show only in use.
- **IB Gateway as the Provider means no figure**: every strip shows a dash with its reason, and no
  sample carries SPX while it is the Provider.
- **A sample's SPX at 16:00–16:15 is assumed to be the close**, from the two points either side of
  that window. A probe through it would settle it.
- **A figure on every row** repeats one number per row of a response. That costs a few bytes and
  keeps both routes' shapes, where an object wrapper would have changed the old dashboard, the
  `hc` pins and every scenario that reads them.

## Amended 2026-11-16: outside the regular session, the last close's level, said so (#416)

The check above was made in the session. Overnight (GTH, 20:15–09:25 New York) and in the Curb,
moomoo quotes SPX options live but its SPX quote stands at the last close, and each `option_premium`
is worked out against that — so the median inverts to the last close's level: on 2026-11-15/16 the
holding and every watched row said 7561.68, Friday's, with `spx_reason: null`, and the strike
distances and σ were Friday's too. The price is not wrong as "where SPX last was", but it is not
where SPX is now.

So outside the regular session (`marketPhase`) the service keeps the price and says why it is not
current, in `spx_reason`, beside it: "index not computed overnight — the last close's level" (in the
Curb "after the close — the close's level"; while nothing trades "while the market is closed — the
last close's level") — `sessionSpx`, golden-cased and ported. `spx_reason` was "why there is no
price"; it is now that, or, beside a price, why the price is not current. On every live figure:
`/quotes`, `/positions/values` valued live. A holding valued from its close keeps the close's own
stored SPX, which is that close's. The samples' stored `spx` is unchanged — a sample is labelled
by its own `observed_at` — and, since #416 stores no price outside the regular session, a GTH row's
SPX is a vol reading's companion, never a priced one's.
