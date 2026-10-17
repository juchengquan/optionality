# Optionality

Watching SPX options positions during the US session and raising alarms when they move
against you. One trader, one account, one always-on machine.

## Language

**Position**:
An options structure you actually hold — its legs, how many contracts, and what you took in
or paid to open it. The thing a trader thinks in.
_Avoid_: holding, trade, structure

**Contract**:
One tradeable option: an expiry, a type and a strike. It exists whether or not you hold it — a
Monitor can watch one you have never owned, and a Quote describes one.
_Avoid_: instrument, option, leg (a Leg is a Contract you hold)

**Leg**:
A Contract you hold, inside a Position, together with the Side you are on. Legs belong to the
Position, never to a Monitor — the same Contract can be a Leg of yours and the subject of someone
else's Monitor, and those are different facts about it.
_Avoid_: option, contract (when the thing you mean is held rather than merely tradeable)

**Side**:
Whether a Leg was sold or bought. A fact about the Position, not a choice about how to add its
legs up. It is never SHOWN as a +/- sign: where a combo's legs are being described, each one is
still named sold or bought, and the sign is only how that is stored and summed.
_Avoid_: direction (that word means above/below on a Monitor), sign, long/short

**Cost to close**:
What it would cost right now to buy back the options in question — a Position's Legs, or the
Contracts a Monitor names, which are not always the same set. Always positive for a credit
structure, and reported only where you hold those Contracts.
_Avoid_: combo value, signed sum, mid

**Entry**:
What you took in when you opened the Position, per contract. Quoted in points, like every other
price in the system.
_Avoid_: entry_price, premium, credit

**P&L**:
Entry minus Cost to close, across the contracts held. The one figure expressed in money rather
than points, because it is the one you act on.
_Avoid_: profit, return, pnl

**DTE**:
Days from today until a Position's or Leg's expiry. Always this abbreviation — the trader's unit
for how much time a structure has left.
_Avoid_: days to expiry, time to expiry, tenor

**Opened**:
The day you put a Position on. A different fact from the day you recorded it here, and the one
the decay maths needs — a Position entered at 45 DTE and told to the app a fortnight later has
an Opened of the earlier day.
_Avoid_: created, added, entry date (that last one invites confusion with Entry, which is a price)

**On-pace**:
What a Position's Cost to close would be at a given DTE if nothing but time had passed. A
REFERENCE, never a rule: it says whether a trade is working, and no alarm is ever raised from it.
_Avoid_: expected value, fair value, theoretical price, target

**Holding**:
A Position, said the way the dashboard says it. The holdings list is the only screen that shows
one whether or not a rule watches it — every other figure on the dashboard hangs off a Monitor,
so a Position nothing watches used to appear nowhere at all. Deleting one is the only deliberate
removal of a holding there is, and it takes the holding's recorded history with it: entry and
Opened can be typed again, the daily samples cannot. The rules are kept.
_Avoid_: trade, lot, leg (a Leg is part of one)

**Pace gap**:
How far a Position's Cost to close sits from its On-pace figure. BEHIND means costing more to buy
back than time alone accounts for. Said in words wherever it is shown, because "behind" is bad
while a positive P&L is good and a bare sign beside one invites reading the other.
_Avoid_: pace error, drift, slippage, variance

**Vol part**:
How much of a Pace gap the movement in the legs' own implied volatilities accounts for, measured
day by day from the day it was Opened. Each leg counts under its own IV and its own sensitivity;
there is no volatility figure for a structure, and an average of its legs' can point the wrong way.
_Avoid_: vol adjustment (it adjusts nothing — On-pace is never moved by it), IV of the position

**The rest**:
A Pace gap less its Vol part. Named and left unattributed on purpose: spot, skew and the decay
shape's own approximation are all in it, and it is usually the larger half. Calling it noise would
claim knowledge of it.
_Avoid_: residual, unexplained, error, noise

**Level**:
A Cost to close you have already decided to act at. There are two: a Target you take the profit at,
and a Stop where the trade is over. Both are flat in DTE. A Level is reached or it is not, and
reaching one sends nothing — which is what separates it from an Alarm.
_Avoid_: trigger, signal, threshold (that word belongs to a Monitor)

**Target**:
The Cost to close at which you take the profit, as a fraction of Entry. Flat in DTE — time does
not change what you are willing to accept, only whether you have got it yet.
_Avoid_: take profit, TP, goal

**Stop**:
The Cost to close at which the trade is over, as a multiple of Entry. Also flat in DTE.
_Avoid_: stop loss, SL, max loss

**Manage-by**:
The DTE at which a Position is dealt with whatever its P&L, because the risk of holding stops
being paid for. A deadline, not a level.
_Avoid_: roll date, close date, expiry (that word means the contract's own date)

**Monitor**:
A rule that watches one value and raises an alarm when it crosses a threshold. It watches a
Contract, or a signed set of Contracts — never a Position. It is created from an expiry, a type
and a strike, and holds no Legs of its own.

Where its Contracts turn out to be ones you hold, the Position is found AFTERWARDS so the row can
show what you took in. That link is discovered, not declared, and it does not make the Monitor a
rule about your holding: a delta alarm on one Contract is about that option, and the condor it
happens to sit inside is a separate fact.
_Avoid_: watch, rule, alert, combo monitor, "a monitor on my condor" (say which Contracts)

**Quote**:
Live market data for a contract. Always this word — moomoo's "snapshot" jargon stays out of
the domain.
_Avoid_: snapshot, tick, price data

**Sweep**:
One pass of the alarm engine: fetch quotes for every enabled Monitor, evaluate each threshold,
send what changed.
_Avoid_: poll, scan, refresh

**Alarm**:
The state of a Monitor whose threshold is currently breached, and the Telegram message sent
when that state changes.
_Avoid_: alert, warning, trigger
