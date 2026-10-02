"""The run pipeline, as a subprocess the TypeScript service calls (ADR 0009, phase 6c).

The strategy and holdings scans stay in Python. Porting them would mean replacing pandas, the option
chain scan and yfinance — around 614 lines across four pandas modules — for a feature that has run
twice, both on 2026-08-10, with no schedule configured. The sweep runs every sixty seconds. So this
is the boundary: everything that needs pandas or an SMTP login stays here, and the TypeScript service
owns the queue, the run lifecycle and the alarms.

    python -m optionality.runner <request.json> <response.json>

Request and response are files, not stdin and stdout. The moomoo SDK writes its own connect and
disconnect lines to stdout, and a JSON document sharing a pipe with them is a JSON document that
sometimes does not parse.

    request   {"mode": "run",   "task": ..., "config": {...}, "notify": bool,
               "opend_host": ..., "opend_port": ...}
              {"mode": "alert", "task": ..., "config": {...}, "subject": ..., "message": ...}
    response  {"ok": true,  "html": ..., "summary": [...], "warnings": [...] | null,
               "details": [...], "notify_error": str | null}
              {"ok": false, "error": "..."}

A non-zero exit means the process itself failed and the response file may not exist; `ok: false` means
it ran and the task did not. The caller needs to tell those apart, because only the second is a run
whose error is worth showing.
"""

import json
import sys
import traceback

from optionality.core import load_config, run_task, send_notifications
from optionality.notification.gmail import send_gmail_notification


def _run(request: dict) -> dict:
    config = load_config(request["task"], request["config"])
    result = run_task(
        request["task"],
        config,
        opend_host=request.get("opend_host", "127.0.0.1"),
        opend_port=int(request.get("opend_port", 11111)),
    )
    # the notification travels with the run: it needs the same config object and the same senders,
    # and a second crossing of this boundary to send it would be a second place to get wrong
    notify_error = None
    if request.get("notify"):
        try:
            send_notifications(config.notification, result.html)
        except Exception as err:  # noqa: BLE001 - a sent report must survive an unsent email
            notify_error = str(err)
    return {
        "ok": True,
        "html": result.html,
        "summary": result.summary,
        "warnings": result.warnings,
        "details": result.details,
        "notify_error": notify_error,
    }


def _alert(request: dict) -> dict:
    """The failure email. Here rather than in TypeScript because it is SMTP with a Gmail app
    password, and the alternative is a mail dependency in a service that has four."""
    config = load_config(request["task"], request["config"])
    gmail = config.notification.gmail
    if gmail is None:
        return {"ok": True, "sent": False, "reason": "the config carries no gmail block"}
    setting = gmail.model_dump()
    setting["subject"] = request["subject"]
    send_gmail_notification(setting, request["message"])
    return {"ok": True, "sent": True}


MODES = {"run": _run, "alert": _alert}


def main() -> int:
    with open(sys.argv[1]) as f:
        request = json.load(f)
    try:
        response = MODES[request["mode"]](request)
    except Exception as err:  # noqa: BLE001 - every failure is a run result, not a crash
        response = {
            "ok": False,
            "error": str(err),
            # the traceback goes to stderr, where the caller logs it; the message is what the owner
            # reads on the run, and a traceback in that field is unreadable on a phone
            "type": type(err).__name__,
        }
        traceback.print_exc(file=sys.stderr)
    with open(sys.argv[2], "w") as f:
        json.dump(response, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
