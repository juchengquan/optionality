# Optionality Hosted Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the optionality batch CLI into a single-user FastAPI service that runs scheduled strategy/holdings scans, emails HTML reports, and accepts ad-hoc runs over a Tailscale-only API.

**Architecture:** FastAPI app with an in-process APScheduler and a single worker thread that serializes all runs (moomoo QPS is per-account and the SDK is blocking). SQLite (WAL) via SQLAlchemy 2.0 stores configs as pydantic-validated JSON documents plus relational `schedules`/`runs`/`reports` tables. Each job opens its own OpenD connection and closes it. The existing pipeline is extracted into `optionality/core.py`; the CLI survives as a thin wrapper over it.

**Tech Stack:** Python ≥3.12, uv, FastAPI, uvicorn, SQLAlchemy 2.0, Alembic, APScheduler 3.x, SQLite, pydantic v2, pytest + httpx (tests), Docker Compose, Tailscale (network layer, no code impact).

## Global Constraints

- Python `requires-python = ">=3.12"`; run everything through uv (`uv run …`, `uv add …`). Never pip.
- Lint/format must pass before every commit: `make lint` and `make format` (ruff, line-length 120).
- New runtime deps limited to: `fastapi`, `uvicorn`, `sqlalchemy>=2`, `apscheduler>=3.10,<4`. New dev deps: `pytest`, `httpx`, `alembic`. Add with `uv add` / `uv add --dev` so `uv.lock` stays authoritative.
- Exactly ONE worker thread executes runs. Nothing else may open an OpenD connection concurrently.
- Secrets (Gmail creds, API token, healthcheck URL) come ONLY from environment variables — never in YAML, DB, or code.
- SQLite must run in WAL mode with `foreign_keys=ON`.
- All new timestamps are timezone-aware UTC (`datetime.now(UTC)`); ruff's DTZ rules are enabled and will fail the build otherwise.
- The moomoo SDK is blocking; it may only be called from the worker thread (or the CLI), never from a request handler.
- Tests must not touch the network, real OpenD, yfinance, or SMTP — fake/monkeypatch at the boundaries.

## File Map (final state)

```
main.py                                  # thin CLI over core.run_task (Modify)
src/optionality/
  core.py                                # NEW: load_config, run_task, send_notifications, RunResult
  apis/moomoo_api.py                     # Modify: get_client(host, port)
  datatype/notification.py               # Modify: GmailConfig loses user/password
  notification/gmail.py                  # Modify: creds from env; uses full_html_document
  notification/html_maker.py             # Modify: + default_css_style, full_html_document
  service/
    __init__.py                          # NEW (empty)
    settings.py                          # NEW: Settings dataclass + from_env
    db.py                                # NEW: make_engine, make_session_factory, init_db
    models.py                            # NEW: Base, ConfigDoc, Schedule, Run, Report, utcnow
    worker.py                            # NEW: Worker thread, create_run
    scheduler.py                         # NEW: build_scheduler, refresh_jobs, validate_cron
    deps.py                              # NEW: FastAPI dependencies (session, settings, worker, scheduler)
    app.py                               # NEW: create_app factory, auth middleware, lifespan
    routes/
      __init__.py                        # NEW (empty)
      health.py                          # NEW
      configs.py                         # NEW
      schedules.py                       # NEW
      runs.py                            # NEW
alembic.ini, alembic/                    # NEW: migration scaffolding (dev tool)
tests/
  conftest.py                            # NEW: shared fixtures (grows across tasks)
  test_settings.py test_notification.py test_core.py test_db.py
  test_worker.py test_scheduler.py test_app.py
  test_configs_api.py test_schedules_api.py test_runs_api.py
Dockerfile, docker-compose.yml, .env.example   # NEW
Makefile                                 # Modify: + test, serve targets
README.md                                # Modify: + service section & runbook
examples/strategy.yaml                   # Modify: drop creds from gmail block comment
```

---

### Task 1: Dependencies, Settings module, pytest wiring

**Files:**
- Modify: `pyproject.toml`
- Modify: `Makefile`
- Create: `src/optionality/service/__init__.py`
- Create: `src/optionality/service/settings.py`
- Test: `tests/test_settings.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `Settings` frozen dataclass with fields `db_path: str` (default `"data/optionality.db"`), `opend_host: str` (`"127.0.0.1"`), `opend_port: int` (`11111`), `api_token: str` (`""`), `healthcheck_url: str` (`""`), `retry_delay_seconds: int` (`300`); classmethod `Settings.from_env() -> Settings` reading env vars `OPTIONALITY_DB_PATH`, `OPEND_HOST`, `OPEND_PORT`, `API_TOKEN`, `HEALTHCHECK_URL`, `RETRY_DELAY_SECONDS`. Every later task constructs `Settings(...)` directly in tests.

- [ ] **Step 1: Add dependencies**

```bash
uv add fastapi uvicorn "sqlalchemy>=2" "apscheduler>=3.10,<4"
uv add --dev pytest httpx alembic
```

- [ ] **Step 2: Add pytest config to `pyproject.toml`** (append at end of file)

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 3: Add Makefile targets** (extend existing file; keep `lint`/`format`)

```make
.PHONY: lint format test serve

test:
	uv run pytest

serve:
	uv run uvicorn --factory optionality.service.app:create_app --host 0.0.0.0 --port 8000
```

- [ ] **Step 4: Create empty package marker** `src/optionality/service/__init__.py` (empty file).

- [ ] **Step 5: Write the failing test** — `tests/test_settings.py`

```python
from optionality.service.settings import Settings


def test_defaults():
    s = Settings()
    assert s.opend_host == "127.0.0.1"
    assert s.opend_port == 11111
    assert s.api_token == ""
    assert s.retry_delay_seconds == 300
    assert s.db_path == "data/optionality.db"


def test_from_env(monkeypatch):
    monkeypatch.setenv("OPTIONALITY_DB_PATH", "/tmp/x.db")
    monkeypatch.setenv("OPEND_HOST", "opend")
    monkeypatch.setenv("OPEND_PORT", "22222")
    monkeypatch.setenv("API_TOKEN", "sekrit")
    monkeypatch.setenv("HEALTHCHECK_URL", "https://hc.example/ping")
    monkeypatch.setenv("RETRY_DELAY_SECONDS", "10")
    s = Settings.from_env()
    assert s == Settings(
        db_path="/tmp/x.db",
        opend_host="opend",
        opend_port=22222,
        api_token="sekrit",
        healthcheck_url="https://hc.example/ping",
        retry_delay_seconds=10,
    )
```

- [ ] **Step 6: Run test to verify it fails**

Run: `uv run pytest tests/test_settings.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'optionality.service.settings'`

- [ ] **Step 7: Implement** — `src/optionality/service/settings.py`

```python
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    db_path: str = "data/optionality.db"
    opend_host: str = "127.0.0.1"
    opend_port: int = 11111
    api_token: str = ""
    healthcheck_url: str = ""
    retry_delay_seconds: int = 300

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            db_path=os.environ.get("OPTIONALITY_DB_PATH", cls.db_path),
            opend_host=os.environ.get("OPEND_HOST", cls.opend_host),
            opend_port=int(os.environ.get("OPEND_PORT", cls.opend_port)),
            api_token=os.environ.get("API_TOKEN", cls.api_token),
            healthcheck_url=os.environ.get("HEALTHCHECK_URL", cls.healthcheck_url),
            retry_delay_seconds=int(os.environ.get("RETRY_DELAY_SECONDS", cls.retry_delay_seconds)),
        )
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `uv run pytest tests/test_settings.py -v`
Expected: 2 PASS

- [ ] **Step 9: Lint, format, commit**

```bash
make format && make lint
git add pyproject.toml uv.lock Makefile src/optionality/service tests/test_settings.py
git commit -m "feat: add service deps and Settings module"
```

---

### Task 2: Notification refactor — Gmail creds from env, shared HTML wrapper

**Files:**
- Modify: `src/optionality/datatype/notification.py`
- Modify: `src/optionality/notification/gmail.py`
- Modify: `src/optionality/notification/html_maker.py`
- Modify: `examples/strategy.yaml`
- Test: `tests/test_notification.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GmailConfig` with ONLY `subject: str`, `from_address: EmailStr`, `to_address: list[EmailStr]` (no `user`/`password`). `full_html_document(body: str) -> str` in `optionality.notification.html_maker` (also exported from `optionality.notification`). `send_gmail_notification(setting: dict, body_message: str)` unchanged signature but reads creds from env `GMAIL_USER` / `GMAIL_APP_PASSWORD`, raising `RuntimeError` if unset.

- [ ] **Step 1: Write the failing tests** — `tests/test_notification.py`

