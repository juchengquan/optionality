-- A day's sample may have no Cost to close (#380), and keeps its vol readings regardless.
--
-- Out of hours moomoo quotes every option bid 0 / ask 0. That was read as a mid of 0, so the
-- sweep valued every holding at 0.00 and a day's row filled out of hours — a weekend's, or the
-- Opened day of a trade recorded in New York's evening — could store a Cost to close of 0. A quote
-- with no ask above zero is now no price at all (`domain/quote.ts` `midPrice`), so such a sweep
-- has no cost to store. It still reads each leg's IV, vega and delta, and the vol chain needs a row
-- for every calendar day from Opened (ADR 0011), so the row is written with the cost left EMPTY
-- rather than skipped or invented: no figure is stored that nobody observed. An empty cost never
-- replaces a stored one (`takesSample`), so a day's close is never blanked by a later sweep.
--
-- Recreated rather than ALTERed: SQLite cannot drop a NOT NULL. Every column keeps its name, type
-- and order — the order the migrations appended them in, which is schema.sql's too — and every
-- row is copied as it stands. Nothing references this table, so dropping it disturbs no key.
CREATE TABLE position_samples_next (
	position_id VARCHAR(32) NOT NULL,
	observed_on VARCHAR(10) NOT NULL,
	dte INTEGER NOT NULL,
	cost_to_close FLOAT,
	legs_iv TEXT,
	legs_vega TEXT,
	legs_delta TEXT,
	observed_at DATETIME,
	spx FLOAT,
	PRIMARY KEY (position_id, observed_on),
	FOREIGN KEY(position_id) REFERENCES positions (id)
);

INSERT INTO position_samples_next
	(position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega, legs_delta, observed_at, spx)
SELECT position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega, legs_delta, observed_at, spx
FROM position_samples;

DROP TABLE position_samples;

ALTER TABLE position_samples_next RENAME TO position_samples;
