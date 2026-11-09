"""The HTTP layer's one door: the app as a value, the bag of things its routes need, and the port the
app is served on. Port of backend/src/entrypoints/http/index.ts.

Behind it: `app.py` (the routes mounted, the auth, the error shape), `routes/` (one module per
resource), `deps.py`, `errors.py` and `listen.py` (the port, which is the lock between the two
backends, ADR 0021). `__main__` and the test harness are the only things outside that want any of it,
and both want exactly these names.

`ports.py` is deliberately NOT in here: the bot, the engine's health and the vendor door all use it,
so it is the service's interface vocabulary, not the HTTP layer's.

**Where the Python differs, and why.** The TypeScript door also exports `AppType`, the type the
dashboard's typed client (`hc<AppType>`) is checked against. It has no Python counterpart: the
dashboard takes its types from the TypeScript, and the Python's routes are held to the same JSON by
the HTTP door scenarios instead (`hc.types.ts` is TypeScript-only in `tools/check-module-map.mjs`).
"""

from .app import create_app
from .deps import Deps
from .listen import HeldPort, take_port

__all__ = ["Deps", "HeldPort", "create_app", "take_port"]
