# Optionality

Watching SPX options positions during the US session and raising alarms when they move
against you. One trader, one account, one always-on machine.

## Language

**Position**:
An options structure you actually hold — its legs, how many contracts, and what you took in
or paid to open it. The thing a trader thinks in.
_Avoid_: holding, trade, structure

**Security**:
Anything a Provider can quote, named by a code. A Contract is one kind; an ETF, a stock and an
index are others. The code is the system's own for a Contract, built from the expiry, the type and
the strike — and GIVEN for everything else, because nothing here can spell `US.SPY` from facts of
its own. The parent exists because a Reference may be any of these: without it, admitting `US.SPY`
would have falsified Contract's claim that a code is built from those three facts, and widening
Contract was not available because Leg is defined on top of it.
_Avoid_: instrument, symbol, ticker, asset

**Contract**:
One tradeable option: an expiry, a type and a strike. It exists whether or not you hold it — a
Monitor can watch one you have never owned, and a Quote describes one. Its code — the string that
names it everywhere you look — is the system's own, built from those three facts; that a Provider
accepts the same spelling is a convenience and not the definition.
_Avoid_: instrument, option, leg (a Leg is a Contract you hold)

**Leg**:
A Contract you hold, inside a Position, together with the Side you are on. Legs belong to the
Position, never to a Monitor — the same Contract can be a Leg of yours and the subject of someone
else's Monitor, and those are different facts about it.
_Avoid_: option, contract (when the thing you mean is held rather than merely tradeable)

**Side**:
Whether you are long or short a Leg: long if you bought it, short if you sold it. A fact about
the Position, not a choice about how to add its legs up. It is never SHOWN as a +/- sign: where a
combo's legs are being described, each one is still named long or short, and the sign is only how
that is stored and summed. Greek exposure is never described with these words — it is always a
signed number — so "short" means a Leg and nothing else.
_Avoid_: direction (that word means above/below on a Monitor), sign, sold/bought (those are the
trades that open or close a Leg, not the Side it leaves you on)

**Cost to close**:
What it would cost right now to close the options in question — buy back the short ones, sell
the long ones — whether those are a Position's Legs or the Contracts a Monitor names, which are
not always the same set. Always positive for a credit structure, and reported only where you hold
those Contracts.
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
guide, never a rule: it says whether a trade is working, and no alarm is ever raised from it.
(It said "a REFERENCE, never a rule" until Reference became a term of its own — On-pace is not
one, and the sentence had started to read as a type claim.)
_Avoid_: expected value, fair value, theoretical price, target

**Holding**:
A Position, said the way the dashboard says it. The holdings list is the only screen that shows
one whether or not a rule watches it — every other figure on the dashboard hangs off a Monitor,
so a Position nothing watches used to appear nowhere at all. A trade that ends is CLOSED, which
keeps it (ADR 0022); deleting is for a holding recorded by mistake, and it takes the recorded
history with it: entry and Opened can be typed again, the daily samples cannot. The rules are
kept either way.
_Avoid_: trade, lot, leg (a Leg is part of one)

**Closed**:
A Position you no longer hold, kept with its legs, Entry, Opened and daily samples. Nothing live
looks at it — no sweep values or samples it, and the rules that watched it are switched off — but
it stays on record, which is what a review of past trades reads. Said of the day too: the New York
market day it was closed.
_Avoid_: deleted, removed, archived, expired (that word means the contract's own date)

**Exit**:
The Cost to close you actually got when you closed a Position, per contract, in points — Entry's
counterpart, and like it left blank rather than guessed when unknown. Signed like Cost to close:
positive when closing cost you (a credit structure bought back), negative when it paid you (a long
sold). Entry less Exit across the contracts held is what a closed Position made, said in POINTS: P&L
is money, and money needs a contract size that only a Quote carries, while a closed Position is no
longer quoted.
_Avoid_: exit price, closing price, debit, sale price (a sale is a NEGATIVE Exit)

**Daily sample**:
One observation of a held Position per New York calendar day: its DTE, Cost to close, and each
leg's IV, vega and delta. It is the day's CLOSE — taken only from 09:30 to 16:00 in New York, so
the last sweep at or before 16:00 is the one that stays and an overnight mark never replaces it —
and it is taken on every calendar day, a weekend or a holiday carrying the last close forward,
because the Vol part chains days exactly one apart. Recorded, never derived: none of it can be
read again once its day has passed.
_Avoid_: snapshot (moomoo's word for a quote), tick, mark

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

**Provider**:
Where Quotes come from: one market-data source the service is configured to use, settled before it
starts and never mixed with another. Its whole job is to answer one question — the live figures for
these Contracts, and the ones it could not price. Which figures it can supply is a fact about the
ACCOUNT it speaks for rather than about the Provider: two accounts reaching the same Provider may
differ on whether greeks arrive at all. It never trades, which is why it is not a broker here even
when the company behind it is one.
_Avoid_: broker, vendor, feed, API, data source, integration

**Reference**:
A Security kept on the page to read the market by. It never alarms, it need not be held, and
nothing is derived from it — no Monitor reads one, no Sweep fetches one, and a Position cannot be
made of one. Where the Security the figure is wanted FOR cannot be quoted, a Reference stands in
for it and shows the arithmetic: SPX is read through SPY ×10, labelled `SPX (via SPY ×10)`, and
never printed as the index itself — SPY×10 has tracking error, it has dividends, and the two trade
different sessions. A figure that did not arrive is a dash, which is why Quarantine does not reach
here: that is a Monitor the service disabled because it cannot be EVALUATED, and a Reference
evaluates nothing.
_Avoid_: watchlist (that is the Monitors), index, underlying, benchmark, ticker

**Quarantine**:
A Monitor the service has disabled itself because it cannot be evaluated — its Contract is unknown
to the Provider, or the figure it watches never arrives. Always with a notice, and never deleted:
the rule is still what you meant, and the reason is a fact about the data rather than about the
rule. A Monitor you mute is a different thing, because you chose it.
_Avoid_: disable, mute, remove, expire, pause

**Sweep**:
One pass of the alarm engine: fetch quotes for every enabled Monitor, evaluate each threshold,
send what changed.
_Avoid_: poll, scan, refresh

**Alarm**:
The state of a Monitor whose threshold is currently breached, and the Telegram message sent
when that state changes.
_Avoid_: alert, warning, trigger
