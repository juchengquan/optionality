-- The schema, declared fresh rather than migrated (ADR 0009).
--
-- Deliberately byte-compatible with what SQLAlchemy's create_all produces from
-- src/optionality/service/models.py: the same type spellings, the same nullability, the same
-- index and constraint names. SQLite only has five storage classes, so VARCHAR(32), DATETIME and
-- BOOLEAN are all affinities rather than checks — they are kept because they cost nothing and
-- because the Python must be able to open this file. That rollback path is the only safety net a
-- cutover with no side-by-side run has.
--
-- Column order follows models.py, not the live file: the live monitors table carries its columns
-- in the order migrations appended them. Verification is therefore by column NAME.

CREATE TABLE configs (
	id INTEGER NOT NULL,
	name VARCHAR(100) NOT NULL,
	task_type VARCHAR(20) NOT NULL,
	body JSON NOT NULL,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id)
);
CREATE UNIQUE INDEX ix_configs_name ON configs (name);

CREATE TABLE schedules (
	id INTEGER NOT NULL,
	cron_expr VARCHAR(100) NOT NULL,
	tz VARCHAR(50) NOT NULL,
	task_type VARCHAR(20) NOT NULL,
	config_name VARCHAR(100) NOT NULL,
	enabled BOOLEAN NOT NULL,
	PRIMARY KEY (id)
);

CREATE TABLE runs (
	id VARCHAR(32) NOT NULL,
	task_type VARCHAR(20) NOT NULL,
	config_name VARCHAR(100) NOT NULL,
	"trigger" VARCHAR(20) NOT NULL,
	notify BOOLEAN NOT NULL,
	attempt INTEGER NOT NULL,
	status VARCHAR(20) NOT NULL,
	error TEXT,
	created_at DATETIME NOT NULL,
	started_at DATETIME,
	finished_at DATETIME,
	PRIMARY KEY (id)
);
CREATE INDEX ix_runs_created_at ON runs (created_at);
CREATE INDEX ix_runs_status ON runs (status);

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

CREATE TABLE reports (
	run_id VARCHAR(32) NOT NULL,
	summary JSON NOT NULL,
	html TEXT NOT NULL,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (run_id),
	FOREIGN KEY(run_id) REFERENCES runs (id)
);

-- Alembic's bookkeeping, stamped at the head the Python is on. Nothing here reads it; it is
-- carried so that `alembic upgrade head` is a no-op rather than an attempt to replay every
-- migration, which is what makes the Python a usable rollback against this file.
CREATE TABLE alembic_version (
	version_num VARCHAR(32) NOT NULL,
	CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);
