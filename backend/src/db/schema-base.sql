-- The shape this database had before the first migration ran. A HISTORICAL FACT, not a schema.
--
-- `schema.sql` carries the CURRENT shape, so it cannot build the old one, and a migration can only
-- be checked against something that predates it. This is that something.
--
-- WHERE IT COMES FROM. Transcribed from `optionality-ts.db.bak-predelete-20261012-214223.db` in
-- BACKUP_DIR's archive/ — a real backup of the live file, taken when 0001 was the only migration
-- applied — with exactly what 0001 adds taken back out: positions.opened_at,
-- positions.manage_notified_at and the position_samples table. `schema_migrations` is left out
-- because the mechanism creates it on demand, and a database that has it is no longer a baseline.
-- Checked, not assumed: applying 0001 to this file reproduces that backup table for table, across
-- all nine tables it had.
--
-- NOT the Python's database, which was the obvious first guess and is wrong. The archived
-- pyarch/optionality.db lists `monitors` in the order alembic's ALTER TABLEs left it — direction,
-- legs, compare, last_alarm_at, disabled_reason and scope appended at the end — and both the live
-- file and schema.sql list them in the middle. So data/optionality-ts.db was BUILT from schema.sql
-- at the 2026-10-02 cutover and its rows copied in, not copied as a file. The Python-era tables
-- below (alembic_version, configs, runs, reports, schedules) came across with it and are here
-- because the live file really had them; migration 0005 is what drops them.
--
-- NEVER EDIT THIS TO MATCH schema.sql. The whole value of the file is that it cannot follow: a
-- column added to schema.sql with no migration is caught only because this file does not have it,
-- and a baseline kept in step would catch nothing. A schema change belongs in schema.sql AND in a
-- new migration (CLAUDE.md); this file stays as it was.
--
-- See migrate.test.ts, "the two roads into a database".

CREATE TABLE alembic_version (
	version_num VARCHAR(32) NOT NULL,
	CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);

CREATE TABLE configs (
	id INTEGER NOT NULL,
	name VARCHAR(100) NOT NULL,
	task_type VARCHAR(20) NOT NULL,
	body JSON NOT NULL,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id)
);

CREATE TABLE monitor_positions (
	monitor_id VARCHAR(32) NOT NULL,
	position_id VARCHAR(32) NOT NULL,
	PRIMARY KEY (monitor_id, position_id),
	FOREIGN KEY(monitor_id) REFERENCES monitors (id),
	FOREIGN KEY(position_id) REFERENCES positions (id)
);

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

CREATE TABLE reports (
	run_id VARCHAR(32) NOT NULL,
	summary JSON NOT NULL,
	html TEXT NOT NULL,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (run_id),
	FOREIGN KEY(run_id) REFERENCES runs (id)
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

CREATE TABLE schedules (
	id INTEGER NOT NULL,
	cron_expr VARCHAR(100) NOT NULL,
	tz VARCHAR(50) NOT NULL,
	task_type VARCHAR(20) NOT NULL,
	config_name VARCHAR(100) NOT NULL,
	enabled BOOLEAN NOT NULL,
	PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_configs_name ON configs (name);

CREATE INDEX ix_monitors_code ON monitors (code);

CREATE UNIQUE INDEX ix_positions_name ON positions (name);

CREATE INDEX ix_runs_created_at ON runs (created_at);

CREATE INDEX ix_runs_status ON runs (status);

