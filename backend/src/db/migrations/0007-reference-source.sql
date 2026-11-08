-- A Reference names the vendor its figure comes from, and the scale goes (ADR 0019).
--
-- `scale` existed for one case: SPY×10 standing in for SPX, because moomoo refuses every index as
-- a class — asked for `US..VIX` it answers `US stock indices are not supported`, naming no code.
-- On 2026-11-08 the index turned out to be obtainable after all (IBKR serves SPX and the whole VIX
-- term structure; Yahoo serves the levels free), and the proxy's error was measured for the first
-- time: SPY at 735.29 against an SPX of 7376.86, so the strip read 7352.90 — twenty-four points
-- low. A scaled stand-in is a simulation rather than a reading, so it goes, and with it the only
-- column that needed it.
--
-- `source` is the vendor outright — `moomoo`, `ibkr`, `yahoo` — and never "the Provider". A row
-- meaning "wherever the service is pointed" would silently change which company's figure it shows
-- the day OPTIONALITY_PROVIDER changes, under the same unchanged label. NOT NULL, because a
-- Reference whose source is unknown cannot be fetched at all.
--
-- `label` is KEPT, and matters more than before: `^GSPC`, `US..SPX` and `SPX` are three vendors'
-- names for one index, and none of them is what the owner calls it.
--
-- Recreated rather than ALTERed. SQLite can DROP COLUMN, but ADD COLUMN ... NOT NULL requires a
-- DEFAULT, and a default on `source` would let a careless insert silently claim moomoo —
-- `migrate.test.ts` compares dflt_value between the two roads, so a default here would have to be
-- mirrored in schema.sql for ever. Copying is also correct where DROP+ADD is not: the live table
-- holds no rows today, but a restored backup might, and those rows came from the Provider, which
-- was moomoo.
CREATE TABLE reference_securities_next (
	id VARCHAR(32) NOT NULL,
	code VARCHAR(50) NOT NULL,
	label VARCHAR(50),
	source VARCHAR(16) NOT NULL,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_reference_code UNIQUE (code)
);

INSERT INTO reference_securities_next (id, code, label, source, created_at)
SELECT id, code, label, 'moomoo', created_at FROM reference_securities;

DROP TABLE reference_securities;

ALTER TABLE reference_securities_next RENAME TO reference_securities;
