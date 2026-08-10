from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from optionality.service.models import Base


def make_engine(db_path: str) -> Engine:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False: sessions are used from request threads and the worker thread
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _set_pragmas(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False)


def init_db(engine: Engine) -> None:
    Base.metadata.create_all(engine)