```python
import pytest

from optionality.notification import full_html_document
from optionality.notification import gmail as gmail_mod


class FakeSMTP:
    instances = []

    def __init__(self, host, port):
        self.host, self.port = host, port
        self.logins, self.sent = [], []
        FakeSMTP.instances.append(self)

    def ehlo(self):
        pass

    def starttls(self):
        pass

    def login(self, user, pwd):
        self.logins.append((user, pwd))

    def sendmail(self, from_addr, to_addrs, msg):
        self.sent.append((from_addr, to_addrs))

    def close(self):
        pass


SETTING = {"subject": "s", "from_address": "a@b.co", "to_address": ["d@e.fo"]}


def test_full_html_document_wraps_body():
    doc = full_html_document("<p>hi</p>")
    assert doc.startswith("<html>")
    assert "<p>hi</p>" in doc
    assert "</html>" in doc


def test_gmail_uses_env_creds(monkeypatch):
    FakeSMTP.instances.clear()
    monkeypatch.setattr(gmail_mod.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setenv("GMAIL_USER", "me@gmail.com")
    monkeypatch.setenv("GMAIL_APP_PASSWORD", "apppw")
    gmail_mod.send_gmail_notification(SETTING, "<p>report</p>")
    smtp = FakeSMTP.instances[0]
    assert smtp.logins == [("me@gmail.com", "apppw")]
    assert smtp.sent[0][0] == "a@b.co"


def test_gmail_missing_creds_raises(monkeypatch):
    monkeypatch.delenv("GMAIL_USER", raising=False)
    monkeypatch.delenv("GMAIL_APP_PASSWORD", raising=False)
    with pytest.raises(RuntimeError):
        gmail_mod.send_gmail_notification(SETTING, "<p>x</p>")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_notification.py -v`
Expected: FAIL — `ImportError: cannot import name 'full_html_document'`

- [ ] **Step 3: Implement html_maker additions** — append to `src/optionality/notification/html_maker.py`

```python
default_css_style = """<style>
div {
    font-size: 12pt;
}
</style>
"""


def full_html_document(body: str) -> str:
    return f"<html>\n    <head>{default_css_style}</head>\n    <body>{body}</body>\n    </html>\n    "
```

(Remove the now-duplicated `default_css_style` from `gmail.py` in the next step.)

- [ ] **Step 4: Rewrite** `src/optionality/notification/gmail.py`

```python
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from .html_maker import full_html_document


def _email_login():
    user = os.environ.get("GMAIL_USER")
    pwd = os.environ.get("GMAIL_APP_PASSWORD")
    if not user or not pwd:
        raise RuntimeError("GMAIL_USER and GMAIL_APP_PASSWORD environment variables must be set")

    server = smtplib.SMTP("smtp.gmail.com", 587)
    server.ehlo()
    server.starttls()
    server.login(user, pwd)

    return server


def send_gmail_notification(setting: dict, body_message: str):
    all_html = full_html_document(body_message)

    msg = MIMEMultipart()

    msg["From"] = setting["from_address"]
    msg["To"] = setting["to_address"] if isinstance(setting, str) else ";".join(setting["to_address"])

    msg["Subject"] = setting["subject"]

    msg.attach(MIMEText(all_html, "html"))

    server = _email_login()
    server.sendmail(setting["from_address"], setting["to_address"], msg.as_string())
    server.close()
```

- [ ] **Step 5: Update the pydantic model** — in `src/optionality/datatype/notification.py`, replace `GmailConfig` with:

```python
class GmailConfig(BaseModel):
    subject: str
    from_address: EmailStr
    to_address: list[EmailStr]
```

- [ ] **Step 6: Export the wrapper** — in `src/optionality/notification/__init__.py`:

```python
from .file import save_as_local_file
from .gmail import send_gmail_notification
from .html_maker import build_html_message, full_html_document

notification_funcs = {
    "gmail": send_gmail_notification,
    "file": save_as_local_file,
}

__all__ = ["build_html_message", "full_html_document", "notification_funcs"]
```

- [ ] **Step 7: Update `examples/strategy.yaml`** — replace the commented gmail block with the credential-free shape:

```yaml
notification:
  # gmail:
  #   subject: "💰 Options Holding Report"
  #   from_address: "your_address@gmail.com"
  #   to_address: ["your_address@gmail.com"]
  # (credentials come from GMAIL_USER / GMAIL_APP_PASSWORD environment variables)
  file:
    file_path: "./output_holdings.html"
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `uv run pytest tests/test_notification.py -v`
Expected: 3 PASS

- [ ] **Step 9: Lint, format, commit**

```bash
make format && make lint
git add -A && git commit -m "feat: gmail creds from env, shared full_html_document"
```

---

### Task 3: Core pipeline extraction + parameterized client + thin CLI

**Files:**
- Create: `src/optionality/core.py`
- Modify: `src/optionality/apis/moomoo_api.py` (only `get_client`)
- Modify: `main.py`
- Create: `tests/conftest.py`
- Test: `tests/test_core.py`

**Interfaces:**
- Consumes: `get_client`, `get_option_holdings_info`, `get_option_strategies_info`, `get_strike_table` from `optionality.apis`; `build_html_message`, `notification_funcs` from `optionality.notification`; config models from `optionality.datatype`.
- Produces (used by worker, routes, CLI):
  - `CONFIG_MODELS: dict[str, type]` mapping `"strategy" -> OptionStrategiesConfig`, `"holdings" -> OptionHoldingsConfig`.
  - `load_config(task: str, body: dict) -> OptionStrategiesConfig | OptionHoldingsConfig` (raises `ValueError` on unknown task, `pydantic.ValidationError` on bad body).
  - `@dataclass RunResult` with `html: str`, `summary: list[dict]`, `warnings: list[dict] | None`.
  - `run_task(task, config, client_factory=get_client, opend_host="127.0.0.1", opend_port=11111) -> RunResult`.
  - `send_notifications(notification: NotificationConfig, html: str) -> None`.
  - `get_client(host: str = "127.0.0.1", port: int = 11111)` in `optionality.apis.moomoo_api`.

- [ ] **Step 1: Create `tests/conftest.py`** with shared config bodies

```python
import pytest

HOLDINGS_BODY = {
    "notification": {"file": {"file_path": "./out.html"}},
    "code_information": {"type": "index", "name": "SPX", "market": "US"},
    "option_holdings": [
        {
            "strategy": "iron_condor",
            "strike_date": "2026-12-18",
            "volume": 1,
            "entry_price": 1.25,
            "warning_threshold": {"delta": 0.3},
            "options": [{"type": "CALL", "direction": "short", "strike_price": 6500.0}],
        }
    ],
}

STRATEGY_BODY = {
    "notification": {"file": {"file_path": "./out.html"}},
    "code_information": {"type": "index", "name": "SPX", "market": "US"},
    "option_strategy": {
        "strategy": "iron_condor",
        "expiry_date_distance": {"min": 5, "max": 20},
        "options": [
            {"option_type": "PUT", "filter": {"delta_min": -0.15, "delta_max": -0.05}, "stride": 25},
            {"option_type": "CALL", "filter": {"delta_min": 0.05, "delta_max": 0.15}, "stride": 25},
        ],
    },
}


@pytest.fixture
def holdings_body():
    return HOLDINGS_BODY


@pytest.fixture
def strategy_body():
    return STRATEGY_BODY
```

- [ ] **Step 2: Write the failing tests** — `tests/test_core.py`

```python
import pandas as pd
import pytest

import optionality.core as core


class FakeClient:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


def test_load_config_dispatch(holdings_body, strategy_body):
    from optionality.datatype import OptionHoldingsConfig, OptionStrategiesConfig

    assert isinstance(core.load_config("holdings", holdings_body), OptionHoldingsConfig)
    assert isinstance(core.load_config("strategy", strategy_body), OptionStrategiesConfig)
    with pytest.raises(ValueError):
        core.load_config("nope", holdings_body)


def test_run_task_holdings_builds_report_and_closes_client(monkeypatch, holdings_body):
    df_summary = pd.DataFrame([{"strike_date": "2026-12-18", "strategy": "iron_condor", "mid_price": 1.0}])
    dt_details = {"2026-12-18": {"ab12": pd.DataFrame([{"code": "X", "mid_price": 1.0}])}}
    df_warning = pd.DataFrame([{"strike_date": "2026-12-18", "code": "X", "option_delta": 0.5}])
    monkeypatch.setattr(core, "get_option_holdings_info", lambda client, cfg: (df_summary, dt_details, df_warning))

    fake = FakeClient()
    config = core.load_config("holdings", holdings_body)
    result = core.run_task("holdings", config, client_factory=lambda host, port: fake)

    assert "Summary:" in result.html
    assert result.summary[0]["strategy"] == "iron_condor"
    assert result.warnings[0]["code"] == "X"
    assert fake.closed


def test_run_task_closes_client_on_error(monkeypatch, holdings_body):
    def boom(client, cfg):
        raise RuntimeError("api down")

    monkeypatch.setattr(core, "get_option_holdings_info", boom)
    fake = FakeClient()
    config = core.load_config("holdings", holdings_body)
    with pytest.raises(RuntimeError):
        core.run_task("holdings", config, client_factory=lambda host, port: fake)
    assert fake.closed


