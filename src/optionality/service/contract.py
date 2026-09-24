"""The number the dashboard and the API use to agree they are the same age.

They deploy separately now (ADR 0006), so a bundle can outlive the API it was built
against. This integer is the only thing both sides read: the bundle bakes it at build
time, the API reports it on /health, and the dashboard says so out loud when they differ
instead of failing at whatever field happens to have moved.

BUMP IT when an older bundle cannot survive the change — a field removed or renamed, a
unit changed, a shape changed. Do NOT bump for an added field; old bundles ignore those
happily. Rare bumps are the point: a banner that cries wolf stops being read.
"""

import json
from pathlib import Path

# lives inside the package so it travels with an installed copy, and so the Vite build
# can read the very same file rather than a second copy that could drift
_CONTRACT_FILE = Path(__file__).resolve().parent / "contract.json"

CONTRACT_VERSION: int = json.loads(_CONTRACT_FILE.read_text())["version"]
