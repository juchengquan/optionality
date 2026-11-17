-- The sweep's interval, set from the dashboard's Settings (#442, ADR 0025).
--
-- The ONE behaviour knob kept in the database. Every other knob lives in `.env` (CLAUDE.md), and
-- this one still does too: `MONITOR_INTERVAL_SECONDS` is the default, in force whenever this table
-- has no row. A row is the owner's choice from the page, applied at the next sweep with no restart,
-- and deleting it ("default" on the page) goes back to `.env`.
--
-- A TABLE OF ITS OWN, one row at most (`id` is 1 or nothing), rather than a key/value table of
-- settings: a second knob here is a migration and an ADR, never a row someone adds.
--
-- `seconds` is NOT checked against the presets (5, 10, 15, 30, 60) here, on purpose: the route
-- refuses anything else, and a value that got in by hand is refused when it is READ — the service
-- says so in its log and sweeps at `.env`'s interval — rather than failing a migration or a boot.
CREATE TABLE sweep_interval (
	id INTEGER NOT NULL CHECK (id = 1),
	seconds INTEGER NOT NULL,
	set_at DATETIME NOT NULL,
	PRIMARY KEY (id)
);
