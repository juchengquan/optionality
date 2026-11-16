-- No price read outside a regular session is a day's price (#416).
--
-- SPX options trade overnight, in Cboe's Global Trading Hours (20:15 to 09:25 New York; Sunday 20:15
-- starts Monday's trade date), and in the Curb (16:15 to 17:00), and moomoo quotes them live then.
-- Nothing in the sweep looked at the time, so a day's row took those quotes for its price: on
-- 2026-11-15 Sunday's holding row got a Cost to close of 3.40 from the first GTH sweep at Sunday
-- 20:15:07, Monday's was filled at 00:00 from a GTH mark, and every watched set of contracts' day
-- the same. Such a price is no close — thin, and taken while the index is not even computed — but
-- the readers took it for one: the pace split measured from it, and a watched rule's value cell
-- named it as its last close.
--
-- The sweep now stores a regular session's price only (`sampledPrice`, `domain/expiry.ts`), and
-- every reader reads a regular session's price only (`takenInSession`). This clears the prices
-- already stored from outside one: a holding's `cost_to_close`, and a watched day's `legs_mid`,
-- wherever the row was observed outside a weekday's 09:30:00.000 to 16:15:00.000 New York. The row
-- itself stays, with its IV, vega, delta, SPX and contract size: the vol chain needs the day, and
-- nothing but the price was wrong. A row with no stamp, or one not in the stored spelling (the GLOB:
-- SQLite would read a "T" and a "Z" the domain refuses), is left as it is: nothing says when it was
-- observed, and no reader takes its price for a close anyway.
--
-- New York's clock in SQL, which has no zones: UTC-4 from the second Sunday of March at 07:00 UTC
-- (02:00 EST) to the first Sunday of November at 06:00 UTC (02:00 EDT), UTC-5 otherwise — the
-- United States' rule since 2007, and so for every row this service has stored. `%f` keeps the
-- milliseconds, so 16:15:00.001 is out as the domain has it. Weekday 1 to 5 is Monday to Friday.
-- `migrate.test.ts` holds this classification to the domain's `takenInSession` instant by instant,
-- across both changes of the clocks and every edge, and `test_migrate.py` holds it again.
UPDATE position_samples SET cost_to_close = NULL
WHERE rowid IN (
	SELECT rowid FROM (
		SELECT rowid, strftime('%Y-%m-%d %H:%M:%f', observed_at,
			CASE
				WHEN observed_at >= datetime(strftime('%Y', observed_at) || '-03-08', 'weekday 0', '+7 hours')
					AND observed_at < datetime(strftime('%Y', observed_at) || '-11-01', 'weekday 0', '+6 hours')
				THEN '-4 hours' ELSE '-5 hours'
			END) AS ny
		FROM position_samples
		WHERE cost_to_close IS NOT NULL
			AND observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
	)
	WHERE ny IS NOT NULL
		AND NOT (strftime('%w', ny) BETWEEN '1' AND '5' AND substr(ny, 12) BETWEEN '09:30:00.000' AND '16:15:00.000')
);

UPDATE watch_samples SET legs_mid = NULL
WHERE rowid IN (
	SELECT rowid FROM (
		SELECT rowid, strftime('%Y-%m-%d %H:%M:%f', observed_at,
			CASE
				WHEN observed_at >= datetime(strftime('%Y', observed_at) || '-03-08', 'weekday 0', '+7 hours')
					AND observed_at < datetime(strftime('%Y', observed_at) || '-11-01', 'weekday 0', '+6 hours')
				THEN '-4 hours' ELSE '-5 hours'
			END) AS ny
		FROM watch_samples
		WHERE legs_mid IS NOT NULL
			AND observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
	)
	WHERE ny IS NOT NULL
		AND NOT (strftime('%w', ny) BETWEEN '1' AND '5' AND substr(ny, 12) BETWEEN '09:30:00.000' AND '16:15:00.000')
);
