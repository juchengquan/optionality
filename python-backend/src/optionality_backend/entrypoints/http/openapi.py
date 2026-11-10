"""`/openapi.json` and `/docs` — the service's description of itself, and the page that shows it.
Port of backend/src/entrypoints/http/openapi.ts, by SERVING what it generates rather than generating:
the owner decided on 2026-11-10 that the Python's description must be the TypeScript's, word for word.

The TypeScript builds its description from the Zod schemas its routes validate and answer through
(hono-openapi), so that nothing is declared twice, and its page with Scalar's Hono plugin. FastAPI
would build a description of its own from pydantic: the same routes in other words, and in places in
other shapes — two accounts of one API that disagree where nobody is looking. So `make scenarios`
writes the TypeScript's two answers, for a blank `ROOT_PATH`, to `schema/api/` — shared ground, as
`schema.sql` is — and this serves them with the one thing in either that Settings decide put in,
exactly where `openapi.ts` puts it:

- **the description's `servers`**, `[{url: rootPath || "/"}]`: the browser sees `/opt/api/...` and
  the app sees `/...`, and "Try it" has to be told the difference;
- **the page's `url`**, `${rootPath}/openapi.json`, which is where it fetches the description from.

Four door scenarios hold both, with `ROOT_PATH` blank and set, to the TypeScript's answers. A route
that changes shape therefore changes `schema/api/openapi.json` in the same diff, and a Scalar upgrade
that renders the page another way fails here until it is ported, never in silence.

**Where the Python differs, and why.**

- **`mount_docs` takes no open paths.** `mountDocs` takes them to mark those operations open in the
  description (`security: []`); the TypeScript did that before it wrote the file.
- **Both files are read on the first request for each and kept**, where `mountDocs` builds the
  description on the first request and keeps it: there is nothing to build. Not at startup, so a
  broken page could cost the docs and never the service.
- **The description is sent as compact JSON in the order the file holds**, which is the order the
  TypeScript built it in, so the bytes are `c.json`'s.
- **The page's URL is the one text replaced** in a file otherwise sent as it is, and `page` refuses a
  page that does not name it exactly once (`BLANK_URL`).
"""

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response

#: `schema/api/` at the repository root: shared ground (ADR 0021), resolved from this module as
#: `db/open.py` resolves `schema.sql`, so the service finds it wherever it was started.
API = Path(__file__).resolve().parents[5] / "schema" / "api"

#: Where the page names its description, as Scalar writes it for a blank root path.
BLANK_URL = '"url": "/openapi.json"'


def description(written: dict[str, Any], root_path: str) -> dict[str, Any]:
    """The description, its `servers` telling "Try it" the path the browser sees. `servers` keeps
    its place: a dict updates a key where it already stands."""
    return {**written, "servers": [{"url": root_path or "/"}]}


def page(written: str, root_path: str) -> str:
    """The page, fetching its description from `${rootPath}/openapi.json`."""
    found = written.count(BLANK_URL)
    if found != 1:
        raise RuntimeError(
            f"schema/api/docs.html names {BLANK_URL} {found} times, not once: Scalar has changed how it"
            " writes the page, and entrypoints/http/openapi.py must follow"
        )
    url = json.dumps(f"{root_path}/openapi.json", ensure_ascii=False)
    return written.replace(BLANK_URL, f'"url": {url}')


def mount_docs(app: FastAPI, root_path: str) -> None:
    """Mounts both routes on `app`."""
    kept: dict[str, Any] = {}

    @app.get("/openapi.json")
    async def openapi_json() -> Response:
        if "spec" not in kept:
            kept["spec"] = description(json.loads((API / "openapi.json").read_text("utf-8")), root_path)
        return JSONResponse(kept["spec"])

    @app.get("/docs")
    async def docs() -> Response:
        if "page" not in kept:
            kept["page"] = page((API / "docs.html").read_text("utf-8"), root_path)
        # Hono's header, spelled as it spells it; Starlette's own would say utf-8
        return Response(kept["page"], headers={"content-type": "text/html; charset=UTF-8"})