def test_send_notifications_writes_file(tmp_path, holdings_body):
    body = dict(holdings_body)
    body["notification"] = {"file": {"file_path": str(tmp_path / "r.html")}}
    config = core.load_config("holdings", body)
    core.send_notifications(config.notification, "<p>hello</p>")
    assert (tmp_path / "r.html").read_text() == "<p>hello</p>"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_core.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'optionality.core'`

- [ ] **Step 4: Parameterize `get_client`** — in `src/optionality/apis/moomoo_api.py` replace the function with:

```python
def get_client(host: str = "127.0.0.1", port: int = 11111):
    try:
        client = OpenQuoteContext(host=host, port=port)
        return client
    except Exception as err:
        raise RuntimeError("Client connection failed!") from err
```

- [ ] **Step 5: Implement** — `src/optionality/core.py`

```python
from dataclasses import dataclass
from typing import Callable

from optionality.apis import (
    get_client,
    get_option_holdings_info,
    get_option_strategies_info,
    get_strike_table,
)
from optionality.datatype import OptionHoldingsConfig, OptionStrategiesConfig
from optionality.datatype.notification import NotificationConfig
from optionality.notification import build_html_message, notification_funcs

CONFIG_MODELS: dict[str, type] = {
    "strategy": OptionStrategiesConfig,
    "holdings": OptionHoldingsConfig,
}


@dataclass
class RunResult:
    html: str
    summary: list[dict]
    warnings: list[dict] | None


def load_config(task: str, body: dict) -> OptionStrategiesConfig | OptionHoldingsConfig:
    try:
        model = CONFIG_MODELS[task]
    except KeyError:
        raise ValueError(f"task type is wrong: {task}") from None
    return model(**body)


def run_task(
    task: str,
    config: OptionStrategiesConfig | OptionHoldingsConfig,
    client_factory: Callable = get_client,
    opend_host: str = "127.0.0.1",
    opend_port: int = 11111,
) -> RunResult:
    if task not in CONFIG_MODELS:
        raise ValueError(f"task type is wrong: {task}")

    client = client_factory(host=opend_host, port=opend_port)
    try:
        if task == "strategy":
            df_strikes = get_strike_table(config)
            df_summary, dt_details, _ = get_option_strategies_info(client, df_strikes, config)
            df_warning = None
        else:
            df_summary, dt_details, df_warning = get_option_holdings_info(client, config)

        html = build_html_message(df_summary, dt_details, df_warning)
        return RunResult(
            html=html,
            summary=df_summary.to_dict("records"),
            warnings=df_warning.to_dict("records") if df_warning is not None else None,
        )
    finally:
        client.close()


def send_notifications(notification: NotificationConfig, html: str) -> None:
    for name, params in notification.model_dump().items():
        if params:
            notification_funcs[name](params, html)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_core.py -v`
Expected: 4 PASS

- [ ] **Step 7: Rewrite `main.py`** as a thin wrapper

```python
import argparse
import time

import yaml

from optionality.core import load_config, run_task, send_notifications

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Optionality Parameters")
    parser.add_argument("-t", "--task", help="Task type", choices=["strategy", "holdings"], required=True)
    parser.add_argument("-f", "--setting_file", help="Configuration file", type=str, required=True)
    args = parser.parse_args()

    t_s = time.time()
    with open(args.setting_file) as f:
        raw = yaml.safe_load(f)

    config = load_config(args.task, raw)
    result = run_task(args.task, config)
    send_notifications(config.notification, result.html)

    print(f"Session closed. total time: {time.time() - t_s}")
```

- [ ] **Step 8: Verify CLI wiring** (no OpenD needed)

Run: `uv run python main.py --help`
Expected: usage text with `-t {strategy,holdings}` and `-f`; exit 0. Then run the full suite: `uv run pytest -v` — all PASS.

- [ ] **Step 9: Lint, format, commit**

```bash
make format && make lint
git add -A && git commit -m "feat: extract core.run_task, parameterize get_client, thin CLI"
```

---

### Task 4: Database layer — models and engine

**Files:**
- Create: `src/optionality/service/models.py`
- Create: `src/optionality/service/db.py`
- Modify: `tests/conftest.py` (append fixtures)
- Test: `tests/test_db.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `utcnow() -> datetime` (aware UTC).
  - ORM classes `ConfigDoc(name, task_type, body, created_at, updated_at)`, `Schedule(id, cron_expr, tz, task_type, config_name, enabled)`, `Run(id: str, task_type, config_name, trigger, notify, attempt, status, error, created_at, started_at, finished_at)`, `Report(run_id, summary, html, created_at)` on `Base`.
  - `make_engine(db_path: str) -> Engine` (WAL, foreign keys, `check_same_thread=False`), `make_session_factory(engine) -> sessionmaker[Session]`, `init_db(engine) -> None`.
  - conftest fixtures `engine`, `session_factory` (tmp-file SQLite, schema created).

- [ ] **Step 1: Write the failing test** — `tests/test_db.py`

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_db.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'optionality.service.db'`

- [ ] **Step 3: Implement** — `src/optionality/service/models.py`

```python
from datetime import UTC, datetime

from sqlalchemy import JSON, ForeignKey, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class ConfigDoc(Base):
    __tablename__ = "configs"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    task_type: Mapped[str] = mapped_column(String(20))
    body: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class Schedule(Base):
    __tablename__ = "schedules"

    id: Mapped[int] = mapped_column(primary_key=True)
    cron_expr: Mapped[str] = mapped_column(String(100))
    tz: Mapped[str] = mapped_column(String(50), default="America/New_York")
    task_type: Mapped[str] = mapped_column(String(20))
    config_name: Mapped[str] = mapped_column(String(100))
    enabled: Mapped[bool] = mapped_column(default=True)


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    task_type: Mapped[str] = mapped_column(String(20))
    config_name: Mapped[str] = mapped_column(String(100))
    trigger: Mapped[str] = mapped_column(String(20))  # "schedule" | "api"
    notify: Mapped[bool] = mapped_column(default=False)
    attempt: Mapped[int] = mapped_column(default=1)
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(default=utcnow, index=True)
    started_at: Mapped[datetime | None] = mapped_column(default=None)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)


class Report(Base):
    __tablename__ = "reports"

    run_id: Mapped[str] = mapped_column(String(32), ForeignKey("runs.id"), primary_key=True)
    summary: Mapped[dict] = mapped_column(JSON)
    html: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
```

- [ ] **Step 4: Implement** — `src/optionality/service/db.py`

```python
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/test_db.py -v`
Expected: PASS

- [ ] **Step 6: Append db fixtures to `tests/conftest.py`**

```python
from optionality.service.db import init_db, make_engine, make_session_factory


@pytest.fixture
def engine(tmp_path):
    eng = make_engine(str(tmp_path / "test.db"))
    init_db(eng)
    return eng


@pytest.fixture
def session_factory(engine):
    return make_session_factory(engine)
```

- [ ] **Step 7: Run full suite, lint, commit**

```bash
uv run pytest -v
make format && make lint
git add -A && git commit -m "feat: SQLite models and engine (WAL) for service"
```

---

### Task 5: Alembic scaffolding

**Files:**
- Create: `alembic.ini`, `alembic/` (via `alembic init`)
- Modify: `alembic/env.py`

**Interfaces:**
- Consumes: `Base` from `optionality.service.models`.
- Produces: working `uv run alembic revision --autogenerate` / `upgrade head` flow. The app itself keeps using `init_db()` (`create_all`) at startup; Alembic exists for future schema *changes*.

- [ ] **Step 1: Initialize scaffolding**

Run: `uv run alembic init alembic`
Expected: creates `alembic.ini`, `alembic/env.py`, `alembic/script.py.mako`, `alembic/versions/`.

- [ ] **Step 2: Point env.py at the models** — in `alembic/env.py`, add imports at top and replace the `target_metadata = None` line and URL resolution:

```python
import os

from optionality.service.models import Base

target_metadata = Base.metadata

