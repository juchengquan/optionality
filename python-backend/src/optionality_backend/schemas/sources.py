"""Every vendor a Reference can name — the one list, on its own. Port of backend/src/schemas/sources.ts.

In the TypeScript it sits apart from `reference.ts` for a mechanical reason: the dashboard renders its
"from" box from this list at RUNTIME, and reaching it through `reference.ts` put zod and every request
schema in the bundle. That reason does not cross over — no page imports the Python — but the module
does, so a change to the list lands in the same file in both.

The VENDOR outright, never "the Provider": a row meaning "wherever the service is pointed" would
silently show a different company's figure for the same ticker the day OPTIONALITY_PROVIDER changes,
under the same unchanged label (ADR 0019).

Listed here means KNOWN, not available. Whether this build can actually reach one is a separate
question the route answers, the same way the vendor door refuses a Provider name it has no case for
rather than booting without market data.
"""

from typing import Literal, get_args

#: the union itself, so a check of a Reference's source is typed from this list rather than spelling
#: the same three names again
type Source = Literal["moomoo", "ibkr", "yahoo"]

SOURCES: tuple[Source, ...] = get_args(Source.__value__)
