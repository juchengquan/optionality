import logging
import queue
import threading
import urllib.request
from uuid import uuid4

from sqlalchemy import select

from optionality.core import load_config, run_task, send_notifications
from optionality.notification.gmail import send_gmail_notification
from optionality.notification.telegram import send_telegram_message
from optionality.service.models import ConfigDoc, Report, Run, utcnow
from optionality.service.settings import Settings

_STOP = "__stop__"

logger = logging.getLogger("optionality.worker")


def create_run(
    session_factory, *, task_type: str, config_name: str, trigger: str, notify: bool, attempt: int = 1
) -> str:
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
                logger.exception("run %s crashed outside job error handling", run_id)

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
                    summary={"summary": result.summary, "warnings": result.warnings, "details": result.details},
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
            self._send_failure_alert(run, err)

    def _schedule_retry(self, delay: float, run_id: str) -> None:
        timer = threading.Timer(delay, self.submit, args=(run_id,))
        timer.daemon = True
        timer.start()

    def _send_failure_alert(self, run: Run, err: Exception) -> None:
        hint = ""
        if "connect" in str(err).lower():
            hint = " The OpenD gateway may be logged out or unreachable — check OpenD on the host."

        if self.settings.telegram_bot_token and self.settings.telegram_chat_id:
            text = f"❌ optionality {run.task_type} run failed ({run.config_name}, attempt {run.attempt}): {err}.{hint}"
            try:
                send_telegram_message(self.settings.telegram_bot_token, self.settings.telegram_chat_id, text)
            except Exception:
                logger.exception("telegram failure alert for run %s could not be sent", run.id)

        # gmail alert additionally, when the config carries a gmail block
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

        setting = gmail.model_dump()
        setting["subject"] = f"❌ optionality {run.task_type} run failed"
        message = (
            f"<p>Run <b>{run.id}</b> ({run.task_type} / {run.config_name}) failed "
            f"after {run.attempt} attempt(s).</p><p>Error: {err}.{hint}</p>"
        )
        try:
            send_gmail_notification(setting, message)
        except Exception:
            logger.exception("failure email for run %s could not be sent", run.id)

    def _ping_healthcheck(self) -> None:
        if not self.settings.healthcheck_url:
            return
        try:
            urllib.request.urlopen(self.settings.healthcheck_url, timeout=10)
        except Exception:
            logger.warning("healthcheck ping failed")
