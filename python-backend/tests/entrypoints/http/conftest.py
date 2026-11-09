"""`start`, the HTTP suites' `start()` and `afterEach(() => h?.close())` in one fixture."""

import pytest
from harness import Harness, harness


@pytest.fixture
def start():
    made: list[Harness] = []

    def start(**options) -> Harness:
        made.append(harness(**options))
        return made[-1]

    yield start
    for h in made:
        h.close()
