from .gmail import send_gmail_notification
from .file import save_as_local_file
from .html_maker import build_html_message

notification_funcs = {
    "gmail": send_gmail_notification,
    "file": save_as_local_file,
}

__all__ = [
    "build_html_message",
    "notification_funcs"
]