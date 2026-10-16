"""One snapshot read through the Python SDK, for the OpenD differential (ADR 0009, phase 6).

Called twice, once either side of the TypeScript read, because the market moves while we look at it.
A field that matches EITHER bracket is drift; one that matches neither is a divergence. This is the
same answer phase 0 reached comparing TCP against WebSocket, and the same mistake it made first.
"""

import json
import logging
import sys
import time

from optionality.core import fetch_snapshot
from optionality.service.settings import Settings


def _quiet_sdk() -> None:
    """The moomoo SDK logs every connect and disconnect at INFO, and this tool makes six of them.

    Its loggers are FTConsoleLog and FTFileLog, named nothing like the package — found by listing the
    logger dictionary rather than guessing, after setting "moomoo" had no effect at all. Raised to
    WARNING so the comparison's own output is readable; not silenced, because a real SDK warning
    during a comparison is exactly the thing worth seeing.
    """
    for name in ("FTConsoleLog", "FTFileLog"):
        logging.getLogger(name).setLevel(logging.WARNING)


def main() -> int:
    _quiet_sdk()
    with open(sys.argv[1]) as f:
        codes = json.load(f)
    settings = Settings.from_env()
    started = time.time()
    records = fetch_snapshot(codes, opend_host=settings.opend_host, opend_port=settings.opend_port)
    with open(sys.argv[2], "w") as f:
        json.dump(
            {
                "at": started,
                "took": time.time() - started,
                "by_code": {r["code"]: r for r in records},
            },
            f,
        )
    print(f"python: {len(records)} snapshots in {time.time() - started:.2f}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
