from optionality.service.settings import Settings


def test_defaults():
    s = Settings()
    assert s.opend_host == "127.0.0.1"
    assert s.opend_port == 11111
    assert s.api_token == ""
    assert s.retry_delay_seconds == 300
    assert s.db_path == "data/optionality.db"
    assert s.monitor_interval_seconds == 60
    assert s.alarm_cooldown_seconds == 120
    assert s.ui_refresh_seconds == 30
    assert s.degraded_after_failures == 5
    assert s.telegram_bot_token == ""
    assert s.telegram_chat_id == ""


def test_monitor_and_telegram_from_env(monkeypatch):
    monkeypatch.setenv("MONITOR_INTERVAL_SECONDS", "30")
    monkeypatch.setenv("ALARM_COOLDOWN_SECONDS", "60")
    monkeypatch.setenv("UI_REFRESH_SECONDS", "15")
    monkeypatch.setenv("DEGRADED_AFTER_FAILURES", "3")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "tok")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    monkeypatch.setenv("DISPLAY_TZ", "Asia/Singapore")
    s = Settings.from_env()
    assert s.monitor_interval_seconds == 30
    assert s.alarm_cooldown_seconds == 60
    assert s.ui_refresh_seconds == 15
    assert s.degraded_after_failures == 3
    assert s.telegram_bot_token == "tok"
    assert s.telegram_chat_id == "42"
    assert s.display_tz == "Asia/Singapore"


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