config.set_main_option(
    "sqlalchemy.url",
    "sqlite:///" + os.environ.get("OPTIONALITY_DB_PATH", "data/optionality.db"),
)
```

(The `config = context.config` line already exists in the generated file; place `set_main_option` right after it. Leave the rest of the generated file untouched.)

- [ ] **Step 3: Generate and apply the initial migration**

```bash
OPTIONALITY_DB_PATH=data/optionality.db uv run alembic revision --autogenerate -m "initial schema"
OPTIONALITY_DB_PATH=data/optionality.db uv run alembic upgrade head
```

Expected: a file in `alembic/versions/` creating `configs`, `schedules`, `runs`, `reports`; upgrade exits 0 and `data/optionality.db` exists.

- [ ] **Step 4: Verify autogenerate is now clean**

Run: `OPTIONALITY_DB_PATH=data/optionality.db uv run alembic check`
Expected: "No new upgrade operations detected." (If `alembic check` is unavailable in the installed version, run `revision --autogenerate -m probe` and confirm the generated file has empty `upgrade()`; delete the probe file.)

- [ ] **Step 5: Ignore the dev DB, commit**

Append to `.gitignore` (create if missing): `data/`

```bash
make format && make lint
git add alembic.ini alembic .gitignore && git commit -m "chore: alembic migration scaffolding"
```

---

### Task 6: Worker — serialized run execution, retry, failure email, dead-man ping

**Files:**
- Create: `src/optionality/service/worker.py`
- Test: `tests/test_worker.py`

**Interfaces:**
- Consumes: `Settings`; `ConfigDoc`, `Run`, `Report`, `utcnow` from models; `load_config`, `run_task`, `send_notifications`, `RunResult` from `optionality.core`; `send_gmail_notification` from `optionality.notification.gmail`.
- Produces (used by scheduler, routes, app):
  - `create_run(session_factory, *, task_type: str, config_name: str, trigger: str, notify: bool, attempt: int = 1) -> str` — inserts a `queued` Run row, returns its id.
  - `class Worker(threading.Thread)` with `__init__(self, session_factory, settings: Settings, runner=run_task)`, `submit(run_id: str)`, `stop()` (sentinel + join), `queue_depth() -> int`. Internal seams tests may patch: `_schedule_retry(delay: float, run_id: str)`, module-level `send_notifications`, `send_gmail_notification`, `_ping_healthcheck`.

- [ ] **Step 1: Write the failing tests** — `tests/test_worker.py`

```python
from sqlalchemy import select

import optionality.service.worker as worker_mod
from optionality.core import RunResult
from optionality.service.models import ConfigDoc, Report, Run
from optionality.service.settings import Settings
from optionality.service.worker import Worker, create_run

SETTINGS = Settings(retry_delay_seconds=0)


def _insert_config(session_factory, holdings_body, name="c1"):
    with session_factory() as s:
        s.add(ConfigDoc(name=name, task_type="holdings", body=holdings_body))
        s.commit()


def _stub_runner(task, config, client_factory=None, opend_host=None, opend_port=None):
    return RunResult(html="<p>ok</p>", summary=[{"strike_date": "2026-12-18"}], warnings=None)


def _boom_runner(task, config, client_factory=None, opend_host=None, opend_port=None):
    raise RuntimeError("Client connection failed!")


def test_success_stores_report_and_notifies(session_factory, holdings_body, monkeypatch):
    _insert_config(session_factory, holdings_body)
    sent = []
    monkeypatch.setattr(worker_mod, "send_notifications", lambda cfg, html: sent.append(html))
    rid = create_run(session_factory, task_type="holdings", config_name="c1", trigger="api", notify=True)

    Worker(session_factory, SETTINGS, runner=_stub_runner)._execute(rid)

    with session_factory() as s:
        run = s.get(Run, rid)
        assert run.status == "succeeded"
        assert run.finished_at is not None
        report = s.get(Report, rid)
        assert report.html == "<p>ok</p>"
        assert report.summary["summary"] == [{"strike_date": "2026-12-18"}]
    assert sent == ["<p>ok</p>"]


def test_no_notify_flag_skips_notification(session_factory, holdings_body, monkeypatch):
    _insert_config(session_factory, holdings_body)
    sent = []
    monkeypatch.setattr(worker_mod, "send_notifications", lambda cfg, html: sent.append(html))
    rid = create_run(session_factory, task_type="holdings", config_name="c1", trigger="api", notify=False)
    Worker(session_factory, SETTINGS, runner=_stub_runner)._execute(rid)
    assert sent == []


def test_scheduled_failure_schedules_retry(session_factory, holdings_body, monkeypatch):
    _insert_config(session_factory, holdings_body)
    retries = []
    monkeypatch.setattr(Worker, "_schedule_retry", lambda self, delay, run_id: retries.append(run_id))
    rid = create_run(session_factory, task_type="holdings", config_name="c1", trigger="schedule", notify=True)

    Worker(session_factory, SETTINGS, runner=_boom_runner)._execute(rid)

    with session_factory() as s:
        assert s.get(Run, rid).status == "failed"
        retry = s.scalar(select(Run).where(Run.attempt == 2))
        assert retry is not None
        assert retry.trigger == "schedule"
        assert retries == [retry.id]


def test_final_scheduled_failure_sends_failure_email(session_factory, holdings_body, monkeypatch):
    body = dict(holdings_body)
    body["notification"] = {
        "gmail": {"subject": "report", "from_address": "a@b.co", "to_address": ["a@b.co"]}
    }
    _insert_config(session_factory, body)
    emails = []
    monkeypatch.setattr(worker_mod, "send_gmail_notification", lambda setting, msg: emails.append((setting, msg)))
    rid = create_run(session_factory, task_type="holdings", config_name="c1", trigger="schedule", notify=True, attempt=2)

    Worker(session_factory, SETTINGS, runner=_boom_runner)._execute(rid)

    assert len(emails) == 1
    setting, msg = emails[0]
    assert "failed" in setting["subject"]
    assert "Client connection failed" in msg
    assert "OpenD" in msg  # logged-out hint


def test_healthcheck_ping_only_for_scheduled_success(session_factory, holdings_body, monkeypatch):
    _insert_config(session_factory, holdings_body)
    pings = []
    monkeypatch.setattr(Worker, "_ping_healthcheck", lambda self: pings.append(True))
    rid = create_run(session_factory, task_type="holdings", config_name="c1", trigger="schedule", notify=False)
    Worker(session_factory, SETTINGS, runner=_stub_runner)._execute(rid)
    assert pings == [True]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_worker.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'optionality.service.worker'`

- [ ] **Step 3: Implement** — `src/optionality/service/worker.py`

```python
import queue
import threading
import urllib.request
from uuid import uuid4

from sqlalchemy import select

from optionality.core import load_config, run_task, send_notifications
from optionality.notification.gmail import send_gmail_notification
from optionality.service.models import ConfigDoc, Report, Run, utcnow
from optionality.service.settings import Settings

_STOP = "__stop__"


def create_run(session_factory, *, task_type: str, config_name: str, trigger: str, notify: bool, attempt: int = 1) -> str:
    run_id = uuid4().hex
    with session_factory() as session:
        session.add(
            Run(
                id=run_id,
                task_type=task_type,
                config_name=config_name,
                trigger=trigger,
                notify=notify,
                attempt=attempt,
            )
        )
        session.commit()
    return run_id


