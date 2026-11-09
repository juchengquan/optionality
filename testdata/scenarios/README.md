# Door scenarios

Test data, not tests — hence `testdata/`. What the service does at each of its three doors (ADR
0020) — an HTTP request, a Telegram message, one tick of the sweep — for a stated world, so that a
second backend can be held to the TypeScript one (ADR 0021, Decision 4).

The files are **generated**, never edited: `make scenarios` rewrites them from
`backend/testing/scenarios/inputs/`, `make check-scenarios` fails when one is missing, stale or
left over, and the backend's suite replays every file and fails when a door can do something no
file shows. The TypeScript writes them for now; the long run is a spec written by hand that both
backends meet (Decision 2), which is why everything below is plain JSON with no tag, blob or
TypeScript name in it. Generated under `TZ=UTC`, and read under it.

## Layout

One scenario per file, named after its `name`:

- `http/` — a world, one request, and the response
- `bot/` — a world, one Telegram update, and the reply
- `sweep/` — a world, one tick of the sweep at the world's clock, and what it did

## The world

Every scenario starts from one, written out in full:

- `clock` — the instant of the event, ISO 8601 UTC. The service's clock reads exactly this.
- `settings` — `.env` lines, as strings. Every setting not named here takes the service's default.
- `provider` — the vendor the alarms read from: its `name`, whether its own port probe says it is
  `reachable` (asked by `/health` only before any batch has been), and a table of what it answers.
- `sources` — vendors a Reference may name besides the Provider, each a table of the same shape.
  The Provider is a source under its own name as well. A source not listed does not exist in this
  build.
- `telegram` — `"up"`, or `"down"`: every send fails.
- `sweeps` — sweeps that happened BEFORE the event, each `{at, down}`, run in order with the clock
  at `at`. They exist to give the engine its memory — a run of failed sweeps, a figure silent for
  several — which lives in no table, so **they may not change a row**: `tables` is the database
  as the event finds it. Their calls and messages are not part of the expectation. `down`, when not
  null, is that sweep's Provider failing with that message; otherwise it answers from its table.
- `tables` — every row of the five tables a door can see, every column, in primary-key order:
  `positions`, `monitors`, `monitor_positions`, `position_samples`, `reference_securities`.
  `schema_migrations` is not stated; build the database from `schema/schema.sql`.

Rows hold what SQLite holds — booleans as `0`/`1`, instants as UTC text
`YYYY-MM-DD HH:MM:SS.ffffff` — with one exception: the JSON columns (`monitors.legs`,
`positions.legs`, `position_samples.legs_iv`, `position_samples.legs_vega`) are written as the
JSON they contain, and compared as values. Their stored bytes differ between languages by design
(`8050` against `8050.0`) and nothing reads them but a JSON parser.

### A vendor's table

`{down, rejects, unknown, quotes}`. A call asks for a list of codes and gets, in this order:

1. an error with the message `down`, if it is not null;
2. an error with the message of the first requested code listed in `rejects` — moomoo refuses a
   whole batch over one code;
3. otherwise a batch: a record `{"code": <code>, ...quotes[code]}` for each requested code in
   `quotes`, the requested codes in `unknown` reported as unknown, and nothing for the rest. A code
   with no answer is "subscribed, nothing yet", which is not the same as unknown.

Every call is recorded, the failed ones included.

### Ids

A write that mints an id gets the n-th id of the event — n counted from 1 — written in hexadecimal
and zero-padded to 32 characters: `00000000000000000000000000000001`. Inject it; do not scrub it.

## The event, and what is expected

Build the service on the world with only the vendors, Telegram, the clock and the id minter faked
— the real routes, the real bot, the real engine — run the earlier sweeps, set the clock to
`clock`, then do the one thing. Every `expect` has:

- `rows` — what the event did to the tables, by primary key: per table, `added` (whole rows),
  `changed` (`{key, from, to}`, naming only the columns that moved), `removed` (keys). A table
  nothing happened to is absent; `{}` is a door that wrote nothing.
- `calls` — per vendor, by name, the codes each call asked for, in the order the calls were made.
  A vendor that was not asked is absent.

### `http/`

`request` is `{method, path, headers, body}`. Send `body` as JSON with
`Content-Type: application/json`, or no body when it is null. `expect.response` is the `status`
and the `body`: parsed JSON, `null` when empty, the raw text when not JSON.

### `bot/`

`update` is a Telegram update, in Telegram's shape. Hand it to the bot's update handler (not the
long poll). `expect.reply` is what the bot sent back with `sendMessage` — `{chat_id, text,
parse_mode}`, `parse_mode` null when not set — or null for no reply at all.

### `sweep/`

One sweep, at `clock`. `expect.messages` is every message Telegram accepted, in order: none when
`telegram` is `"down"`, and none when `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is blank.
`outcomes` names what the tick demonstrates, from `backend/testing/scenarios/outcomes.ts`; the
TypeScript checks each claim against the file, and another runner may ignore it.

## Comparing

As JSON values: object key order does not matter, array order does, a boolean is not a number,
numbers compare as IEEE doubles — exactly, with no tolerance. `1` and `1.0` are the same number;
`3.1000000000000005` and `3.1` are not, and the inputs are priced in quarters so a reader rarely
meets the difference.

Not held here, on purpose: the bodies of `/openapi.json` and `/docs`, which ADR 0021 leaves open,
and the service's own log lines.
