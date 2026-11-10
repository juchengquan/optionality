# 22. A closed holding is kept

Date: 2026-11-10

## Status

Accepted and built. Decided by the owner on 2026-11-10, in the design session that opened the
dashboard's redesign: "keep closed holdings", the exit "prefilled, editable", and the rules that
watched it "disabled". Both backends carry it, in lockstep (ADR 0021).

Amends **ADR 0011**, whose samples now outlive the trade they describe, and the glossary's
**Holding**, which said deleting was the only deliberate way a holding left.

## Context

Until now a holding left the dashboard one way: DELETE, which takes its daily samples with it
(the route clears them in the same transaction, because they reference the row). That was right
for a holding recorded by mistake and wrong for every other kind — a trade that simply ended.

It was measured. The backup of 2026-11-03 held two holdings, a call spread and a put spread of one
iron condor, with 29 samples between them; by 2026-11-08 both were gone, and with them the only
record of how that trade's cost to close, IVs and vegas moved. The samples are the one thing in the
database that cannot be re-entered (CLAUDE.md), and the trades whose history matters most — the
finished ones — were exactly the ones that lost it.

The redesign that opened on 2026-11-09 makes that a blocker rather than a loss: its review mode and
its history charts read closed trades, and there would be none to read.

## Decision

**Closing is a state of the row, not the removal of it.** `POST /positions/{id}/close` records two
things and changes nothing else about the holding — its legs, entry, Opened and samples stay:

- **`closed_on`**, a New York market date like Opened beside it. Given, it is taken as given (either
  spelling); left out, it is today's market date — or the expiry, if that came first, since nothing
  is held past one. Three bounds are refused: a day before Opened, a day after the expiry, and a day
  after today in New York — a close that has not happened yet is a plan.
- **`exit`**, the Cost to close actually got, per contract, in points — **signed like Cost to
  close**: positive when closing cost you (a credit structure bought back), negative when it paid
  you (a long sold). Entry is signed the other way round, a credit received being positive, so one
  subtraction serves both: a long put bought for 5.00 (Entry −5) and sold for 7.00 (Exit −7) made 2.
  The dashboard PREFILLS it from the Cost to close it is already showing, which already carries the
  sign, and says the convention beside the field, because a sale price typed positive for a long
  reads as a large loss. The route makes no market call, and a close after the expiry could not be
  priced anyway. Blank is kept as blank — the holding is closed either way.

A second close is a 409. There is no reopen. A mistyped close is CORRECTED, by PATCH, which takes
`exit` and `closed_on` on a closed holding (and refuses them on a held one), under the same three
bounds — so a mistake costs nothing. DELETE stays, for a holding recorded by mistake, and still takes
the samples.

**Everything live stops looking at a closed holding** — the sweep's batch, its daily sample and its
manage-by notice, `/positions/values`, the bot's `/holdings` — through one query, `openPositions`,
beside the listing that returns everything. Its last sample is the record of how it ended; a sweep
writing another would rewrite that with a market it was no longer in. The sweep reads the holdings
before its provider call and again after it, so a close that lands while the call is in flight gets
no sample and no notice either. A close may be BACKDATED, after the sweep has sampled days it was no
longer held: every reader of the history (`listPositionSamples`, which `/vol` reads) ignores samples
after `closed_on`, and none is deleted, since the day may yet be corrected.

**The rules that watched it are switched off when nothing open still holds what they name**, and
kept, with a new `disabled_reason`, `holding-closed`. A rule left on would go on alarming about
contracts nobody holds. One that spans two holdings (ADR 0004) goes off when EITHER closes, because its
figure would now include legs no longer held. A rule already off keeps its own reason, so the close
neither claims it nor hides why it was off. No Telegram notice: the owner did this, and the close's own
answer names the rules it took. They also lose their link to the holding, exactly as a DELETE leaves
them, so **no monitor is ever linked to a closed holding**: nothing alive can be valued against an
Entry that is history, and a rule re-enabled by hand watches a contract rather than a finished trade.
Linking and adoption look only at open holdings for the same reason.

The ORDER matters, and a review found it wrong in the first build: the close unlinks, lets adoption
hand each orphaned rule to whatever OPEN holding still holds its contracts, and only then decides
what to switch off. Decided first, a roll — a new spread sharing the old one's short strike, recorded
before the old one is closed — had its rule switched off and then adopted by the new holding: the new
trade's alarm, silent as "holding-closed", with no notice.

**What a closed holding made is reported in POINTS**, `realized_points`: Entry less Exit across the
contracts held, from a new domain function, `realizedPoints`, cased and ported like every other. It
is deliberately not P&L. P&L is money, and money needs a contract size, which this service takes
from a quote and never assumes — and a closed holding is no longer quoted.

## Consequences

- A condor may be recorded as one 4-leg holding or as two spreads; nothing here assumes either.
- The holdings name stays unique across open and closed, so a new holding cannot reuse a closed
  one's name. Names carry their expiry in practice (`1204_8100`), so this has not bitten.
- An expired holding that is never closed behaves as before: the sweep stops sampling it once its
  DTE goes negative, its monitors are muted and later removed by the expiry lifecycle, and the
  holding itself stays on the live list until it is closed or deleted. Nothing in that path deletes
  samples, so it was left alone.
- The dashboard's closed list carries both remedies: a correction in place, and a delete behind
  the same question a held holding's delete asks.
- The notebook API (`python/src/optionality/api.py`) keeps `positions()` to what is still HELD, as
  its docstring always promised, and adds `closed_positions()`, returning `ClosedPosition` rows that
  carry the close. A field on `Position` instead would have left every notebook that values
  `positions()` against live quotes pricing finished trades as though they were still on, and would
  have put service state on a type the golden cases hold to the TypeScript's.
