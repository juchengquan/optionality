# Positions own legs; Monitors only warn

A multi-leg Monitor used to carry its own legs and a +/- sign per leg chosen by the trader, so
the structure you hold was recorded by the thing that alarms about it — delete the alarm and you
delete the record of the position. Legs now belong to a Position, which also carries the strategy,
how many contracts, and the Entry. A Monitor watches either one Leg or the Position as a whole and
holds no legs itself.

A Leg records its Side — sold or bought — rather than a sign the trader picks. Side is a fact about
the position; a sign was a choice about how to add the legs up, and that choice made the aggregate
ambiguous. With Side recorded, a Position's value has exactly one meaning (Cost to close, always
positive for a credit structure), which is what makes P&L computable at all.

## Consequences

- The free-sign "net-delta tilt watch" described in the README is no longer expressible. A
  Position-wide delta Monitor replaces it, summing legs under their recorded Sides.
- `compare: abs` becomes unnecessary on Position-value Monitors, since Cost to close cannot be
  negative. It still matters for delta, where negative values are real.
- The README's sign guidance ("+ on legs you sold") contradicted every combo actually in the
  database, which used the opposite convention. `compare: abs` had been hiding the discrepancy.
  Recording Side makes the contradiction unwriteable.
