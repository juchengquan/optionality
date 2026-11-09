"""The HTTP layer's one door: the app as a value, and the bag of things its routes need. Port of
backend/src/entrypoints/http/index.ts — PARTLY: see the last paragraph.

Behind it: `app.py` (the routes mounted, the auth, the error shape), `routes/` (one module per
resource), `deps.py` and `errors.py`. `__main__` and the test harness are the only things outside that
want any of it, and both want exactly these names.

`ports.py` is deliberately NOT in here: the bot, the engine's health and the vendor door all use it,
so it is the service's interface vocabulary, not the HTTP layer's.

**Partly ported**: `take_port` (`listen.ts`, the port lock ADR 0021 takes before anything else) joins
`__all__` with its module, which `__main__` will need and the tracer does not.
"""

from .app import create_app
from .deps import Deps

__all__ = ["Deps", "create_app"]
