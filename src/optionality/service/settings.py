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
    monitor_interval_seconds: int = 60
    alarm_cooldown_seconds: int = 120  # min gap between a monitor's telegram messages (flap protection)
    alarm_repeat_seconds: int = 1800  # reminder cadence while a breach persists; 0 disables reminders
    ui_refresh_seconds: int = 30  # dashboard live-region poll interval
    degraded_after_failures: int = 5  # consecutive sweep failures before the degraded telegram alert
    expired_retention_days: int = 7  # muted-expired monitors are auto-deleted this many days after expiry
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    root_path: str = ""  # URL prefix when served behind a path-stripping reverse proxy, e.g. "/api"
    display_tz: str = ""  # timezone for displayed timestamps, e.g. "Asia/Singapore"; empty = host timezone

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            db_path=os.environ.get("OPTIONALITY_DB_PATH", cls.db_path),
            opend_host=os.environ.get("OPEND_HOST", cls.opend_host),
            opend_port=int(os.environ.get("OPEND_PORT", cls.opend_port)),
            api_token=os.environ.get("API_TOKEN", cls.api_token),
            healthcheck_url=os.environ.get("HEALTHCHECK_URL", cls.healthcheck_url),
            retry_delay_seconds=int(os.environ.get("RETRY_DELAY_SECONDS", cls.retry_delay_seconds)),
            monitor_interval_seconds=int(os.environ.get("MONITOR_INTERVAL_SECONDS", cls.monitor_interval_seconds)),
            alarm_cooldown_seconds=int(os.environ.get("ALARM_COOLDOWN_SECONDS", cls.alarm_cooldown_seconds)),
            alarm_repeat_seconds=int(os.environ.get("ALARM_REPEAT_SECONDS", cls.alarm_repeat_seconds)),
            ui_refresh_seconds=int(os.environ.get("UI_REFRESH_SECONDS", cls.ui_refresh_seconds)),
            degraded_after_failures=int(os.environ.get("DEGRADED_AFTER_FAILURES", cls.degraded_after_failures)),
            expired_retention_days=int(os.environ.get("EXPIRED_RETENTION_DAYS", cls.expired_retention_days)),
            telegram_bot_token=os.environ.get("TELEGRAM_BOT_TOKEN", cls.telegram_bot_token),
            telegram_chat_id=os.environ.get("TELEGRAM_CHAT_ID", cls.telegram_chat_id),
            root_path=os.environ.get("ROOT_PATH", cls.root_path),
            display_tz=os.environ.get("DISPLAY_TZ", cls.display_tz),
        )