class Worker(threading.Thread):
    def __init__(self, session_factory, settings: Settings, runner=run_task):
        super().__init__(name="optionality-worker", daemon=True)
        self.session_factory = session_factory
        self.settings = settings
        self.runner = runner
        self.queue: queue.Queue[str] = queue.Queue()

    def submit(self, run_id: str) -> None:
        self.queue.put(run_id)

    def stop(self) -> None:
        self.queue.put(_STOP)
        if self.is_alive():
            self.join(timeout=10)

    def queue_depth(self) -> int:
        return self.queue.qsize()

    def run(self) -> None:
        while True:
            run_id = self.queue.get()
            if run_id == _STOP:
                return
            try:
                self._execute(run_id)
            except Exception:  # a broken job must never kill the worker loop
                pass

    def _execute(self, run_id: str) -> None:
        with self.session_factory() as session:
            run = session.get(Run, run_id)
            if run is None:
                return
            config_row = session.scalar(select(ConfigDoc).where(ConfigDoc.name == run.config_name))
            run.status = "running"
            run.started_at = utcnow()
            session.commit()

        try:
            if config_row is None:
                raise RuntimeError(f"config '{run.config_name}' not found")
            config = load_config(run.task_type, config_row.body)
            result = self.runner(
                run.task_type,
                config,
                opend_host=self.settings.opend_host,
                opend_port=self.settings.opend_port,
            )
        except Exception as err:
            self._handle_failure(run, err)
            return

        with self.session_factory() as session:
            session.add(
                Report(
                    run_id=run.id,
                    summary={"summary": result.summary, "warnings": result.warnings},
                    html=result.html,
                )
            )
            db_run = session.get(Run, run.id)
            db_run.status = "succeeded"
            db_run.finished_at = utcnow()
            session.commit()

        if run.notify:
            try:
                send_notifications(config.notification, result.html)
            except Exception as err:
                with self.session_factory() as session:
                    db_run = session.get(Run, run.id)
                    db_run.error = f"run succeeded but notification failed: {err}"
                    session.commit()

        if run.trigger == "schedule":
            self._ping_healthcheck()

    def _handle_failure(self, run: Run, err: Exception) -> None:
        with self.session_factory() as session:
            db_run = session.get(Run, run.id)
            db_run.status = "failed"
            db_run.error = str(err)
            db_run.finished_at = utcnow()
            session.commit()

        if run.trigger != "schedule":
            return
        if run.attempt == 1:
            retry_id = create_run(
                self.session_factory,
                task_type=run.task_type,
                config_name=run.config_name,
                trigger="schedule",
                notify=run.notify,
                attempt=2,
            )
            self._schedule_retry(self.settings.retry_delay_seconds, retry_id)
        else:
            self._send_failure_email(run, err)

    def _schedule_retry(self, delay: float, run_id: str) -> None:
        timer = threading.Timer(delay, self.submit, args=(run_id,))
        timer.daemon = True
        timer.start()

    def _send_failure_email(self, run: Run, err: Exception) -> None:
        with self.session_factory() as session:
            config_row = session.scalar(select(ConfigDoc).where(ConfigDoc.name == run.config_name))
        if config_row is None:
            return
        try:
            config = load_config(run.task_type, config_row.body)
        except Exception:
            return
        gmail = config.notification.gmail
        if gmail is None:
            return

        hint = ""
        if "connect" in str(err).lower():
            hint = " The OpenD gateway may be logged out or unreachable — check OpenD on the host."
        setting = gmail.model_dump()
        setting["subject"] = f"❌ optionality {run.task_type} run failed"
        message = f"<p>Run <b>{run.id}</b> ({run.task_type} / {run.config_name}) failed after {run.attempt} attempt(s).</p><p>Error: {err}.{hint}</p>"
        try:
            send_gmail_notification(setting, message)
        except Exception:
            pass

    def _ping_healthcheck(self) -> None:
        if not self.settings.healthcheck_url:
            return
        try:
            urllib.request.urlopen(self.settings.healthcheck_url, timeout=10)
        except Exception:
            pass
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_worker.py -v`
Expected: 5 PASS

- [ ] **Step 5: Full suite, lint, commit**

```bash
uv run pytest -v && make format && make lint
git add -A && git commit -m "feat: serialized worker with retry, failure email, dead-man ping"
```

---

### Task 7: Scheduler — cron jobs that enqueue runs

**Files:**
- Create: `src/optionality/service/scheduler.py`
- Test: `tests/test_scheduler.py`

**Interfaces:**
- Consumes: `Schedule` model, `create_run` + `Worker` from worker module.
- Produces (used by app and schedules routes):
  - `validate_cron(expr: str, tz: str) -> None` — raises `ValueError` for bad cron or unknown timezone.
  - `build_scheduler() -> BackgroundScheduler` (not started).
  - `refresh_jobs(scheduler, session_factory, worker) -> int` — replaces all jobs from enabled `Schedule` rows; job ids are `f"schedule-{row.id}"`; returns job count.
  - `fire_schedule(schedule_id, session_factory, worker) -> None` — creates a `trigger="schedule", notify=True` run and submits it.

- [ ] **Step 1: Write the failing tests** — `tests/test_scheduler.py`

```python
import pytest
from sqlalchemy import select

from optionality.service.models import ConfigDoc, Run, Schedule
from optionality.service.scheduler import build_scheduler, fire_schedule, refresh_jobs, validate_cron
from optionality.service.settings import Settings
from optionality.service.worker import Worker


def test_validate_cron():
    validate_cron("35 9 * * mon-fri", "America/New_York")
    with pytest.raises(ValueError):
        validate_cron("not a cron", "America/New_York")
    with pytest.raises(ValueError):
        validate_cron("0 9 * * *", "Mars/Olympus")


def test_refresh_jobs_loads_enabled_only(session_factory, holdings_body):
    with session_factory() as s:
        s.add(ConfigDoc(name="c1", task_type="holdings", body=holdings_body))
        s.add(Schedule(cron_expr="35 9 * * mon-fri", task_type="holdings", config_name="c1", enabled=True))
        s.add(Schedule(cron_expr="0 16 * * mon-fri", task_type="holdings", config_name="c1", enabled=False))
        s.commit()
        enabled_id = s.scalar(select(Schedule).where(Schedule.enabled)).id

    worker = Worker(session_factory, Settings())
    scheduler = build_scheduler()
    count = refresh_jobs(scheduler, session_factory, worker)
    assert count == 1
    assert scheduler.get_job(f"schedule-{enabled_id}") is not None


def test_fire_schedule_creates_and_submits_run(session_factory, holdings_body):
    with session_factory() as s:
        s.add(ConfigDoc(name="c1", task_type="holdings", body=holdings_body))
        sched = Schedule(cron_expr="35 9 * * mon-fri", task_type="holdings", config_name="c1")
        s.add(sched)
        s.commit()
        sched_id = sched.id

    worker = Worker(session_factory, Settings())  # not started; we inspect its queue
    fire_schedule(sched_id, session_factory, worker)

    with session_factory() as s:
        run = s.scalar(select(Run))
        assert run.trigger == "schedule"
        assert run.notify is True
        assert run.task_type == "holdings"
    assert worker.queue_depth() == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_scheduler.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'optionality.service.scheduler'`

- [ ] **Step 3: Implement** — `src/optionality/service/scheduler.py`

```python
from functools import partial
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import select

from optionality.service.models import Schedule
from optionality.service.worker import Worker, create_run


def validate_cron(expr: str, tz: str) -> None:
    _make_trigger(expr, tz)


def _make_trigger(expr: str, tz: str) -> CronTrigger:
    try:
        timezone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, KeyError) as err:
        raise ValueError(f"unknown timezone: {tz}") from err
    try:
        return CronTrigger.from_crontab(expr, timezone=timezone)
    except ValueError as err:
        raise ValueError(f"invalid cron expression '{expr}': {err}") from err


def build_scheduler() -> BackgroundScheduler:
    return BackgroundScheduler(
        job_defaults={"coalesce": True, "max_instances": 1, "misfire_grace_time": 3600},
    )


def fire_schedule(schedule_id: int, session_factory, worker: Worker) -> None:
    with session_factory() as session:
        schedule = session.get(Schedule, schedule_id)
        if schedule is None or not schedule.enabled:
            return
        task_type, config_name = schedule.task_type, schedule.config_name
    run_id = create_run(
        session_factory,
        task_type=task_type,
        config_name=config_name,
        trigger="schedule",
        notify=True,
    )
    worker.submit(run_id)


def refresh_jobs(scheduler: BackgroundScheduler, session_factory, worker: Worker) -> int:
    scheduler.remove_all_jobs()
    with session_factory() as session:
        rows = session.scalars(select(Schedule).where(Schedule.enabled)).all()
    for row in rows:
        scheduler.add_job(
            partial(fire_schedule, row.id, session_factory, worker),
            trigger=_make_trigger(row.cron_expr, row.tz),
            id=f"schedule-{row.id}",
            replace_existing=True,
        )
    return len(rows)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_scheduler.py -v`
Expected: 3 PASS

- [ ] **Step 5: Full suite, lint, commit**

```bash
uv run pytest -v && make format && make lint
git add -A && git commit -m "feat: APScheduler wiring for scheduled runs"
```

---

### Task 8: App factory, bearer-token middleware, health endpoint

**Files:**
- Create: `src/optionality/service/deps.py`
- Create: `src/optionality/service/routes/__init__.py` (empty)
- Create: `src/optionality/service/routes/health.py`
- Create: `src/optionality/service/app.py`
- Modify: `tests/conftest.py` (append app fixtures)
- Test: `tests/test_app.py`

**Interfaces:**
- Consumes: `Settings`, db layer, `Worker`, `build_scheduler`/`refresh_jobs`, `run_task`.
- Produces:
  - `create_app(settings: Settings | None = None, runner=None) -> FastAPI`. `settings=None` → `Settings.from_env()`; `runner=None` → `core.run_task`. App state: `app.state.settings`, `app.state.engine`, `app.state.session_factory`, `app.state.worker`, `app.state.scheduler`. Lifespan starts/stops worker and scheduler and calls `refresh_jobs`.
  - Middleware: every path except `/health` requires header `Authorization: Bearer <settings.api_token>` when `api_token` is non-empty; failure → 401 JSON `{"detail": "unauthorized"}`.
  - `deps.py`: `get_session` (yields ORM `Session` from `app.state.session_factory`), `get_settings`, `get_worker`, `get_scheduler`, `get_session_factory` — all reading `request.app.state`.
  - conftest: `make_client(tmp_path, *, token="tok", runner=_stub_runner) -> TestClient` helper fixture named `client_factory`, and `AUTH = {"Authorization": "Bearer tok"}` module constant importable as `tests.conftest.AUTH`.
  - `GET /health` → `{"db": bool, "opend": bool, "queue_depth": int, "last_run": {...} | null}` (opend = 1-second TCP connect probe).

- [ ] **Step 1: Write the failing tests** — `tests/test_app.py`

```python
def test_health_is_open_and_reports_status(client_factory):
    client = client_factory()
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["db"] is True
    assert data["opend"] is False  # nothing listens on the test port
    assert data["queue_depth"] == 0
    assert data["last_run"] is None


