from collections.abc import Iterator

from fastapi import Request
from sqlalchemy.orm import Session


def get_session(request: Request) -> Iterator[Session]:
    with request.app.state.session_factory() as session:
        yield session


def get_session_factory(request: Request):
    return request.app.state.session_factory


def get_settings(request: Request):
    return request.app.state.settings


def get_worker(request: Request):
    return request.app.state.worker


def get_scheduler(request: Request):
    return request.app.state.scheduler
