from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException

from optionality.apis.aux import build_spx_code
from optionality.core import fetch_snapshot
from optionality.service.deps import get_settings
from optionality.service.settings import Settings

router = APIRouter(prefix="/spx", tags=["spx"])

SettingsDep = Annotated[Settings, Depends(get_settings)]


@router.get("/snapshot")
def spx_snapshot(strike_date: str, option_type: Literal["CALL", "PUT"], strike: float, settings: SettingsDep):
    """Live per-contract snapshot for an SPX weekly option.

    Makes one bounded OpenD call directly (outside the worker queue): a single
    snapshot does not meaningfully compete with a run's QPS budget, and queueing
    it behind a minutes-long strategy scan would defeat its purpose.
    """
    try:
        code = build_spx_code(strike_date, option_type, strike)
    except ValueError as err:
        raise HTTPException(status_code=422, detail=f"invalid strike_date: {err}") from err

    try:
        records = fetch_snapshot([code], opend_host=settings.opend_host, opend_port=settings.opend_port)
    except RuntimeError as err:
        raise HTTPException(status_code=502, detail=f"OpenD call failed: {err}") from err

    if not records:
        raise HTTPException(status_code=404, detail=f"no data for {code}")
    return {"code": code, "snapshot": records[0]}
