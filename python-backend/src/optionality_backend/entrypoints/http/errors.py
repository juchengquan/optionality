"""The error shape the dashboard already parses (ADR 0009, phase 5). Port of
backend/src/entrypoints/http/errors.ts.

`{"detail": "..."}`, which FastAPI's HTTPException rendered for the old Python and the frontend reads
on every failure path. Not a style choice: changing the shape would break every error message the
dashboard shows. A route RAISES one of these; `app.py` answers it.

**Where the Python differs, and why.** Nothing to translate: FastAPI's `HTTPException` is the shape
the TypeScript rebuilt by hand on top of Hono's, which renders a bare string.
"""

from fastapi import HTTPException


def http_error(status: int, detail: str) -> HTTPException:
    return HTTPException(status_code=status, detail=detail)


def not_found(what: str) -> HTTPException:
    return http_error(404, f"{what} not found")


def provider_failed(name: str, err: BaseException) -> HTTPException:
    """A market-data route whose one bounded call failed: 502, naming the Provider that failed.

    502 rather than 500 because the fault is upstream — the service worked and the gateway did not.
    The NAME is the point of putting this here: both market-data routes wrote "OpenD call failed"
    whatever `OPTIONALITY_PROVIDER` said, and the dashboard prints this `detail` verbatim. ADR 0018
    corrected the same leak in `verifyContracts`, and the sweeper's degraded default; two copies of the
    sentence is how it survived in a third place.
    """
    return http_error(502, f"{name} call failed: {err}")
