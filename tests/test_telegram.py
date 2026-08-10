import pytest

import optionality.notification.telegram as tg


class FakeResp:
    def __init__(self, body: bytes):
        self.body = body

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_send_telegram_message_posts(monkeypatch):
    captured = {}

    def fake_urlopen(url, data=None, timeout=None):
        captured["url"] = url
        captured["data"] = data
        return FakeResp(b'{"ok": true}')

    monkeypatch.setattr(tg.urllib.request, "urlopen", fake_urlopen)
    tg.send_telegram_message("TOK", "42", "hello world")
    assert "botTOK/sendMessage" in captured["url"]
    assert b"chat_id=42" in captured["data"]
    assert b"hello+world" in captured["data"]


def test_send_telegram_message_raises_on_not_ok(monkeypatch):
    monkeypatch.setattr(
        tg.urllib.request,
        "urlopen",
        lambda url, data=None, timeout=None: FakeResp(b'{"ok": false, "description": "bad token"}'),
    )
    with pytest.raises(RuntimeError, match="bad token"):
        tg.send_telegram_message("TOK", "42", "x")
