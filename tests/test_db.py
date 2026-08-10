from sqlalchemy import select, text

from optionality.service.db import init_db, make_engine, make_session_factory
from optionality.service.models import ConfigDoc, Run


def test_wal_mode_and_roundtrip(tmp_path):
    engine = make_engine(str(tmp_path / "t.db"))
    init_db(engine)
    sf = make_session_factory(engine)

    with sf() as s:
        assert s.execute(text("PRAGMA journal_mode")).scalar() == "wal"
        s.add(ConfigDoc(name="c1", task_type="holdings", body={"k": [1, 2]}))
        s.add(Run(id="r1", task_type="holdings", config_name="c1", trigger="api", notify=False))
        s.commit()

    with sf() as s:
        row = s.scalar(select(ConfigDoc).where(ConfigDoc.name == "c1"))
        assert row.body == {"k": [1, 2]}
        assert row.created_at is not None
        run = s.get(Run, "r1")
        assert run.status == "queued"
        assert run.attempt == 1
