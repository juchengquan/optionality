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
