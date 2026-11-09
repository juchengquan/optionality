-- Exit schedules (ADR 0011).
--
-- `opened_at` is the day the Position was PUT ON, which nothing recorded: `created_at` is the day
-- it was told to the app. Null for every row that already exists, because created_at is right for
-- two of the five and wrong for the rest, and a guess here puts a wrong number under every figure
-- the feature displays.
ALTER TABLE positions ADD COLUMN opened_at VARCHAR(10);

-- Sent-once marker for the manage-by notice. The sweep runs every 60 seconds.
ALTER TABLE positions ADD COLUMN manage_notified_at DATETIME;

-- One observation per Position per market day, so the √T decay shape can be checked against this
-- book rather than defended on arithmetic. The shape has one confirming observation at the time of
-- writing; this table is how it becomes falsifiable.
--
-- The day is the MARKET day, matching `dte` beside it and the dashboard's column — deliberately
-- not the sweep's UTC expiry day, which differs for the hours New York is behind UTC.
CREATE TABLE position_samples (
	position_id VARCHAR(32) NOT NULL,
	observed_on VARCHAR(10) NOT NULL,
	dte INTEGER NOT NULL,
	cost_to_close FLOAT NOT NULL,
	PRIMARY KEY (position_id, observed_on),
	FOREIGN KEY(position_id) REFERENCES positions (id)
);
