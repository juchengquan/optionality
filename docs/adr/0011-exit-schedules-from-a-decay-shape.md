# 11. Exit schedules come from a decay shape, not a pricing model

Date: 2026-10-12

## Status

Accepted. Decided with the owner on 2026-10-12.

## Context

SPX structures go on at 45–60 DTE and the question is what Cost to close justifies getting out
at each DTE on the way. Three ways to answer it, and the repo rules two of them out:

- **A pricing model.** Black–Scholes on each Leg, re-priced at a future DTE. There is no pricing
  model anywhere in the codebase; moomoo supplies per-Leg IV and greeks and nothing else.
- **The position's own history.** `monitors.last_value` is a single float the sweep overwrites.
  No series is stored, so nothing can be fitted — not today and not retroactively.
- **Today's theta, projected.** Available immediately and wrong in the way that matters. The
  owner's condor shows +0.188/day at 39 DTE; straight-lining that to 21 DTE promises 3.12 when
  the structure will not be there, because theta accelerates. A stop built on it is a stop in
  the wrong place.

## Decision

An **On-pace** line from a decay SHAPE rather than a price: an option's extrinsic value scales
as the square root of time, so the fraction of Entry still outstanding at `d` DTE for a Position
Opened at `D₀` DTE is `√(d/D₀)`. No IV input, no spot input, no parameters.

Around it:

- **Target and Stop are flat in DTE** — fractions of Entry. Time changes whether you have the
  profit, not what you will accept for it. The DTE curve is the reference beside them.
- **On-pace never raises an alarm.** Being behind pace fires on every IV spike and says nothing
  about risk. It is there to tell you whether a trade is working.
- **Manage-by raises exactly one notice**, when a Position reaches that DTE — the same shape as
  the expiry notice the sweep already sends. Monitor thresholds are untouched and a Monitor is
  still a rule with one stored threshold.
- **`positions.opened_at` holds the fact**; Target, Stop and Manage-by are `.env` knobs beside
  `EXPIRED_RETENTION_DAYS`, because a schedule applied to every trade is a policy and CLAUDE.md
  ratifies no DB config layer.
- **A daily sample per Position** records `(dte, cost_to_close)`, because the shape has been
  checked against exactly one observation.

## Consequences

**The claim is falsifiable, and that is the point.** √T predicted 6.39 for the 1120 condor at 39
DTE against an actual 6.50 — behind pace by 0.11 points, 1.6% of the credit, after six days. That
is one data point. The samples table exists so that in a month the exponent can be fitted and this
decision reversed on evidence rather than defended on arithmetic. A reference line nobody can check
is how a wrong number survives.

**The shape is calibrated on at-the-money extrinsic** and a condor's shorts sit nearer 0.12 delta,
where the relationship is only approximately √T. It also assumes IV holds still: a crush hands you
the profit early and a spike puts you behind through no fault of the Position.

**It says nothing about spot**, which is what actually kills a condor. On-pace is a statement about
time alone, and a Position can be exactly on pace while sitting under a short strike about to be
breached. The Monitors are what watch that, and they continue to.

**The two schemas have diverged, for the first time since the cutover.** `schema.sql` was
byte-compatible with SQLAlchemy's `create_all`, which is what made `make copy-db` and the rollback
honest. `position_samples`, `schema_migrations` and the two new `positions` columns exist only on
the TypeScript side. The rollback already lost everything entered since the cutover; it now loses
the exit schedules too. Keeping parity would have meant writing alembic revisions for a service
that is not loaded, whose database is frozen, and which phase 10 deletes in three weeks.

**The TypeScript side gained a migration mechanism**, because it had none — `applySchema` is safe
only on an empty database, so until this change the live file could not be altered at all. Plain
`.sql` files in `backend/src/db/migrations/`, applied in name order, each in a transaction, with
`schema_migrations` recording what ran; `main.ts` applies what is pending at boot and fails fatally
if one does not. This outlives the feature: it is what phase 10 leaves behind when alembic goes.

**Opened cannot be backfilled.** `created_at` is when a Position was recorded: right for the two
1120 Positions (45 and 57 DTE) and wrong for the 1016s, recorded at 22 DTE. Existing rows get a
null Opened and no schedule until it is filled in by hand, because guessing it would put a wrong
number under every figure the feature displays.

**The vol assumption is now recorded, not just admitted.** The paragraph above says the shape
assumes IV holds still; `position_samples` therefore also carries `legs_iv` and `legs_vega`, a JSON
map each, so the assumption can be measured before anything is built on top of it. Per LEG, not per
structure: "IV is never summed" is ratified, and the live condor runs 10.5% on its calls against
21-22% on its puts, so a single σ for it would be a fiction. The vegas are the weight those IVs
have to be combined with — points of value per point of IV — which is the only principled way four
numbers become the one an adjustment multiplies by.

**A sample's vol can never be reconstructed after its day.** IV and vega are both only knowable at
the instant they were observed, so a row written without them is permanently unweightable, and that
is why both columns landed before the adjustment rather than with it. The cost is small (~135 bytes
a map, taking a row from ~65 to ~335; ~250KB a year for three Positions) and the alternative is not
cheaper later, it is impossible later.

**The adjustment cannot be computed for the Position that motivated it.** It is a ratio — today's
vol against the vol at Opened — and recording began 2026-10-12, six days after the 1120 condor was
opened at 45 DTE. Its first sample is at 39 DTE. Treating that as the baseline would be six days
and 6 DTE of drift hidden inside every figure derived from it, so the adjustment must be gated on
having a sample at or near a Position's Opened, which means it appears on the next trade and not on
this one. The same rule as Opened above: a missing fact shows as absent, never as a guess.

## Considered and rejected

**Pace as the rule** — close whenever Cost to close sits above the On-pace line. One idea instead
of three, and it would make the alarm fire on falling behind rather than on a level. Rejected: it
converts a reference with one confirming observation into the thing that closes trades.

**A Target that tightens with DTE** — 50% far out, 35% at 21 DTE, 25% at 14. Plausible and
unfounded; the numbers would be a preference with nothing behind them, and the On-pace line already
gives a principled DTE curve for anyone who wants to read the level off it.

**Thresholds that follow the curve** — a Monitor's threshold as a function of DTE, so alarms
tighten by themselves. Powerful and invasive: it changes what a Monitor is, moves the dashboard's
bell with no edit to any rule, and leaves "what is my alarm set to" without a single answer. If it
is ever wanted it deserves its own decision.
