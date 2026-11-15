-- A watched set of contracts' day: what the watchlist is worth at each close (#402, ADR 0011).
--
-- Only holdings had daily samples (`position_samples`), so a spread watched as a candidate had no
-- history: its value went blank out of hours, and its payoff with it. The sweep now records the
-- contracts every enabled rule watches, at the close, under exactly the holdings' rules
-- (`takesSample`), from its own batch and never from a call of its own.
--
-- KEYED BY THE CONTRACTS, not by a rule: `contracts` is the set of contract codes, sorted and
-- joined by commas, without signs or quantities. So a history survives its rule being edited, or
-- replaced by `POST /spreads` when the spread is recorded as held, or deleted; two rules on the same
-- contracts share one; and a holding with the same contracts finds it again, read-time, as the days
-- "before entry" (owner's decision, 2026-11-15). No foreign key for the same reason, and nothing
-- deletes a row: like a holding's samples, it cannot be re-entered.
--
-- A rule's value and a holding's Cost to close are worked out when READ, from `legs_mid` (each
-- contract's mid, all or nothing): under the rule's own signs for the one, by side for the other,
-- so no sign convention is stored. `legs_mid` is null where a contract had no two-sided quote —
-- the row then keeps its vol readings with no price, as a holding's does (#380).
--
-- `observed_at` is NOT NULL: unlike `position_samples`, no row of this table predates the stamp.
CREATE TABLE watch_samples (
	contracts VARCHAR(400) NOT NULL,
	observed_on VARCHAR(10) NOT NULL,
	dte INTEGER NOT NULL,
	legs_mid TEXT,
	legs_iv TEXT,
	legs_vega TEXT,
	legs_delta TEXT,
	observed_at DATETIME NOT NULL,
	spx FLOAT,
	contract_size FLOAT,
	PRIMARY KEY (contracts, observed_on)
);
