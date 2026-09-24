"""Serving the dashboard.

The screen is React (see ADR 0005), served at /ui — the URL it has always had, because
bookmarks, the tailscale path and muscle memory all point there. The htmx implementation
this file used to hold was retired once React reached parity; it is in the history if the
reasoning ever needs revisiting.
"""

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

router = APIRouter(include_in_schema=False)
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))

_APP_DIR = Path(__file__).resolve().parent.parent / "static" / "app"


def _app_assets() -> tuple[str, list[str]]:
    """Vite's manifest names the hashed entry file. Read at request time so a rebuild needs
    no restart, and so a missing bundle fails loudly instead of serving a blank page."""
    manifest = json.loads((_APP_DIR / ".vite" / "manifest.json").read_text())
    entry = next(v for v in manifest.values() if v.get("isEntry"))
    return entry["file"], list(entry.get("css", []))


@router.get("/static/app/{path:path}")
def app_asset(path: str):
    """Assets are served by a route, never a StaticFiles mount: mounts only match the
    root_path-prefixed spelling that `tailscale serve --set-path` never sends."""
    root = _APP_DIR.resolve()
    target = (root / path).resolve()
    if root not in target.parents or not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    # the filename carries a content hash, so this can never go stale
    return FileResponse(target, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.get("/ui")
def dashboard(request: Request):
    """The React shell. root_path is injected because the browser sees /opt/... while the
    app sees /..., and there is no client-side router to configure a base path on."""
    root_path = request.scope.get("root_path", "")
    try:
        entry, css = _app_assets()
    except (OSError, StopIteration, ValueError) as err:
        raise HTTPException(status_code=503, detail=f"frontend bundle missing: run make build-ui ({err})") from err
    response = templates.TemplateResponse(
        request,
        "app.html",
        {
            "root_path": root_path,
            "entry": f"{root_path}/static/app/{entry}",
            "css": [f"{root_path}/static/app/{href}" for href in css],
        },
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/app")
def app_alias(request: Request):
    """/app was where React grew up alongside htmx. Kept as a redirect so a bookmark from
    that period still lands somewhere, with /ui the single canonical URL."""
    return RedirectResponse(f"{request.scope.get('root_path', '')}/ui", status_code=308)
