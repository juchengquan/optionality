from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from optionality.core import run_task
from optionality.service.db import init_db, make_engine, make_session_factory
from optionality.service.routes import health
from optionality.service.scheduler import build_scheduler, refresh_jobs
from optionality.service.settings import Settings
from optionality.service.worker import Worker


def create_app(settings: Settings | None = None, runner=None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.worker.start()
        app.state.scheduler.start()
        refresh_jobs(app.state.scheduler, app.state.session_factory, app.state.worker)
        yield
        app.state.scheduler.shutdown(wait=False)
        app.state.worker.stop()

    app = FastAPI(title="optionality", lifespan=lifespan)

    engine = make_engine(settings.db_path)
    init_db(engine)
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = make_session_factory(engine)
    app.state.worker = Worker(app.state.session_factory, settings, runner=runner or run_task)
    app.state.scheduler = build_scheduler()

    @app.middleware("http")
    async def bearer_auth(request: Request, call_next):
        if (
            request.url.path != "/health"
            and settings.api_token
            and request.headers.get("Authorization") != f"Bearer {settings.api_token}"
        ):
            return JSONResponse(status_code=401, content={"detail": "unauthorized"})
        return await call_next(request)

    app.include_router(health.router)
    return app
