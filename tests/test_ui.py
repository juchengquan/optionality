from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from optionality.service.models import Monitor
from tests.conftest import AUTH


def _future() -> str:
    return (datetime.now(UTC).date() + timedelta(days=30)).isoformat()


def _fetcher(codes, opend_host=None, opend_port=None):
    return [{"code": c, "option_delta": 0.33, "mid_price": 26.4, "bid_price": 26.1, "ask_price": 26.7} for c in codes]


def test_dashboard_renders(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    resp = client.get("/ui", headers=AUTH)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert resp.headers["cache-control"] == "no-store"
    assert 'http-equiv="refresh"' not in resp.text  # full-page reload is gone: it wiped form input
    assert "htmx.min.js" in resp.text
    assert 'hx-trigger="every 30s' in resp.text  # partial refresh of the live fragment instead
    assert "Add monitor" in resp.text
    assert "Add combo" in resp.text


def test_refresh_interval_comes_from_settings(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher, ui_refresh_seconds=7)
    assert 'hx-trigger="every 7s' in client.get("/ui", headers=AUTH).text


def test_refresh_selector_offers_fast_options(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    page = client.get("/ui", headers=AUTH).text
    for opt in (5, 10, 15, 30, 60, 120):
        assert f'value="{opt}"' in page


def test_refresh_selector_sets_cookie_and_overrides_env(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)  # env default 30
    resp = client.post("/ui/refresh", data={"refresh": "15"}, headers=AUTH, follow_redirects=False)
    assert resp.status_code == 303
    assert resp.cookies.get("ui_refresh") == "15"
    assert 'hx-trigger="every 15s' in client.get("/ui", headers=AUTH).text  # cookie beats env

    client.post("/ui/refresh", data={"refresh": "1"}, headers=AUTH)  # clamped to the floor
    assert 'hx-trigger="every 5s' in client.get("/ui", headers=AUTH).text


def test_garbage_refresh_cookie_falls_back_to_env(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    client.cookies.set("ui_refresh", "banana")
    assert 'hx-trigger="every 30s' in client.get("/ui", headers=AUTH).text


def test_table_fragment_is_forms_free(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    payload = {"strike_date": _future(), "option_type": "CALL", "strike": 8100, "threshold": 0.6}
    client.post("/monitors", json=payload, headers=AUTH)
    client.app.state.sweeper.sweep()
    resp = client.get("/ui/table", headers=AUTH)
    assert resp.status_code == 200
    assert "8100.00C" in resp.text or "C8100000" in resp.text
    assert "fetched at" in resp.text
    assert "Add monitor" not in resp.text  # creation forms live outside the refreshing fragment
    assert "htmx.min.js" not in resp.text  # fragment, not a full document
    assert "<th>actions</th><th>last trade</th>" in resp.text  # last trade sits at the far edge


def test_htmx_asset_served(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    resp = client.get("/static/htmx.min.js", headers=AUTH)
    assert resp.status_code == 200
    assert "htmx" in resp.text[:200]


def test_htmx_asset_served_behind_path_stripping_proxy(client_factory):
    # regression: with ROOT_PATH set, a StaticFiles Mount only matched the prefixed
    # spelling — which a stripping proxy never sends — so the asset 404'd in production
    client = client_factory(token="", root_path="/api")
    resp = client.get("/static/htmx.min.js")
    assert resp.status_code == 200
    assert "htmx" in resp.text[:200]


def test_mode_column_shows_compare(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    signed = {
        "strike_date": _future(),
        "option_type": "CALL",
        "strike": 8100,
        "field": "mid_price",
        "threshold": -4.05,
        "direction": "below",
        "compare": "signed",
    }
    client.post("/monitors", json=signed, headers=AUTH)
    page = client.get("/ui", headers=AUTH)
    assert "<th>mode</th>" in page.text
    assert "<td>signed</td>" in page.text


def test_create_monitor_via_form(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    form = {
        "strike_date": _future(),
        "option_type": "CALL",
        "strike": "8100",
        "field": "option_delta",
        "threshold": "0.6",
        "direction": "above",
    }
    resp = client.post("/ui/monitors", data=form, headers=AUTH, follow_redirects=False)
    assert resp.status_code == 200  # fragment swap, not a page reload
    assert "location" not in resp.headers
    sf = client.app.state.session_factory
    with sf() as s:
        monitor = s.scalar(select(Monitor))
        assert monitor.code.endswith("C8100000")
        assert monitor.threshold == 0.6

    page = client.get("/ui", headers=AUTH)
    assert "C8100000" in page.text or "8100.00C" in page.text


def test_create_monitor_form_error_shows_banner(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    form = {
        "strike_date": "not-a-date",
        "option_type": "CALL",
        "strike": "8100",
        "field": "option_delta",
        "threshold": "0.6",
        "direction": "above",
    }
    resp = client.post("/ui/monitors", data=form, headers=AUTH)  # follows redirect back to /ui
    assert resp.status_code == 200
    assert "strike_date" in resp.text  # error banner mentions the problem
    sf = client.app.state.session_factory
    with sf() as s:
        assert s.scalar(select(Monitor)) is None


def test_create_combo_via_form_with_blank_rows(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    form = {
        "name": "web-condor",
        "strike_date": _future(),
        "field": "mid_price",
        "threshold": "10",
        "direction": "below",
        "sign_1": "+",
        "option_type_1": "CALL",
        "strike_1": "8100",
        "sign_2": "-",
        "option_type_2": "CALL",
        "strike_2": "8150",
        "sign_3": "+",
        "option_type_3": "PUT",
        "strike_3": "",  # blank rows are skipped
        "sign_4": "+",
        "option_type_4": "PUT",
        "strike_4": "",
        "sign_5": "+",
        "option_type_5": "CALL",
        "strike_5": "",
        "sign_6": "+",
        "option_type_6": "CALL",
        "strike_6": "",
    }
    resp = client.post("/ui/combos", data=form, headers=AUTH, follow_redirects=False)
    assert resp.status_code == 200
    sf = client.app.state.session_factory
    with sf() as s:
        combo = s.scalar(select(Monitor))
        assert combo.code == "web-condor"
        assert len(combo.legs) == 2
        assert combo.legs[1]["sign"] == -1


def test_row_actions_threshold_mute_delete(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    payload = {"strike_date": _future(), "option_type": "CALL", "strike": 8100, "threshold": 0.6}
    mid = client.post("/monitors", json=payload, headers=AUTH).json()["id"]

    resp = client.post(f"/ui/monitors/{mid}/threshold", data={"threshold": "0.5"}, headers=AUTH)
    assert resp.status_code == 200
    sf = client.app.state.session_factory
    with sf() as s:
        assert s.get(Monitor, mid).threshold == 0.5

    client.post(f"/ui/monitors/{mid}/toggle", data={}, headers=AUTH)
    with sf() as s:
        assert s.get(Monitor, mid).enabled is False
    page = client.get("/ui", headers=AUTH)
    assert "Muted" in page.text  # muted section appears with the disabled monitor

    client.post(f"/ui/monitors/{mid}/toggle", data={}, headers=AUTH)
    with sf() as s:
        assert s.get(Monitor, mid).enabled is True

    client.post(f"/ui/monitors/{mid}/delete", data={}, headers=AUTH)
    with sf() as s:
        assert s.get(Monitor, mid) is None


def test_health_strip_shows_alarm_state(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    page = client.get("/ui", headers=AUTH)
    assert "alarms:" in page.text
    assert "starting" in page.text  # no sweep has run in a fresh app
    assert "sweep ok" not in page.text  # jargon retired
    assert "consecutive failures" not in page.text

    client.app.state.sweeper.last_sweep_ok = True
    assert "active" in client.get("/ui", headers=AUTH).text

    client.app.state.sweeper.last_sweep_ok = False
    client.app.state.sweeper.consecutive_failures = 3
    page = client.get("/ui", headers=AUTH)
    assert "STALLED (3 failed sweeps)" in page.text


def test_ui_rename_combo(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    combo = {
        "name": "web-combo",
        "strike_date": _future(),
        "legs": [
            {"sign": 1, "option_type": "CALL", "strike": 8100},
            {"sign": -1, "option_type": "CALL", "strike": 8150},
        ],
        "threshold": 10,
    }
    mid = client.post("/monitors", json=combo, headers=AUTH).json()["id"]
    page = client.get("/ui", headers=AUTH).text
    assert 'name="name"' in page and "/rename" in page  # rename box only in the combo row

    resp = client.post(f"/ui/monitors/{mid}/rename", data={"name": "web-combo-v2"}, headers=AUTH)
    assert resp.status_code == 200
    assert "web-combo-v2" in resp.text


def _greeks_fetcher(codes, opend_host=None, opend_port=None):
    return [
        {
            "code": c,
            "option_delta": 0.33,
            "option_gamma": 0.011,
            "option_theta": -0.44,
            "option_vega": 0.55,
            "option_implied_volatility": 0.18,
            "mid_price": 26.4,
            "bid_price": 26.1,
            "ask_price": 26.7,
        }
        for c in codes
    ]


UNKNOWN_ERR = "snapshot API failed: Unknown stock. SPXW260918C99999000"
POISON = "US.SPXW260918C99999000"


def _poison_fetcher(codes, opend_host=None, opend_port=None):
    if POISON in codes:
        raise RuntimeError(UNKNOWN_ERR)
    return _greeks_fetcher(codes)


def test_combo_row_shows_expiry_and_legs(client_factory):
    client = client_factory(snapshot_fetcher=_greeks_fetcher)
    expiry = _future()
    combo = {
        "name": "condor-a",
        "strike_date": expiry,
        "legs": [
            {"sign": 1, "option_type": "CALL", "strike": 8100},
            {"sign": -1, "option_type": "CALL", "strike": 8150},
            {"sign": -1, "option_type": "PUT", "strike": 7900},
            {"sign": 1, "option_type": "PUT", "strike": 7850},
        ],
        "threshold": 10,
    }
    client.post("/monitors", json=combo, headers=AUTH)
    page = client.get("/ui", headers=AUTH).text
    # the legs ARE the combo's identity; a name alone is meaningless three weeks later
    assert "+C8100 -C8150 -P7900 +P7850" in page
    assert expiry in page  # and which expiry it belongs to — only the name showed before


def test_highlight_marks_the_monitored_field(client_factory):
    client = client_factory(snapshot_fetcher=_greeks_fetcher)
    payload = {
        "strike_date": _future(),
        "option_type": "CALL",
        "strike": 8100,
        "field": "option_theta",
        "threshold": -0.5,
        "compare": "signed",
    }
    client.post("/monitors", json=payload, headers=AUTH)
    client.app.state.sweeper.sweep()
    row = client.get("/ui/table", headers=AUTH).text
    assert '<td class="hl">-0.44</td>' in row  # theta drives the alarm, so theta is highlighted
    assert '<td class="hl">0.33</td>' not in row  # delta no longer highlighted unconditionally
    assert '<td class="hl">26.4</td>' not in row  # nor mid


def test_unmuted_dead_contract_is_flagged_on_the_row(client_factory):
    client = client_factory(snapshot_fetcher=_poison_fetcher)
    sf = client.app.state.session_factory
    with sf() as s:  # inserted directly: creation probes reject non-existent contracts
        s.add(
            Monitor(
                id="deadbeef" * 4,
                code=POISON,
                strike_date=_future(),
                option_type="CALL",
                strike=99999.0,
                field="option_delta",
                threshold=0.6,
            )
        )
        s.commit()

    client.app.state.sweeper.sweep()  # quarantines it: disabled, never deleted
    with sf() as s:
        assert s.get(Monitor, "deadbeef" * 4).enabled is False

    client.post("/ui/monitors/%s/toggle" % ("deadbeef" * 4), data={}, headers=AUTH)  # user unmutes it
    row = client.get("/ui/table", headers=AUTH).text
    # back on the watchlist, but the contract still does not exist — say so rather than
    # rendering a row of em-dashes that reads as "OpenD is briefly slow"
    assert "unknown contract" in row


def test_dashboard_supports_dark_mode_and_aligned_numerals(client_factory):
    client = client_factory(snapshot_fetcher=_greeks_fetcher)
    page = client.get("/ui", headers=AUTH).text
    assert "prefers-color-scheme: dark" in page  # the US session is overnight in DISPLAY_TZ
    assert "tabular-nums" in page  # %.4g gives ragged decimals; columns must still scan


def test_dashboard_makes_no_opend_call_of_its_own(client_factory):
    calls = []

    def counting(codes, opend_host=None, opend_port=None):
        calls.append(tuple(codes))
        return [{"code": c, "option_delta": 0.42, "mid_price": 12.0} for c in codes]

    client = client_factory(snapshot_fetcher=counting)
    payload = {"strike_date": _future(), "option_type": "CALL", "strike": 8100, "threshold": 0.6}
    client.post("/monitors", json=payload, headers=AUTH)
    client.app.state.sweeper.sweep()
    before = len(calls)

    page = client.get("/ui", headers=AUTH).text
    client.get("/ui/table", headers=AUTH)

    assert len(calls) == before  # the page renders from the sweep's records, not its own fetch
    assert "0.42" in page  # and still shows real values


def test_row_value_and_bell_come_from_the_same_instant(client_factory):
    live = {"delta": 0.61}

    def fetcher(codes, opend_host=None, opend_port=None):
        return [{"code": c, "option_delta": live["delta"], "mid_price": 12.0} for c in codes]

    client = client_factory(snapshot_fetcher=fetcher)
    payload = {"strike_date": _future(), "option_type": "CALL", "strike": 8100, "threshold": 0.6}
    client.post("/monitors", json=payload, headers=AUTH)
    client.app.state.sweeper.sweep()  # 0.61 breaches 0.6 -> triggered

    live["delta"] = 0.59  # the market moves, but no sweep has run since
    page = client.get("/ui", headers=AUTH).text

    assert ">0.61<" in page  # the value the alarm engine actually used
    assert ">0.59<" not in page  # not a fresher number the bell never saw
    assert "🔔" in page


def test_dashboard_before_the_first_sweep_says_so(client_factory):
    client = client_factory(snapshot_fetcher=_greeks_fetcher)
    payload = {"strike_date": _future(), "option_type": "CALL", "strike": 8100, "threshold": 0.6}
    client.post("/monitors", json=payload, headers=AUTH)

    page = client.get("/ui", headers=AUTH).text
    assert "waiting for first sweep" in page  # honest: no data yet rather than a fake timestamp
    assert "C8100000" in page  # rows still render, so mute/delete/threshold stay usable


def test_poll_may_run_faster_than_the_sweep(client_factory):
    """The two intervals answer different questions and must not be coupled.

    The sweep sets how fresh the data is; the poll sets how soon the page shows the
    latest sweep. A 15s poll against a 15s sweep can leave a just-missed sweep on screen
    for nearly 30s, so polling faster genuinely cuts display latency — and costs nothing,
    because the page reads the sweep's cache rather than calling OpenD.
    """
    client = client_factory(snapshot_fetcher=_greeks_fetcher, monitor_interval_seconds=30, ui_refresh_seconds=30)
    page = client.get("/ui", headers=AUTH).text
    for fast in (5, 10, 15):
        assert f'value="{fast}"' in page  # offered even though the sweep is slower

    client.post("/ui/refresh", data={"refresh": "5"}, headers=AUTH)
    assert 'hx-trigger="every 5s' in client.get("/ui", headers=AUTH).text


def test_page_states_the_sweep_interval_so_a_static_timestamp_reads_as_normal(client_factory):
    client = client_factory(snapshot_fetcher=_greeks_fetcher, monitor_interval_seconds=30)
    client.app.state.sweeper.sweep()
    page = client.get("/ui/table", headers=AUTH).text
    # polling at 5s against a 30s sweep means "fetched at" holds still for six polls;
    # naming the sweep cadence is what stops that looking like a stuck dashboard
    assert "sweep every 30s" in page


def test_row_action_swaps_the_table_instead_of_reloading(client_factory):
    client = client_factory(snapshot_fetcher=_greeks_fetcher)
    payload = {"strike_date": _future(), "option_type": "CALL", "strike": 8100, "threshold": 0.6}
    mid = client.post("/monitors", json=payload, headers=AUTH).json()["id"]
    client.app.state.sweeper.sweep()

    resp = client.post(f"/ui/monitors/{mid}/toggle", data={}, headers=AUTH, follow_redirects=False)
    assert resp.status_code == 200
    assert "location" not in resp.headers  # no 303: scroll position survives a mute
    assert "<!DOCTYPE" not in resp.text  # a fragment, not a whole document
    assert "<table" in resp.text


def test_add_forms_drive_htmx_and_target_the_live_region(client_factory):
    client = client_factory(snapshot_fetcher=_greeks_fetcher)
    page = client.get("/ui", headers=AUTH).text
    assert 'hx-post="/ui/monitors"' in page
    assert 'hx-post="/ui/combos"' in page
    # the error region sits OUTSIDE the swapped region, above it, so a failure from the
    # add-combo form at the bottom of the page is visible without scrolling back up
    assert page.index('id="ui-error"') < page.index('id="live"')


def test_mutation_error_rides_an_out_of_band_swap(client_factory):
    client = client_factory(snapshot_fetcher=_greeks_fetcher)
    form = {
        "strike_date": "not-a-date",
        "option_type": "CALL",
        "strike": "8100",
        "field": "option_delta",
        "threshold": "0.6",
        "direction": "above",
    }
    resp = client.post("/ui/monitors", data=form, headers=AUTH, follow_redirects=False)
    assert resp.status_code == 200
    assert 'id="ui-error"' in resp.text and "hx-swap-oob" in resp.text
    assert "strike_date" in resp.text
    assert "?error=" not in resp.text  # the query-param error path is gone


def test_add_form_resets_on_success_but_keeps_input_on_error(client_factory):
    client = client_factory(snapshot_fetcher=_greeks_fetcher)
    good = {
        "strike_date": _future(),
        "option_type": "CALL",
        "strike": "8100",
        "field": "option_delta",
        "threshold": "0.6",
        "direction": "above",
    }
    ok = client.post("/ui/monitors", data=good, headers=AUTH, follow_redirects=False)
    # a fresh, empty form is swapped back out-of-band — server-rendered, so no reset script
    assert 'id="add-monitor"' in ok.text and "hx-swap-oob" in ok.text

    bad = dict(good, strike_date="not-a-date")
    err = client.post("/ui/monitors", data=bad, headers=AUTH, follow_redirects=False)
    assert 'id="add-monitor"' not in err.text  # input left alone so it can be corrected


def test_manual_mute_records_its_reason_and_unmuting_clears_it(client_factory):
    client = client_factory(snapshot_fetcher=_greeks_fetcher)
    payload = {"strike_date": _future(), "option_type": "CALL", "strike": 8100, "threshold": 0.6}
    mid = client.post("/monitors", json=payload, headers=AUTH).json()["id"]
    sf = client.app.state.session_factory

    client.post(f"/ui/monitors/{mid}/toggle", data={}, headers=AUTH)
    with sf() as s:
        assert s.get(Monitor, mid).disabled_reason == "manual"

    client.post(f"/ui/monitors/{mid}/toggle", data={}, headers=AUTH)
    with sf() as s:
        row = s.get(Monitor, mid)
        assert row.enabled is True
        assert row.disabled_reason is None  # re-enabling must not leave a stale reason behind


def test_muted_table_groups_by_reason_and_counts_down_to_deletion(client_factory):
    client = client_factory(snapshot_fetcher=_greeks_fetcher)
    sf = client.app.state.session_factory
    expired_on = (datetime.now(UTC).date() - timedelta(days=2)).isoformat()
    with sf() as s:
        s.add(
            Monitor(
                id="a" * 32,
                code="US.SPXW260101C1000000",
                strike_date=expired_on,
                option_type="CALL",
                strike=1000.0,
                field="option_delta",
                threshold=0.6,
                enabled=False,
                disabled_reason="expired",
            )
        )
        s.add(
            Monitor(
                id="b" * 32,
                code="legacy-row",
                strike_date=_future(),
                option_type="CALL",
                strike=2000.0,
                field="option_delta",
                threshold=0.6,
                enabled=False,
            )
        )
        s.commit()

    page = client.get("/ui", headers=AUTH).text
    assert "Expired" in page  # grouped by reason, not one undifferentiated list
    assert "Reason not recorded" in page  # pre-migration rows say so rather than guessing
    assert "Muted" not in page.replace("Muted by you", "")  # the old catch-all heading is gone
    # EXPIRED_RETENTION_DAYS is 7 and it expired 2 days ago: deleted once 8 days have passed
    assert "auto-deletes in 6 days" in page
