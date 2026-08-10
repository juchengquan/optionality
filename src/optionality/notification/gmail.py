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
