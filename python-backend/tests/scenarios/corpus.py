"""Where the scenario files live, and reading them back. Mirrors `backend/testing/scenarios/corpus.ts`.

A scenario is named here by its path under `testdata/scenarios/` — `http/get-health-….json` — which
is what the backlog lists and what a failure prints, so one string finds the file.
"""

import json
from pathlib import Path
from typing import Any

#: `testdata/scenarios/`, shared ground the TypeScript writes and this backend reads (ADR 0021)
SCENARIOS = Path(__file__).resolve().parents[3] / "testdata" / "scenarios"

#: in the order the TypeScript replays them
DOORS = ("http", "bot", "sweep")


def scenario_files(door: str, root: Path = SCENARIOS) -> list[str]:
    """The scenario files of one door, by file name, sorted."""
    folder = root / door
    return sorted(p.name for p in folder.glob("*.json")) if folder.is_dir() else []


def all_scenarios(root: Path = SCENARIOS) -> list[str]:
    """Every scenario, as `door/file.json`, door by door."""
    return [f"{door}/{file}" for door in DOORS for file in scenario_files(door, root)]


def _refuse(constant: str) -> float:
    raise ValueError(f"{constant} is not JSON")


def read_scenario(name: str, root: Path = SCENARIOS) -> dict[str, Any]:
    """One scenario, parsed as JSON.parse would: `NaN` and `Infinity`, which Python's own parser
    accepts by default and the TypeScript cannot have written, are refused rather than read."""
    return json.loads((root / name).read_text(encoding="utf-8"), parse_constant=_refuse)
