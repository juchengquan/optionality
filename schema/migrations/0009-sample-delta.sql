-- Per-leg delta on each sample, beside the IV and the vega, and the instant each row was observed
-- (ADR 0011, amended).
--
-- legs_delta. Short-leg delta is the risk this book is managed by, and the redesigned dashboard's
-- review of a trade wants it charted over the trade's life. Like a vega, a delta is only knowable
-- at the moment it was observed: it moves with spot and with time, and no later sweep can say what
-- it was on a day that has passed. So it is recorded from the first day it can be, rather than when
-- a chart first asks for it — every row written before this column exists is permanently without
-- one. The same shape and the same rules as legs_iv and legs_vega: JSON text, contract code ->
-- delta, null rather than a partial map, and gated on its own, so a withheld delta never costs the
-- IV or the vega reading beside it.
--
-- observed_at. The day's row is its close — the last sweep at or before 16:15 in New York — except
-- where a day had no close to take: a trade recorded in New York's evening, a session missed whole
-- (a reboot waiting for the FileVault login, OpenD waiting for one). Those days are filled after
-- hours rather than left as holes, because the vol chain needs every day, and so some rows are not
-- closes. This is the sweep's own instant, in UTC like every other stored time, written on every
-- write, so a chart can tell a close from an off-close point rather than draw them alike.
--
-- Both nullable with no default, so ADD COLUMN suffices and every existing row reads as having
-- neither — which is the truth: nothing recorded either when they were written.
ALTER TABLE position_samples ADD COLUMN legs_delta TEXT;

ALTER TABLE position_samples ADD COLUMN observed_at DATETIME;
