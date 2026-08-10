from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import JSON, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def random_id() -> str:
    return uuid4().hex


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


class Monitor(Base):
    __tablename__ = "monitors"
    __table_args__ = (UniqueConstraint("code", "field", name="uq_monitor_code_field"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=random_id)
    code: Mapped[str] = mapped_column(String(50), index=True)
    strike_date: Mapped[str] = mapped_column(String(10))
    option_type: Mapped[str] = mapped_column(String(4))
    strike: Mapped[float]
    field: Mapped[str] = mapped_column(String(50), default="option_delta")
    threshold: Mapped[float]
    direction: Mapped[str] = mapped_column(String(5), default="above", server_default="above")  # "above" | "below"
    enabled: Mapped[bool] = mapped_column(default=True)
    triggered: Mapped[bool] = mapped_column(default=False)
    last_value: Mapped[float | None] = mapped_column(default=None)
    last_checked_at: Mapped[datetime | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class Report(Base):
    __tablename__ = "reports"

    run_id: Mapped[str] = mapped_column(String(32), ForeignKey("runs.id"), primary_key=True)
    summary: Mapped[dict] = mapped_column(JSON)
    html: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
