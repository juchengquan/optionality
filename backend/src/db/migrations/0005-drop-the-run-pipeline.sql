-- The run pipeline's tables, and alembic's bookkeeping, go with phase 10 (ADR 0014).
--
-- configs, schedules, runs and reports held the strategy and holdings scans. #118 removed the
-- routes that reached them and phase 10 the worker that ran them: two runs in the service's life,
-- both by hand on 2026-08-10, and zero schedules ever. alembic_version was carried only so the
-- Python could open this file as a rollback, and the rollback is gone too.
--
-- DESTRUCTIVE, so it relies on what `make deploy` does before every restart: an online backup of
-- the database file, taken BEFORE this runs at boot. That backup and the
-- `python-before-phase-10` tag are how any of it comes back.
--
-- reports before runs, because reports.run_id references runs.id.
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS schedules;
DROP TABLE IF EXISTS configs;
DROP TABLE IF EXISTS alembic_version;
