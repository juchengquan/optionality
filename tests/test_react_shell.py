"""The /app shell and its asset route.

Phase 1 of the React plan: prove the pipeline, not the UI. The two things that can go
silently wrong here are the proxy prefix (the browser sees /opt/..., the app sees /...) and
asset serving, which cannot use a StaticFiles mount behind that proxy.
"""

from tests.conftest import AUTH


def test_the_shell_points_at_the_built_bundle(client_factory):
    client = client_factory()
    resp = client.get("/app", headers=AUTH)
    assert resp.status_code == 200
    assert '<div id="root"></div>' in resp.text
    assert "/static/app/assets/" in resp.text  # a hashed entry from Vite's manifest
    assert resp.headers["cache-control"] == "no-store"


def test_urls_carry_the_proxy_prefix(client_factory):
    client = client_factory(root_path="/opt")
    page = client.get("/app", headers=AUTH).text
    # behind `tailscale serve --set-path /opt` the browser must be given the prefixed spelling
    assert 'src="/opt/static/app/assets/' in page
    assert 'window.OPTIONALITY_ROOT = "/opt"' in page


def test_assets_are_served_and_cached_by_content_hash(client_factory):
    client = client_factory()
    import re

    entry = re.search(r'src="([^"]*static/app/assets/[^"]+)"', client.get("/app", headers=AUTH).text)
    assert entry
    resp = client.get(entry.group(1), headers=AUTH)
    assert resp.status_code == 200
    assert "immutable" in resp.headers["cache-control"]  # the filename carries a content hash


def test_the_asset_route_refuses_to_escape_its_directory(client_factory):
    client = client_factory()
    for attempt in ("../../../../etc/passwd", "../../settings.py", "..%2f..%2fsettings.py"):
        assert client.get(f"/static/app/{attempt}", headers=AUTH).status_code in (404, 400)


def test_ui_still_works_alongside(client_factory):
    """Both dashboards run until the comparison is settled."""
    client = client_factory()
    assert client.get("/ui", headers=AUTH).status_code == 200
    assert client.get("/app", headers=AUTH).status_code == 200
