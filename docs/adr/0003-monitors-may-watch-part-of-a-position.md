# Monitors may watch part of a Position

ADR 0001 said a Monitor watches either a single Leg or the Position as a whole. That was
wrong, and the live watchlist shows why: `1016_bs_8050` is not a separate holding that happens
to share strikes with `1016_IC` — it is how the call wing of that condor is watched. A wing is
neither one leg nor all of them.

Splitting the condor into two Positions was considered and rejected. Entry belongs to the
holding: one credit was taken in for the condor, and apportioning it between wings needs a
number the trader may not have. Inventing it would make every per-wing P&L fiction.

So a Monitor gains a **scope** — `all`, `calls`, `puts`, or a single leg. For a condor, `calls`
and `puts` are exactly the wings. Scope is semantic rather than a list of leg indices: it reads
on screen ("1016_IC · calls"), survives leg reordering, and needs no subset language.

## Consequences

- One Position per holding, so Entry stays unambiguous.
- Positions are exposed over the JSON API, not on the dashboard. A Positions-first dashboard was
  built and rejected on review: the existing single-leg/combo tables read better for scanning
  during a session. Per ADR 0002 the API is where the model has to be expressive anyway, so the
  screen can follow later or not at all.
- Arbitrary subsets are not expressible. If a structure ever needs one, that is the point to
  revisit, not before.
