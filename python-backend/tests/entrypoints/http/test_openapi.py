"""`/openapi.json` and `/docs`: the TypeScript's description of the service, served by the Python.

Port of backend/src/entrypoints/http/openapi.test.ts — its first two tests, the ones about what is
SERVED. The rest hold how the TypeScript BUILDS the description (every route documented, a request
body's constraints, the derived 422, `documented(...).reply`), and the Python builds none: it serves
`schema/api/`, which `make check-scenarios` holds to what the TypeScript builds, and four door
scenarios hold what it serves. What is left to test here is what only the Python can get wrong: the
root path put in the two places it belongs, and nothing else touched.
"""

import json

import pytest

from optionality_backend.entrypoints.http import openapi

WRITTEN = json.loads((openapi.API / "openapi.json").read_text("utf-8"))
PAGE = (openapi.API / "docs.html").read_text("utf-8")


class TestTheDocs:
    async def test_are_open_like_health_because_the_page_cannot_send_a_token_to_fetch_its_spec(self, start):
        h = start()
        assert (await h.call("/openapi.json", anonymous=True)).status_code == 200
        assert (await h.call("/docs", anonymous=True)).status_code == 200
        # and opening them did not open anything else
        assert (await h.call("/monitors", anonymous=True)).status_code == 401

        # the runtime above is one claim; what the document SAYS about the same paths is another, and
        # the document is what a reader believes. An empty `security` on an operation overrides the
        # document-wide `[{bearer: []}]`; absent means inherit.
        s = (await h.call("/openapi.json", anonymous=True)).json()
        assert s["security"] == [{"bearer": []}], "the document asks for a bearer token by default"
        assert s["paths"]["/health"]["get"]["security"] == [], "/health is documented as open"
        assert "security" not in s["paths"]["/monitors"]["get"], "/monitors inherits the document's bearer"

    async def test_point_at_the_prefixed_paths_behind_the_path_stripping_proxy(self, start):
        # The browser sees /opt/api/...; the app sees /..., so both the page's spec URL and "Try it"
        # have to be told the prefix.
        h = start(settings={"root_path": "/opt/api"})
        assert "/opt/api/openapi.json" in (await h.call("/docs", anonymous=True)).text
        assert (await h.call("/openapi.json", anonymous=True)).json()["servers"] == [{"url": "/opt/api"}]


class TestWhatOnlyThePythonCanGetWrong:
    async def test_a_blank_root_path_serves_both_files_as_the_typescript_wrote_them(self, start):
        h = start()
        spec = await h.call("/openapi.json", anonymous=True)
        # `c.json`'s bytes: compact, in the order the TypeScript built it, which is the file's
        assert spec.content == json.dumps(WRITTEN, separators=(",", ":"), ensure_ascii=False).encode()
        assert spec.headers["content-type"] == "application/json"
        page = await h.call("/docs", anonymous=True)
        assert page.content == PAGE.encode()
        assert page.headers["content-type"] == "text/html; charset=UTF-8"

    async def test_a_root_path_changes_the_servers_and_the_page_s_url_and_nothing_else(self, start):
        h = start(settings={"root_path": "/opt/api"})
        spec = (await h.call("/openapi.json", anonymous=True)).json()
        assert list(spec) == list(WRITTEN), "servers keeps its place"
        assert {**spec, "servers": WRITTEN["servers"]} == WRITTEN
        page = (await h.call("/docs", anonymous=True)).text
        assert page.replace('"/opt/api/openapi.json"', '"/openapi.json"') == PAGE

    def test_a_page_that_does_not_name_its_description_exactly_once_is_refused(self):
        # Scalar renders the page; an upgrade that writes the URL another way must fail the four
        # scenarios loudly, not serve a page that fetches its description from the wrong place
        with pytest.raises(RuntimeError, match="0 times"):
            openapi.page("<html></html>", "/opt/api")
        with pytest.raises(RuntimeError, match="2 times"):
            openapi.page(f"{openapi.BLANK_URL} {openapi.BLANK_URL}", "")