def test_missing_token_is_rejected(client_factory):
    client = client_factory()
    assert client.get("/runs").status_code == 401


def test_valid_token_is_accepted(client_factory):
    from tests.conftest import AUTH

    client = client_factory()
    resp = client.get("/health", headers=AUTH)
    assert resp.status_code == 200
```

(`/runs` 401 works before the runs router exists: the middleware rejects unknown paths before routing returns 404.)

- [ ] **Step 2: Append app fixtures to `tests/conftest.py`**

```python
from fastapi.testclient import TestClient

from optionality.core import RunResult
from optionality.service.settings import Settings

AUTH = {"Authorization": "Bearer tok"}


def _stub_runner(task, config, client_factory=None, opend_host=None, opend_port=None):
    return RunResult(html="<p>stub</p>", summary=[{"strike_date": "2026-12-18"}], warnings=None)


@pytest.fixture
def client_factory(tmp_path):
    from optionality.service.app import create_app

    clients = []

    def make(token="tok", runner=_stub_runner, opend_port=1):
        settings = Settings(db_path=str(tmp_path / "app.db"), api_token=token, opend_port=opend_port)
        client = TestClient(create_app(settings=settings, runner=runner))
        client.__enter__()  # run lifespan (starts worker + scheduler)
        clients.append(client)
        return client

    yield make
    for c in clients:
        c.__exit__(None, None, None)
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_app.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'optionality.service.app'`

- [ ] **Step 4: Implement** — `src/optionality/service/deps.py`

```python
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
```

- [ ] **Step 5: Implement** — `src/optionality/service/routes/health.py`

```python
import socket

from fastapi import APIRouter, Depends
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from optionality.service.deps import get_session, get_settings, get_worker
from optionality.service.models import Run

router = APIRouter(tags=["health"])


