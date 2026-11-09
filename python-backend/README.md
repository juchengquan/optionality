# optionality-backend

The optionality service in Python: the standby beside the TypeScript backend, able to run the whole
service — the sweep and its alarms, the database, the API the dashboard calls and the bot — so that
either can be the live one, one at a time (ADR 0021). It is being ported module by module, bottom up
(phase 4), and `make check-module-map` says how far it has got.

**It is never released.** It runs from the working tree, as `backend/` does, under the launchd agent
that `make deploy` restarts — so what is checked out is what runs, and there is no version anybody
pins. The library beside it, `python/`, is the opposite: released by git tag (ADR 0016) and installed
by notebooks from its subdirectory. The two share one uv workspace, rooted at the repository's
`pyproject.toml`, with one `uv.lock`.

It depends on `optionality` only through what the library publishes, and it places no order:

- `tests/test_library_boundary.py` refuses a private `optionality._*` module or name,
  `optionality.research` (no golden case holds it, ADR 0020), and any reach into the library's
  source by path.
- `tests/test_no_trading.py` refuses any reference that places, modifies, cancels or exercises an
  order, outside a `trading/` module that does not exist until an ADR creates it (ADR 0021,
  Decision 8). The list of what it refuses, and the reader that applies it, are the library's
  (`optionality.no_trading`): the IB Gateway client is the library's too, and the library holds
  itself to the same rule with no door at all, re-deriving the list from `ib_async` in its suite.

Both run in `make lint` and in `make test`, which is part of `make check`.

It is held to the TypeScript at the service's three doors (ADR 0021, Decision 4):
`tests/test_scenarios.py` replays every scenario in `testdata/scenarios/` through
`tests/scenarios/`, the Python's half of the replay. The one place the backend plugs in is
`tests/scenarios/backend.py`'s `build`. Until a scenario passes it stays on
`tests/scenarios/backlog.py`, skipped with its reason; the suite ends by counting the port —
"door scenarios: N of 120 ported" — and the list may only shrink.

## Porting a module

Every TypeScript backend module is ported to one Python module, bottom up (ADR 0021, Decision 4 and
phase 4). These are the rules each port follows. The first five — `ports`, `notify`, `telegram`,
`db/time` and `db/values` — were written to them and are the examples to read.

**One module for one.** `backend/src/<path>.ts` becomes the file `pythonFor()` in
`tools/check-module-map.mjs` names: the same path, `snake_case`, and a directory's `index.ts` its
`__init__.py`. The same change takes it off `BACKLOG`, and `make check-module-map` fails until it
does. A directory with no `index.ts` gets no `__init__.py` (`db/`): Python 3 needs none, and the
TypeScript has no door there.

**The docstring** opens with what the module is, then says `Port of backend/src/<path>.ts.`, and
carries the TypeScript's WHY comments over wherever they still apply — translated, never invented,
and dropped where the reason is gone. Where the Python must differ, a paragraph headed **Where the
Python differs, and why** says how, so a reader of a TypeScript change can find what it means here.

**Behaviour is identical**, including what JavaScript does by being JavaScript:

- **Numbers.** `Math.round`, `toFixed`, `Number(x)`, `String(n)` and the truthiness of a value whose
  type is not known (a quote field, parsed JSON) go through `optionality.js` — `math_round`,
  `to_fixed`, `number`, `js_string`, `truthy` — never Python's own. Python's `str` and `repr` of a
  float are not JavaScript's (`8050.0`, `1e-05`); `js_string` is. The truthiness of something the
  TypeScript types as a `string` or a `boolean` is Python's: the two agree there.
