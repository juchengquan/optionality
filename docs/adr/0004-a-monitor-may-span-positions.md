# A Monitor may span several Positions

ADR 0003 kept an iron condor as one Position and gave Monitors a `calls`/`puts` scope so a wing
could be watched. That rested on an assumption — that one credit was taken in for the condor,
so a wing had no entry of its own. The monitors' own timestamps disprove it for 1016_IC: the
call spread was opened on 1 September and the put side on 9 September. Two trades, two fills,
two credits.

So a wing that was entered as its own trade is its own Position, with its own Entry and its own
P&L. What was called an iron condor is an emergent combination of two credit spreads, not an
atomic holding.

That leaves the combined stop — the rule watching what it costs to close the whole thing — with
nothing to attach to, since it belongs to neither Position alone. A Monitor therefore links to
**one or more** Positions, and its value is the sum across them. `Monitor.position_id` is
replaced by a `monitor_positions` association.

## Consequences

- Entry is editable only where a Monitor links to exactly one Position. For a spanning Monitor,
  entry and P&L are the sums of its Positions' and are read-only — a summed credit is not
  something you can type.
- `scope` survives for the case ADR 0003 was really about: a condor opened as a single order,
  where the wings genuinely share one credit.
- Splitting a Position is a data migration, not a UI action. There is no "split" button, and
  combining two Positions back is likewise not modelled.