def _opend_reachable(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


@router.get("/health")
def health(session: Session = Depends(get_session), settings=Depends(get_settings), worker=Depends(get_worker)):
    try:
        session.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False

    last = session.scalar(select(Run).order_by(Run.created_at.desc()).limit(1))
    last_run = None
    if last is not None:
        last_run = {"id": last.id, "task_type": last.task_type, "status": last.status, "created_at": str(last.created_at)}

    return {
        "db": db_ok,
        "opend": _opend_reachable(settings.opend_host, settings.opend_port),
        "queue_depth": worker.queue_depth(),
        "last_run": last_run,
    }
```

- [ ] **Step 6: Implement** — `src/optionality/service/app.py`

```python
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
        if request.url.path != "/health" and settings.api_token:
            if request.headers.get("Authorization") != f"Bearer {settings.api_token}":
                return JSONResponse(status_code=401, content={"detail": "unauthorized"})
        return await call_next(request)

    app.include_router(health.router)
    return app
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `uv run pytest tests/test_app.py -v`
Expected: 3 PASS

- [ ] **Step 8: Full suite, lint, commit**

```bash
uv run pytest -v && make format && make lint
git add -A && git commit -m "feat: FastAPI app factory with auth middleware and health endpoint"
```

---

### Task 9: Configs CRUD routes

**Files:**
- Create: `src/optionality/service/routes/configs.py`
- Modify: `src/optionality/service/app.py` (add router)
- Test: `tests/test_configs_api.py`

**Interfaces:**
- Consumes: `deps.get_session`, `ConfigDoc`/`Schedule` models, `core.load_config`.
- Produces REST resources (used by user + later tests): request model `ConfigIn(name: str, task_type: Literal["strategy", "holdings"], body: dict)`; endpoints listed in Step 3. Config bodies are validated through `core.load_config` — 422 with the pydantic message on failure.

- [ ] **Step 1: Write the failing tests** — `tests/test_configs_api.py`

```python
from tests.conftest import AUTH


def test_config_crud_roundtrip(client_factory, holdings_body):
    client = client_factory()
    payload = {"name": "spx", "task_type": "holdings", "body": holdings_body}

    assert client.post("/configs", json=payload, headers=AUTH).status_code == 201
    assert client.post("/configs", json=payload, headers=AUTH).status_code == 409  # duplicate

    listed = client.get("/configs", headers=AUTH).json()
    assert [c["name"] for c in listed] == ["spx"]

    got = client.get("/configs/spx", headers=AUTH).json()
    assert got["body"]["code_information"]["name"] == "SPX"

    updated = dict(payload)
    assert client.put("/configs/spx", json=updated, headers=AUTH).status_code == 200
    assert client.delete("/configs/spx", headers=AUTH).status_code == 204
    assert client.get("/configs/spx", headers=AUTH).status_code == 404


def test_invalid_body_rejected(client_factory):
    client = client_factory()
    bad = {"name": "x", "task_type": "holdings", "body": {"nope": True}}
    assert client.post("/configs", json=bad, headers=AUTH).status_code == 422


def test_delete_referenced_by_schedule_conflicts(client_factory, holdings_body):
    client = client_factory()
    client.post("/configs", json={"name": "spx", "task_type": "holdings", "body": holdings_body}, headers=AUTH)

    from optionality.service.models import Schedule

    sf = client.app.state.session_factory
    with sf() as s:
        s.add(Schedule(cron_expr="0 9 * * *", task_type="holdings", config_name="spx"))
        s.commit()

    assert client.delete("/configs/spx", headers=AUTH).status_code == 409
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_configs_api.py -v`
Expected: FAIL — 404s (router not registered / module missing)

- [ ] **Step 3: Implement** — `src/optionality/service/routes/configs.py`

```python
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.core import load_config
from optionality.service.deps import get_session
from optionality.service.models import ConfigDoc, Schedule

router = APIRouter(prefix="/configs", tags=["configs"])


class ConfigIn(BaseModel):
    name: str
    task_type: Literal["strategy", "holdings"]
    body: dict


def _validate_body(task_type: str, body: dict) -> None:
    try:
        load_config(task_type, body)
    except ValidationError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err


def _to_dict(row: ConfigDoc, with_body: bool = False) -> dict:
    data = {
        "name": row.name,
        "task_type": row.task_type,
        "created_at": str(row.created_at),
        "updated_at": str(row.updated_at),
    }
    if with_body:
        data["body"] = row.body
    return data


@router.get("")
def list_configs(session: Session = Depends(get_session)):
    rows = session.scalars(select(ConfigDoc).order_by(ConfigDoc.name)).all()
    return [_to_dict(r) for r in rows]


@router.post("", status_code=201)
def create_config(payload: ConfigIn, session: Session = Depends(get_session)):
    _validate_body(payload.task_type, payload.body)
    if session.scalar(select(ConfigDoc).where(ConfigDoc.name == payload.name)):
        raise HTTPException(status_code=409, detail=f"config '{payload.name}' already exists")
    row = ConfigDoc(name=payload.name, task_type=payload.task_type, body=payload.body)
    session.add(row)
    session.commit()
    return _to_dict(row, with_body=True)


@router.get("/{name}")
def get_config(name: str, session: Session = Depends(get_session)):
    row = session.scalar(select(ConfigDoc).where(ConfigDoc.name == name))
    if row is None:
        raise HTTPException(status_code=404, detail="config not found")
    return _to_dict(row, with_body=True)


@router.put("/{name}")
def update_config(name: str, payload: ConfigIn, session: Session = Depends(get_session)):
    row = session.scalar(select(ConfigDoc).where(ConfigDoc.name == name))
    if row is None:
        raise HTTPException(status_code=404, detail="config not found")
    _validate_body(payload.task_type, payload.body)
    row.task_type = payload.task_type
    row.body = payload.body
    session.commit()
    return _to_dict(row, with_body=True)


@router.delete("/{name}", status_code=204)
def delete_config(name: str, session: Session = Depends(get_session)):
    row = session.scalar(select(ConfigDoc).where(ConfigDoc.name == name))
    if row is None:
        raise HTTPException(status_code=404, detail="config not found")
    if session.scalar(select(Schedule).where(Schedule.config_name == name)):
        raise HTTPException(status_code=409, detail="config is referenced by a schedule")
    session.delete(row)
    session.commit()
```

- [ ] **Step 4: Register the router** — in `src/optionality/service/app.py`, change the routes import and registration:

```python
from optionality.service.routes import configs, health
```

and after `app.include_router(health.router)` add:

```python
    app.include_router(configs.router)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_configs_api.py -v`
Expected: 3 PASS

- [ ] **Step 6: Full suite, lint, commit**

```bash
uv run pytest -v && make format && make lint
git add -A && git commit -m "feat: configs CRUD endpoints"
```

---

### Task 10: Schedules CRUD routes

**Files:**
- Create: `src/optionality/service/routes/schedules.py`
- Modify: `src/optionality/service/app.py` (add router)
- Test: `tests/test_schedules_api.py`

**Interfaces:**
- Consumes: `deps` (session, session_factory, worker, scheduler), `Schedule`/`ConfigDoc` models, `validate_cron`, `refresh_jobs`.
- Produces: request model `ScheduleIn(cron_expr: str, tz: str = "America/New_York", task_type: Literal["strategy", "holdings"], config_name: str, enabled: bool = True)`; endpoints `GET/POST /schedules`, `PUT/DELETE /schedules/{id}`. Every mutation calls `refresh_jobs` so the live scheduler always mirrors the table.

- [ ] **Step 1: Write the failing tests** — `tests/test_schedules_api.py`

```python
from tests.conftest import AUTH


def _mk_config(client, holdings_body):
    client.post("/configs", json={"name": "spx", "task_type": "holdings", "body": holdings_body}, headers=AUTH)


def test_schedule_crud_and_live_refresh(client_factory, holdings_body):
    client = client_factory()
    _mk_config(client, holdings_body)
    payload = {"cron_expr": "35 9 * * mon-fri", "task_type": "holdings", "config_name": "spx"}

    created = client.post("/schedules", json=payload, headers=AUTH)
    assert created.status_code == 201
    sid = created.json()["id"]
    assert client.app.state.scheduler.get_job(f"schedule-{sid}") is not None

    listed = client.get("/schedules", headers=AUTH).json()
    assert listed[0]["tz"] == "America/New_York"

    payload["enabled"] = False
    assert client.put(f"/schedules/{sid}", json=payload, headers=AUTH).status_code == 200
    assert client.app.state.scheduler.get_job(f"schedule-{sid}") is None

    assert client.delete(f"/schedules/{sid}", headers=AUTH).status_code == 204
    assert client.get("/schedules", headers=AUTH).json() == []


def test_bad_cron_and_unknown_config_rejected(client_factory, holdings_body):
    client = client_factory()
    _mk_config(client, holdings_body)
    bad_cron = {"cron_expr": "nope", "task_type": "holdings", "config_name": "spx"}
    assert client.post("/schedules", json=bad_cron, headers=AUTH).status_code == 422
    no_cfg = {"cron_expr": "0 9 * * *", "task_type": "holdings", "config_name": "ghost"}
    assert client.post("/schedules", json=no_cfg, headers=AUTH).status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_schedules_api.py -v`
Expected: FAIL — 404s

- [ ] **Step 3: Implement** — `src/optionality/service/routes/schedules.py`

```python
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.service.deps import get_scheduler, get_session, get_session_factory, get_worker
from optionality.service.models import ConfigDoc, Schedule
from optionality.service.scheduler import refresh_jobs, validate_cron

router = APIRouter(prefix="/schedules", tags=["schedules"])


class ScheduleIn(BaseModel):
    cron_expr: str
    tz: str = "America/New_York"
    task_type: Literal["strategy", "holdings"]
    config_name: str
    enabled: bool = True


def _validate(payload: ScheduleIn, session: Session) -> None:
    try:
        validate_cron(payload.cron_expr, payload.tz)
    except ValueError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err
    if not session.scalar(select(ConfigDoc).where(ConfigDoc.name == payload.config_name)):
        raise HTTPException(status_code=422, detail=f"config '{payload.config_name}' does not exist")


def _to_dict(row: Schedule) -> dict:
    return {
        "id": row.id,
        "cron_expr": row.cron_expr,
        "tz": row.tz,
        "task_type": row.task_type,
        "config_name": row.config_name,
        "enabled": row.enabled,
    }


@router.get("")
def list_schedules(session: Session = Depends(get_session)):
    return [_to_dict(r) for r in session.scalars(select(Schedule).order_by(Schedule.id)).all()]


@router.post("", status_code=201)
def create_schedule(
    payload: ScheduleIn,
    session: Session = Depends(get_session),
    session_factory=Depends(get_session_factory),
    scheduler=Depends(get_scheduler),
    worker=Depends(get_worker),
):
    _validate(payload, session)
    row = Schedule(**payload.model_dump())
    session.add(row)
    session.commit()
    refresh_jobs(scheduler, session_factory, worker)
    return _to_dict(row)


@router.put("/{schedule_id}")
def update_schedule(
    schedule_id: int,
    payload: ScheduleIn,
    session: Session = Depends(get_session),
    session_factory=Depends(get_session_factory),
    scheduler=Depends(get_scheduler),
    worker=Depends(get_worker),
):
    row = session.get(Schedule, schedule_id)
    if row is None:
        raise HTTPException(status_code=404, detail="schedule not found")
    _validate(payload, session)
    for field, value in payload.model_dump().items():
        setattr(row, field, value)
    session.commit()
    refresh_jobs(scheduler, session_factory, worker)
    return _to_dict(row)


@router.delete("/{schedule_id}", status_code=204)
def delete_schedule(
    schedule_id: int,
    session: Session = Depends(get_session),
    session_factory=Depends(get_session_factory),
    scheduler=Depends(get_scheduler),
    worker=Depends(get_worker),
):
    row = session.get(Schedule, schedule_id)
    if row is None:
        raise HTTPException(status_code=404, detail="schedule not found")
    session.delete(row)
    session.commit()
    refresh_jobs(scheduler, session_factory, worker)
```

- [ ] **Step 4: Register the router** — in `src/optionality/service/app.py`:

```python
from optionality.service.routes import configs, health, schedules
```

and add after the existing `include_router` lines:

```python
    app.include_router(schedules.router)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_schedules_api.py -v`
Expected: 2 PASS

- [ ] **Step 6: Full suite, lint, commit**

```bash
uv run pytest -v && make format && make lint
git add -A && git commit -m "feat: schedules CRUD endpoints with live scheduler refresh"
```

---

### Task 11: Runs routes — trigger, status, reports (end-to-end)

**Files:**
- Create: `src/optionality/service/routes/runs.py`
- Modify: `src/optionality/service/app.py` (add router)
- Test: `tests/test_runs_api.py`

**Interfaces:**
- Consumes: `deps`, `Run`/`Report`/`ConfigDoc` models, `create_run` + worker, `full_html_document`.
- Produces: request model `RunIn(task: Literal["strategy", "holdings"], config: str, notify: bool = False)`; endpoints `POST /runs` (202, `{"run_id", "status"}`), `GET /runs?status=&limit=`, `GET /runs/{run_id}`, `GET /runs/{run_id}/report` (the stored summary JSON), `GET /runs/{run_id}/report.html` (full HTML document).

- [ ] **Step 1: Write the failing tests** — `tests/test_runs_api.py`

```python
import time

from tests.conftest import AUTH


def _mk_config(client, holdings_body):
    client.post("/configs", json={"name": "spx", "task_type": "holdings", "body": holdings_body}, headers=AUTH)


def _wait_terminal(client, run_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.get(f"/runs/{run_id}", headers=AUTH).json()["status"]
        if status in ("succeeded", "failed"):
            return status
        time.sleep(0.05)
    raise AssertionError("run did not finish in time")


def test_trigger_run_end_to_end(client_factory, holdings_body):
    client = client_factory()  # stub runner from conftest
    _mk_config(client, holdings_body)

    resp = client.post("/runs", json={"task": "holdings", "config": "spx"}, headers=AUTH)
    assert resp.status_code == 202
    run_id = resp.json()["run_id"]

    assert _wait_terminal(client, run_id) == "succeeded"

    report = client.get(f"/runs/{run_id}/report", headers=AUTH).json()
    assert report["summary"] == [{"strike_date": "2026-12-18"}]

    html = client.get(f"/runs/{run_id}/report.html", headers=AUTH)
    assert html.status_code == 200
    assert html.headers["content-type"].startswith("text/html")
    assert "<p>stub</p>" in html.text

    runs = client.get("/runs?status=succeeded", headers=AUTH).json()
    assert runs[0]["id"] == run_id


def test_unknown_config_404_and_task_mismatch_422(client_factory, holdings_body):
    client = client_factory()
    _mk_config(client, holdings_body)
    assert client.post("/runs", json={"task": "holdings", "config": "ghost"}, headers=AUTH).status_code == 404
    assert client.post("/runs", json={"task": "strategy", "config": "spx"}, headers=AUTH).status_code == 422


def test_report_404_before_completion(client_factory, holdings_body):
    client = client_factory()
    _mk_config(client, holdings_body)
    assert client.get("/runs/doesnotexist/report", headers=AUTH).status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_runs_api.py -v`
Expected: FAIL — 404s

- [ ] **Step 3: Implement** — `src/optionality/service/routes/runs.py`

```python
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.notification import full_html_document
from optionality.service.deps import get_session, get_session_factory, get_worker
from optionality.service.models import ConfigDoc, Report, Run
from optionality.service.worker import create_run

router = APIRouter(prefix="/runs", tags=["runs"])


class RunIn(BaseModel):
    task: Literal["strategy", "holdings"]
    config: str
    notify: bool = False


def _to_dict(row: Run) -> dict:
    return {
        "id": row.id,
        "task_type": row.task_type,
        "config_name": row.config_name,
        "trigger": row.trigger,
        "notify": row.notify,
        "attempt": row.attempt,
        "status": row.status,
        "error": row.error,
        "created_at": str(row.created_at),
        "started_at": str(row.started_at) if row.started_at else None,
        "finished_at": str(row.finished_at) if row.finished_at else None,
    }


@router.post("", status_code=202)
def trigger_run(
    payload: RunIn,
    session: Session = Depends(get_session),
    session_factory=Depends(get_session_factory),
    worker=Depends(get_worker),
):
    config = session.scalar(select(ConfigDoc).where(ConfigDoc.name == payload.config))
    if config is None:
        raise HTTPException(status_code=404, detail=f"config '{payload.config}' not found")
    if config.task_type != payload.task:
        raise HTTPException(
            status_code=422,
            detail=f"config '{payload.config}' is a '{config.task_type}' config, not '{payload.task}'",
        )
    run_id = create_run(
        session_factory,
        task_type=payload.task,
        config_name=payload.config,
        trigger="api",
        notify=payload.notify,
    )
    worker.submit(run_id)
    return {"run_id": run_id, "status": "queued"}


@router.get("")
def list_runs(status: str | None = None, limit: int = 50, session: Session = Depends(get_session)):
    query = select(Run).order_by(Run.created_at.desc()).limit(min(limit, 500))
    if status:
        query = query.where(Run.status == status)
    return [_to_dict(r) for r in session.scalars(query).all()]


@router.get("/{run_id}")
def get_run(run_id: str, session: Session = Depends(get_session)):
    row = session.get(Run, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    return _to_dict(row)


def _get_report(run_id: str, session: Session) -> Report:
    report = session.get(Report, run_id)
    if report is None:
        raise HTTPException(status_code=404, detail="report not found")
    return report


@router.get("/{run_id}/report")
def get_report(run_id: str, session: Session = Depends(get_session)):
    return _get_report(run_id, session).summary


@router.get("/{run_id}/report.html")
def get_report_html(run_id: str, session: Session = Depends(get_session)):
    return HTMLResponse(full_html_document(_get_report(run_id, session).html))
```

- [ ] **Step 4: Register the router** — in `src/optionality/service/app.py`:

```python
from optionality.service.routes import configs, health, runs, schedules
```

and add:

```python
    app.include_router(runs.router)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_runs_api.py -v`
Expected: 3 PASS (the end-to-end test exercises the real worker thread with the stub runner)

- [ ] **Step 6: Full suite, lint, commit**

```bash
uv run pytest -v && make format && make lint
git add -A && git commit -m "feat: run trigger/status/report endpoints"
```

---

### Task 12: Deployment — Docker, compose, env template, README runbook

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Modify: `.gitignore` (ensure `.env`, `data/` ignored)
- Modify: `README.md` (append service section)

**Interfaces:**
- Consumes: `make serve` target (Task 1), `create_app` factory.
- Produces: a runnable stack. `api` always runs in Docker; `opend` runs either in Docker (Linux host, `--profile opend-docker`) or on the host OS (macOS, `OPEND_HOST=host.docker.internal`).

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY . .
RUN uv sync --frozen --no-dev

ENV OPTIONALITY_DB_PATH=/app/data/optionality.db

EXPOSE 8000

CMD ["uv", "run", "--no-dev", "uvicorn", "--factory", "optionality.service.app:create_app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  api:
    build: .
    env_file: .env
    environment:
      OPEND_HOST: ${OPEND_HOST:-host.docker.internal}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "8000:8000"
    volumes:
      - ./data:/app/data
    restart: unless-stopped

  # Linux hosts only: put the extracted moomoo OpenD Ubuntu build in ./opend
  # (download from moomoo's OpenAPI page; includes the OpenD binary and OpenD.xml).
  # Start with: docker compose --profile opend-docker up -d
  # First login may require a verification code: docker attach optionality-opend
  opend:
    profiles: ["opend-docker"]
    image: ubuntu:24.04
    container_name: optionality-opend
    working_dir: /opt/opend
    volumes:
      - ./opend:/opt/opend
    command: ["./OpenD"]
    stdin_open: true
    tty: true
    restart: unless-stopped
```

- [ ] **Step 3: Create `.env.example`**

```bash
# API auth token required in the Authorization: Bearer header (generate: openssl rand -hex 24)
API_TOKEN=

# Gmail app password credentials (https://myaccount.google.com/apppasswords)
GMAIL_USER=
GMAIL_APP_PASSWORD=

# healthchecks.io ping URL for the dead-man's switch (optional but recommended)
HEALTHCHECK_URL=

# Where the api container reaches OpenD:
#   - OpenD on the host (macOS or bare-metal): host.docker.internal
#   - OpenD in Docker (Linux, --profile opend-docker): opend
OPEND_HOST=host.docker.internal
OPEND_PORT=11111
```

- [ ] **Step 4: Ensure `.gitignore` covers secrets and data** — append if missing:

```
.env
data/
opend/
output_holdings.html
```

- [ ] **Step 5: Append service section to `README.md`**

```markdown
## Hosted service

Run optionality as an always-on service: scheduled scans email HTML reports; ad-hoc runs are triggered over the API (expose it inside your tailnet only, e.g. with `tailscale serve`).

### Setup

1. `cp .env.example .env` and fill in the values.
2. Start OpenD:
   - **macOS / bare-metal host:** run OpenD on the host, keep `OPEND_HOST=host.docker.internal`.
   - **Linux host, Docker:** extract the OpenD Ubuntu build into `./opend`, set `OPEND_HOST=opend`, add `--profile opend-docker` to compose commands. First login may prompt for a verification code: `docker attach optionality-opend`.
3. `docker compose up -d --build`
4. Health check: `curl http://localhost:8000/health` — `"opend": true` means the gateway is reachable.

### Everyday use

```bash
AUTH="Authorization: Bearer $API_TOKEN"
# store a config (body = the YAML document as JSON)
curl -X POST localhost:8000/configs -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name": "spx-holdings", "task_type": "holdings", "body": {...}}'
# schedule it for 09:35 ET every weekday
curl -X POST localhost:8000/schedules -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"cron_expr": "35 9 * * mon-fri", "task_type": "holdings", "config_name": "spx-holdings"}'
# ad-hoc run + report
curl -X POST localhost:8000/runs -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"task": "holdings", "config": "spx-holdings"}'
curl localhost:8000/runs/<run_id>/report.html -H "$AUTH"
```

### Runbook

- **Scheduled reports stopped and healthchecks.io alerted:** check `docker compose ps`, then `curl :8000/health`. If `"opend": false`, OpenD is down or logged out — restart/re-login it (this is the most common failure).
- **Failure email arrived:** the run failed twice (one automatic retry). The email includes the error; `GET /runs?status=failed` has details.
- **Debugging the pipeline without the service:** `uv run python main.py -t holdings -f examples/strategy.yaml` uses the same core code against a local OpenD.
- **Schema changes:** `uv run alembic revision --autogenerate -m "..."` then `uv run alembic upgrade head` (fresh databases are created automatically at startup).
```

- [ ] **Step 6: Verify the image builds and compose validates**

```bash
docker build -t optionality-api .
docker compose config -q
```

Expected: image builds; compose config exits 0. (Full stack bring-up needs a logged-in OpenD — that's the deploy step on the box, not CI.)

- [ ] **Step 7: Smoke-test the container without OpenD**

```bash
touch .env.ci && docker run --rm -d -p 8001:8000 --env-file .env.ci --name opt-smoke optionality-api
sleep 3 && curl -s http://localhost:8001/health
docker rm -f opt-smoke && rm .env.ci
```

Expected: JSON with `"db": true, "opend": false`.

- [ ] **Step 8: Lint, commit**

```bash
make format && make lint
git add -A && git commit -m "feat: docker compose deployment with OpenD profiles and runbook"
```

---

## Self-Review Notes

- **Spec coverage:** product = scheduler + on-demand API (Tasks 6–11); home-box compose + Tailscale note (Task 12); APScheduler + single serialized worker (Tasks 6–8); SQLite WAL + JSON-document configs + relational schedules/runs/reports (Task 4); Alembic (Task 5); full endpoint surface incl. `report.html`, tz-aware schedules, bearer token, open `/health` (Tasks 8–11); retry-once + failure email + dead-man ping (Task 6); env-only secrets (Tasks 1–2); thin CLI survives (Task 3); retention = keep everything (no pruning code anywhere — intentional).
- **Type consistency:** `create_run(session_factory, *, task_type, config_name, trigger, notify, attempt) -> str` used identically in worker, scheduler, runs routes. `Settings` fields consistent across worker/health/app. `RunResult(html, summary, warnings)` consistent across core/worker/conftest stubs. Job ids `schedule-{id}` consistent between scheduler and schedules tests.
- **Known deliberate choices:** `create_all` at startup + Alembic for future changes (documented in README); worker tests call `_execute` directly for determinism; ad-hoc failed runs surface via API only (no email) per the agreed design.