- **Text.** A regex the TypeScript anchors with `^…$` is compiled with `re.ASCII` and used with
  `fullmatch`: JavaScript's `\d` is ASCII and its `$` is the end of the text, where Python's take any
  Unicode digit and a final newline. `JSON.stringify` of anything STORED is
  `db/values.to_sqlite_json`, byte for byte: both backends write one file, and the sweep tells a
  changed sample by comparing its JSON as text. Of something a person only reads — an error, a log
  line — `json.dumps(x, separators=(",", ":"), ensure_ascii=False)` will do, and differs from it only
  on floats, array-index keys and lone surrogates.
- **Instants.** A `Date` is an AWARE `datetime`, and a naive one is refused where an instant is
  taken. `new Date()` as a default is a `None` that means now. Storage keeps milliseconds, as a `Date`
  does (`db/time.py`).
- **Errors.** `throw new Error(m)` is `RuntimeError(m)`, and a refusal of bad input is
  `ValueError(m)`, with the TypeScript's message. `catch (err)` is `except Exception` and never wider,
  because `asyncio.CancelledError` is how the loop stops a task; `err.message` is `str(err)`.
- **Logs.** `console.info`/`warn`/`error` is the module's `logging.getLogger(__name__)` at the same
  level with the same words, and an error logged with its stack is `log.exception`. Only `__main__`
  configures where they go. The scenarios do not hold log lines, so their format may differ; what
  they say may not.

**Async.** `async` in the TypeScript is `async def`, and everything runs on ONE asyncio loop (ADR
0021, Decision 6), so there are no threads — except the moomoo SDK, which blocks and so runs in a
worker thread with a timeout. A callback typed `Promise<T> | T` is awaited only when it answers an
awaitable. `AbortSignal.timeout(ms)` is `asyncio.timeout(s)` around the whole exchange, with any
client's own per-phase timeouts off: httpx2 defaults to five seconds a phase, which would cut the
bot's 25-second long poll (`telegram.py`). The service's `QuoteFetcher` is `ports.QuoteFetcher`,
which is awaited — never the library's `optionality.quotes.QuoteFetcher`, which is synchronous
because a notebook has no loop.

**Names.** `snake_case` functions, methods, variables and fields; `PascalCase` classes; constants
spelled as the TypeScript spells them. An interface something IMPLEMENTS is a `typing.Protocol`,
`runtime_checkable` so a test can ask whether a fake answers it (`ports.py`); a plain record is a
frozen dataclass; an anonymous object type a function returns gets a name (`ports.AlarmState`). zod
schemas become pydantic models. A global the TypeScript reaches, like `fetch`, is a keyword-only
parameter here that defaults to the real thing (`transport=`), because vitest can stub a global
and a Python test cannot.

**Tests.** The module's TypeScript tests are ported to `tests/` at the mirrored path —
`db/time.test.ts` is `tests/db/test_time.py` — one Python test for each TypeScript test, with the
same inputs and the same expectations. Its sentence is its name:
`it("truncates below the millisecond rather than rounding")` is
`test_truncates_below_the_millisecond_rather_than_rounding`, inside a `Test…` class for its
`describe`. What only Python can get wrong is tested beside them, in a class or a name that says
so, never folded into a ported test. A module with no TypeScript test of its own is tested for what
its CALLERS' tests rely on, and the test module's docstring names them.

- `async def test_…` runs as it is (pytest-asyncio's auto mode).
- `TZ=UTC`, as everywhere. A test that needs another zone sets `TZ` and calls `time.tzset()`, as
  `tests/db/test_time.py` does: Python, unlike Node, does not re-read the variable on its own.
- Fakes are injected where the TypeScript injects them, and nothing reaches Telegram, moomoo or IB
  Gateway — `telegram.py`'s suite runs on `httpx2.MockTransport`.
- Mirrored paths repeat basenames (`engine/` and `entrypoints/http/routes/` each have a
  `test_positions.py`), so the suite imports by path: `--import-mode=importlib`, in `pyproject.toml`.

**TDD, as everywhere.** Port the test, watch it fail on the missing module, then port the module;
`make format` and `make lint` clean, `make check` green.
