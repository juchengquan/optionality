-- The schema, declared fresh rather than migrated (ADR 0009).
--
-- Written to be byte-compatible with what SQLAlchemy's create_all produced from the Python's
-- models.py, so that the Python could open this file as a rollback: the same type spellings, the
-- same nullability, the same index and constraint names. SQLite only has five storage classes,
-- so VARCHAR(32), DATETIME and BOOLEAN are affinities rather than checks. The rollback went in
-- phase 10 (ADR 0014), along with the run pipeline's four tables and alembic's bookkeeping.
--
-- Column order follows models.py, not the live file: the live monitors table carries its columns
-- in the order migrations appended them. Verification is therefore by column NAME.

CREATE TABLE monitors (
	id VARCHAR(32) NOT NULL,
	code VARCHAR(50) NOT NULL,
	strike_date VARCHAR(10) NOT NULL,
	option_type VARCHAR(4) NOT NULL,
	strike FLOAT NOT NULL,
	field VARCHAR(50) NOT NULL,
	threshold FLOAT NOT NULL,
	direction VARCHAR(5) DEFAULT 'above' NOT NULL,
	compare VARCHAR(6) DEFAULT 'abs' NOT NULL,
	legs JSON,
	scope VARCHAR(10),
	enabled BOOLEAN NOT NULL,
	disabled_reason VARCHAR(20),
	triggered BOOLEAN NOT NULL,
	last_value FLOAT,
	last_checked_at DATETIME,
	last_alarm_at DATETIME,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_monitor_code_field UNIQUE (code, field)
);
CREATE INDEX ix_monitors_code ON monitors (code);

CREATE TABLE positions (
	id VARCHAR(32) NOT NULL,
	name VARCHAR(100) NOT NULL,
	strategy VARCHAR(50),
	strike_date VARCHAR(10) NOT NULL,
	contracts INTEGER NOT NULL,
	entry FLOAT,
	legs JSON NOT NULL,
	created_at DATETIME NOT NULL,
	opened_at VARCHAR(10),
	manage_notified_at DATETIME,
	closed_on VARCHAR(10),
	exit FLOAT,
	PRIMARY KEY (id)
);
CREATE UNIQUE INDEX ix_positions_name ON positions (name);

-- a Monitor links to one or more Positions; a plain table rather than a relationship, to match
-- the query style used everywhere else. SQLAlchemy does not manage it, which is how three
-- lifecycle bugs got in (#70-#72) — every delete path must clear it first, and foreign_keys=ON
-- is what turns forgetting into an error rather than an orphan.
CREATE TABLE monitor_positions (
	monitor_id VARCHAR(32) NOT NULL,
	position_id VARCHAR(32) NOT NULL,
	PRIMARY KEY (monitor_id, position_id),
	FOREIGN KEY(monitor_id) REFERENCES monitors (id),
	FOREIGN KEY(position_id) REFERENCES positions (id)
);

CREATE TABLE position_samples (
	position_id VARCHAR(32) NOT NULL,
	observed_on VARCHAR(10) NOT NULL,
	dte INTEGER NOT NULL,
	cost_to_close FLOAT NOT NULL,
	legs_iv TEXT,
	legs_vega TEXT,
	legs_delta TEXT,
	observed_at DATETIME,
	PRIMARY KEY (position_id, observed_on),
	FOREIGN KEY(position_id) REFERENCES positions (id)
);

-- The Securities kept on the page to read the market by (ADR 0018). Migration 0006 creates this
-- same shape; see its header for why `scale` and `label` are nullable, and why the table is not
-- called `references` (REFERENCES is a SQLite keyword).
CREATE TABLE reference_securities (
	id VARCHAR(32) NOT NULL,
	code VARCHAR(50) NOT NULL,
	label VARCHAR(50),
	source VARCHAR(16) NOT NULL,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_reference_code UNIQUE (code)
);
