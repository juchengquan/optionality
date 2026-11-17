"""`PATCH /settings`: the sweep's interval, set from the page (#442, ADR 0025). Port of
backend/src/entrypoints/http/routes/settings.test.ts."""

from datetime import UTC, datetime

import pytest
from harness import json_body

from optionality_backend.db.queries import read_sweep_interval

#: `.env` sweeps every 15s, as the live one does.
ENV_15 = {"monitor_interval_seconds": 15}
PRESETS = [5, 10, 15, 30, 60]


@pytest.fixture
def begin(start):
    return lambda: start(settings=ENV_15)


async def patch(h, payload, *, anonymous=False):
    return await h.call("/settings", **{**json_body(payload), "method": "PATCH", "anonymous": anonymous})


class TestChoosingTheSweepsInterval:
    async def test_stores_a_preset_and_answers_the_interval_now_in_force(self, begin):
        h = begin()
        h.now = datetime(2026, 11, 17, 10, 0, 0, tzinfo=UTC)
        resp = await patch(h, {"sweep_seconds": 5})
        assert resp.status_code == 200
        assert resp.json() == {
            "sweep_seconds": 5,
            "sweep_source": "settings",
            "sweep_default_seconds": 15,
            "sweep_presets": PRESETS,
            "sweep_refused": None,
        }
        assert read_sweep_interval(h.db) == {"id": 1, "seconds": 5, "set_at": "2026-11-17 10:00:00.000000"}

    async def test_goes_back_to_env_s_on_null_by_deleting_the_choice(self, begin):
        h = begin()
        await patch(h, {"sweep_seconds": 60})
        resp = await patch(h, {"sweep_seconds": None})
        assert resp.status_code == 200
        assert resp.json() == {
            "sweep_seconds": 15,
            "sweep_source": "env",
            "sweep_default_seconds": 15,
            "sweep_presets": PRESETS,
            "sweep_refused": None,
        }
        assert read_sweep_interval(h.db) is None

    async def test_refuses_anything_but_a_preset_or_null_in_zod_s_words_and_stores_nothing(self, begin):
        h = begin()
        for refused in [
            {"sweep_seconds": 7},
            {"sweep_seconds": 2},
            {"sweep_seconds": "5"},
            {"sweep_seconds": True},
            {},
        ]:
            resp = await patch(h, refused)
            assert resp.status_code == 422, refused
            assert resp.json()["detail"] == "✖ Invalid option: expected one of 5|10|15|30|60\n  → at sweep_seconds"
        assert read_sweep_interval(h.db) is None

    async def test_needs_the_token_as_every_write_does(self, begin):
        h = begin()
        resp = await patch(h, {"sweep_seconds": 5}, anonymous=True)
        assert resp.status_code == 401
        assert read_sweep_interval(h.db) is None


class TestHealthsSweepInterval:
    async def test_is_env_s_said_to_be_with_the_default_and_the_presets_beside_it(self, begin):
        h = begin()
        data = (await h.call("/health", anonymous=True)).json()
        assert (
            data["settings"]
            | {
                "sweep_seconds": 15,
                "sweep_source": "env",
                "sweep_default_seconds": 15,
                "sweep_presets": PRESETS,
            }
            == data["settings"]
        )

    async def test_is_the_page_s_choice_the_moment_it_is_made_with_no_restart(self, begin):
        h = begin()
        await patch(h, {"sweep_seconds": 30})
        data = (await h.call("/health", anonymous=True)).json()
        assert data["settings"]["sweep_seconds"] == 30
        assert data["settings"]["sweep_source"] == "settings"
        assert data["settings"]["sweep_default_seconds"] == 15

    async def test_is_env_s_when_the_stored_value_was_edited_by_hand_to_something_not_a_preset(self, begin):
        h = begin()
        h.db.execute("insert into sweep_interval values (1, 2, '2026-11-17 10:00:00.000000')")
        data = (await h.call("/health", anonymous=True)).json()
        assert data["settings"]["sweep_seconds"] == 15
        assert data["settings"]["sweep_source"] == "env"
        assert data["settings"]["sweep_refused"] == "2"


class TestWhatOnlyThePythonCanGetWrong:
    async def test_a_float_preset_is_the_preset_as_javascript_s_set_compares_it(self, begin):
        # JSON's `5.0` is JavaScript's 5, which zod's literal accepts: stored as the integer
        h = begin()
        resp = await h.call(
            "/settings", method="PATCH", content='{"sweep_seconds":5.0}', headers={"Content-Type": "application/json"}
        )
        assert resp.status_code == 200
        assert read_sweep_interval(h.db)["seconds"] == 5
