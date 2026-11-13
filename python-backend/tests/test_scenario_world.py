"""A scenario's world, built by the Python exactly as the TypeScript builds it (ADR 0021, phase 2).

Every later port stands on this: a door can only be held to the TypeScript if the database it runs
on holds what the scenario says, value for value. So the round trip covers EVERY scenario, not a
sample — build the database from `schema/schema.sql`, insert the world's rows, read them back, and
compare with the file under the README's rules — and the builder's own refusals are checked on
small worlds below.
"""

import sqlite3
import tempfile

import pytest
from scenarios.compare import first_difference
from scenarios.corpus import DOORS, SCENARIOS, all_scenarios, read_scenario
from scenarios.world import (
    MIGRATIONS,
    TABLES,
    WorldError,
    create_database,
    dump_tables,
    fill,
    insert_rows,
    open_world,
)

CORPUS = all_scenarios()


def test_the_corpus_is_there():
    # a missing testdata/scenarios/ would otherwise be a round trip that passes by reading nothing
    assert len(CORPUS) >= 100, f"only {len(CORPUS)} scenarios under {SCENARIOS}"
    assert {name.split("/")[0] for name in CORPUS} == set(DOORS)


@pytest.mark.parametrize("name", CORPUS)
def test_a_world_round_trips_exactly(name, tmp_path):
    """Insert, dump, compare — WITHOUT `fill`'s own check, so this is not the builder agreeing with
    itself: the comparison here is the README's, done afresh on what SQLite hands back."""
    world = read_scenario(name)["world"]
    db = create_database(tmp_path / "world.db")
    try:
        insert_rows(db, world["tables"])
        dumped = dump_tables(db)
    finally:
        db.close()
    assert list(dumped) == list(TABLES)
    found = first_difference(dumped, world["tables"])
    assert found is None, found


def test_the_database_is_stamped_not_migrated(tmp_path):
    # schema.sql carries the current shape, so every migration is recorded as run and none is
    # applied, as `createDatabase` does (ADR 0011) — a migration applied on top would fail on a
    # duplicate column
    db = create_database(tmp_path / "w.db")
    names = [r[0] for r in db.execute("select name from schema_migrations order by name")]
    expected = sorted(p.name for p in MIGRATIONS.glob("*.sql"))
    assert names == expected and len(expected) >= 7
    applied = [r[0] for r in db.execute("select applied_at from schema_migrations")]
    assert all(len(a) == 23 and a[10] == " " for a in applied), applied  # 2026-11-09 15:00:00.000
    db.close()


def test_the_database_has_every_table_the_schema_declares_and_no_other(tmp_path):
    db = create_database(tmp_path / "w.db")
    names = sorted(r[0] for r in db.execute("select name from sqlite_master where type='table'"))
    assert names == sorted([*TABLES, "schema_migrations"])
    db.close()


def test_the_database_enforces_its_links_as_the_service_opens_it(tmp_path):
    # foreign_keys is per connection and off by default; the TypeScript turns it on in openDatabase,
    # and a world that broke a link would otherwise be built here and refused there
    db = create_database(tmp_path / "w.db")
    assert db.execute("pragma foreign_keys").fetchone() == (1,)
    assert db.execute("pragma journal_mode").fetchone() == ("wal",)
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("insert into monitor_positions (monitor_id, position_id) values ('nobody', 'nothing')")
    db.close()


def _position(**overrides):
    row = {
        "id": "pos-1",
        "name": "dec-condor",
        "strategy": None,
        "strike_date": "2026-12-18",
        "contracts": 1,
        "entry": 6.4,
        "legs": [{"side": "short", "option_type": "CALL", "strike": 7300}],
        "created_at": "2026-11-02 14:30:00.000000",
        "opened_at": None,
        "manage_notified_at": None,
        "closed_on": None,
        "exit": None,
        "qty_corrected_at": None,
    }
    return {**row, **overrides}


def _tables(**rows):
    return {table: rows.get(table, []) for table in TABLES}


def test_fill_refuses_a_row_missing_a_column(tmp_path):
    db = create_database(tmp_path / "w.db")
    row = _position()
    del row["opened_at"]
    with pytest.raises(WorldError, match="missing opened_at"):
        fill(db, _tables(positions=[row]))
    db.close()


def test_fill_refuses_a_row_naming_a_column_the_schema_does_not_have(tmp_path):
    db = create_database(tmp_path / "w.db")
    with pytest.raises(WorldError, match="unknown colour"):
        fill(db, _tables(positions=[_position(colour="red")]))
    db.close()


@pytest.mark.parametrize(
    ("column", "value"),
    [
        # REAL affinity turns the text into a number: the database does not hold what the file says
        ("entry", "6.4"),
        # a boolean is not a number, though SQLite stores it as one
        ("contracts", True),
    ],
)
def test_fill_refuses_a_row_the_database_stores_differently(column, value, tmp_path):
    db = create_database(tmp_path / "w.db")
    with pytest.raises(WorldError, match="does not hold the rows the scenario states"):
        fill(db, _tables(positions=[_position(**{column: value})]))
    db.close()


def test_a_json_column_is_stored_as_the_json_it_contains(tmp_path):
    # the file writes `legs` as a list; the database holds its text, compact as JSON.stringify
    # writes it, and the dump reads it back as the list
    db = create_database(tmp_path / "w.db")
    fill(db, _tables(positions=[_position(legs=[{"strike": 7300, "label": "é"}])]))
    assert db.execute("select legs from positions").fetchone() == ('[{"strike":7300,"label":"é"}]',)
    assert dump_tables(db)["positions"][0]["legs"] == [{"strike": 7300, "label": "é"}]
    db.close()


def test_a_number_in_a_float_column_reads_back_as_the_same_number(tmp_path):
    # 7300 in the file, 7300.0 in SQLite: one number, which is what the README says a runner compares
    db = create_database(tmp_path / "w.db")
    fill(db, _tables(positions=[_position(entry=7)]))
    assert db.execute("select typeof(entry), entry from positions").fetchone() == ("real", 7.0)
    db.close()


def test_open_world_removes_its_database_when_closed():
    world = read_scenario(CORPUS[0])["world"]
    w = open_world(world)
    path = w.path
    assert path.exists()
    w.close()
    assert not path.exists() and not path.parent.exists()


def test_open_world_removes_its_database_when_the_world_cannot_be_built(monkeypatch, tmp_path):
    # a world that fails its own check must not leave a database behind in the temp directory, 120
    # of them a run once the suite is red
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    world = read_scenario(CORPUS[0])["world"]
    broken = {**world, "tables": _tables(positions=[_position(colour="red")])}
    with pytest.raises(WorldError):
        open_world(broken)
    assert list(tmp_path.iterdir()) == []
