-- References: the Securities kept on the page to read the market by (ADR 0018).
--
-- In the database and not in `.env` because they are a list that grows, which is data rather than a
-- behaviour knob — CLAUDE.md's "No DB config layer" is about configuration, and this is a table of
-- subjects like monitors and positions.
--
-- NOT named `references`: REFERENCES is a SQLite keyword, so that spelling is a syntax error
-- unquoted and a quote-it-or-it-breaks trap in every hand-written statement afterwards. The name
-- says both terms ADR 0018 adds to the glossary — a Reference IS a Security.
--
-- `scale` is nullable and null means ×1: SPY quotes at 758.73 against strikes of 6950, so the
-- strip shows `SPX (via SPY ×10) → 7587` rather than charging a mental ×10 at every glance. Most
-- References need no scale at all, and a stored 1 would invite the strip to print "×1".
--
-- `label` is nullable on the same rule, meaning "the code is its own name". `US.QQQ` needs no
-- label; SPY-standing-in-for-SPX does, and the label is the only place that says SPX at all,
-- because SPY×10 is not SPX — there is tracking error, there are dividends, and the two trade
-- different sessions.
--
-- One row per code: two References on the same Security would be two figures that cannot differ.
CREATE TABLE reference_securities (
	id VARCHAR(32) NOT NULL,
	code VARCHAR(50) NOT NULL,
	label VARCHAR(50),
	scale FLOAT,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_reference_code UNIQUE (code)
);
