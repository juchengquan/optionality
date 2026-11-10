-- A holding can be CLOSED, and is kept when it is (ADR 0022).
--
-- Until now the only way a holding left the dashboard was DELETE, which takes its daily samples
-- with it: the two holdings of the 2026-11-03 backup carried 29 samples between them, and none of
-- them survives. A closed trade is exactly what a review of past trades needs, so closing becomes a
-- state of the row rather than the removal of it.
--
-- `closed_on` is a New York MARKET date, like `opened_at` beside it, and for the same reason: it is
-- a calendar day in the market's own reckoning, with no time to convert. Null means still held.
--
-- `exit` is what was paid to close it, per contract, in points — the counterpart of `entry`, and
-- nullable for the same reason `entry` is: the owner may not know it, and an unknown figure is
-- left blank rather than invented. A holding is closed whether or not it has one.
--
-- Both are nullable with no default, so ADD COLUMN suffices and every holding already in the table
-- reads as open, which is what each of them is.
ALTER TABLE positions ADD COLUMN closed_on VARCHAR(10);

ALTER TABLE positions ADD COLUMN exit FLOAT;
