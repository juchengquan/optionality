# IB Gateway conversations

What IB Gateway says to a read-only quote fetch, one conversation per file, written down once so
that two clients can be held to the same answers (ADR 0021, Decision 7): the TypeScript's own
socket client, and the Python's, built on `ib_async`. Each client is handed the same recording
through a stub gateway and asked for the same codes; each must produce the same quote batch.

- `*.json` here are the **recordings**. They are inputs, assembled from captures or constructed
  by hand, and `make cases` never writes them.
- `expected/*.json` are **generated**: what `typescript/src/vendors/ibkr/client.ts` returned (or
  threw) for each recording, replayed through `fake.ts`. `make cases` writes them, and
  `make check-cases` and the library's suite fail when one is stale or missing. Never edit them.

Like `../ibkr-fields.json`, none of this is in the `GOLDEN_CASES` fingerprint.

## Provenance comes first

Every file says where its replies came from, in `provenance`:

- `"kind": "recorded"` — captured from the real gateway: `at` (UTC), `gateway`, `protocol`,
  `how`, and `altered`, which lists every byte changed afterwards (the managed account number, so
  far, which is the owner's).
- `"kind": "constructed"` — built by hand because it could not be recorded: `why`, `built` (from
  what, and what was invented), and `observed` where an observation backs the shape.

A construction is never labelled a recording. The stub these files replaced carried two greeks
invented under a comment claiming measurement, and a contract reply cut down to the fields one
client read, which is why `ib_async` could not decode it.

| conversation | kind | what the gateway does |
| --- | --- | --- |
| `normal-with-greeks` | recorded 2026-11-09 | resolves SPXW 20261218 C 8100 and prices it: book, close, greeks, snapshot end |
| `unknown-contract` | recorded 2026-11-09 | the control, then a strike it does not list: 200 |
| `not-subscribed` | recorded 2026-11-09 | the control, then INDU: resolved, then refused with 354 |
| `index-before-the-open` | recorded 2026-11-09 | the control, then SPX the index: one close tick with an empty price |
| `link-down` | constructed | farm-broken notices against -1, then silence (observed 2026-11-08) |
| `link-down-between-asks` | constructed | normal-with-greeks' answer, then on a second ask its market data is silent, behind a cached contract id (observed 2026-11-08) |
| `unentitled-account` | constructed | a normal session, then silence (observed 2026-11-08) |
| `feed-held-elsewhere` | constructed | a normal session, then silence (observed 2026-11-09) |
| `never-answers` | constructed | the control answers; a second contract's lookup never does |
| `no-prices` | constructed | the normal answer with bid and ask sent as -1 |
| `client-id-in-use` | constructed | startApi refused with 326 against -1 |
| `session-never-starts` | constructed | the greeting, then nothing |

## The format

Every protocol message is a list of **strings**, its fields in order, each exactly the text the
wire carried: `"4.10"` stays `"4.10"`, and `"2.1436871413159725E-4"` stays as written. On the wire
a message is those fields, each followed by a NUL byte, the whole prefixed by its length in bytes
as a 4-byte big-endian integer.

```jsonc
{
  "conversation": "unknown-contract",            // the file's own name
  "summary": "…",
  "provenance": { "kind": "recorded", "at": "2026-11-09T11:21:24Z", … },
  "ask": ["US.SPXW261218C8100000", "US.SPXW261218C8101000"],   // the service codes to fetch
  // "later": [["US.SPXW261218C8100000"]],      // optional: asks made after it, on one connection
  "handshake": {
    "greeting": ["157", "20261109 19:21:23 SGT"],  // the answer to the client's version range
    "onStartApi": [                                // sent, in order, when startApi arrives
      ["15", "1", "DU0000000"],                    // managedAccounts, BEFORE nextValidId
      ["9", "1", "1"],                             // nextValidId: the session is up
      ["4", "2", "-1", "2104", "Market data farm connection is OK:usfarm.nj"]
    ]
  },
  "exchanges": [
    {
      "request": "reqContractDetails",             // or "reqMktData"
      "contract": { "symbol": "SPX", "secType": "OPT", "lastTradeDateOrContractMonth": "20261218",
                    "strike": "8101.0", "right": "C", "exchange": "SMART", "tradingClass": "SPXW" },
      "sent": ["9", "8", "$reqId", "0", "SPX", "OPT", "20261218", "8101.0", "C", …],
      "replies": [
        ["4", "2", "$reqId", "200", "No security definition has been found for the request"]
      ],
      "atMs": [180]
    }
  ]
}
```

- `$reqId` stands for the id of the request being answered. Replace **every occurrence**, inside
  text too — error 300 reads `Can't find EId with tickerId:$reqId`.
- `sent` is what the recording session sent, for the reader. A stub matches on `contract`.
- `atMs` is when each reply arrived after its request, in milliseconds, where it was measured.
  A replay ignores it. It is kept as evidence: the model's greeks arrived 0.3 to 1.7 seconds
  after the book in the captures of 2026-11-09, and the snapshot end after about eleven.
- `onCancel` (market data only) is what the gateway said to `cancelMktData` for that request.
  For a snapshot that has already ended it is error 300.
- `replies: []` is a request the gateway accepted and never answered. That is not the same as a
  request no exchange names, though a stub treats both alike: neither gets a reply.
- `later` (optional) is further asks, each a list of codes, made in turn by the SAME client after
  `ask`, so the connection and whatever the client cached on earlier asks carry over. Absent, the
  conversation is one ask, as most are. It exists for a fault only a warm cache shows: the
  service holds its session for days, so a link that drops is met on a later ask, behind contract
  ids resolved before it dropped (`link-down-between-asks`). A file says what changes between asks
  by holding more than one exchange for a request (rule 3).

## How a stub replays a file

The rules `typescript/src/vendors/ibkr/fake.ts` follows, which a stub in any language follows too:

1. The client opens with `API\0` raw, then one framed message, its version range (`v156..157`
   from the TypeScript; `v157..178` from `ib_async`). Answer with `handshake.greeting`. Every
   recording here is protocol **157**, inside both clients' ranges; a client whose range excludes
   it cannot replay it.
2. On startApi (message `71`), send `handshake.onStartApi`, in order. `ib_async` will not report
   a connection until managedAccounts has named an account, so a recording that starts a session
   carries one: `DU0000000`, the shape of the owner's paper account and not its number.
3. On reqContractDetails (`9`) or reqMktData (`1`), find the exchange with that `request` whose
   `contract` the request names, and send its `replies` with `$reqId` filled in. Both requests
   carry the contract at the same positions at protocol 157: symbol at field 4, secType 5,
   lastTradeDateOrContractMonth 6, strike 7, right 8, exchange 10, tradingClass 14. Compare the
   strike as a number (`8100.0` and `8100` are one double to the gateway) and everything else as
   exact text. An exchange answers every request that names it, as often as asked — unless the
   file holds SEVERAL exchanges with the same `request` and `contract`. Those answer in turn: the
   first the first such request, the second the second, and the last every one after it. Count
   over the stub's life, not per connection, because what changed is the gateway and a client
   that reconnects does not undo it. A file with one exchange per request, which is every file
   but `link-down-between-asks`, is unaffected.
4. A request no exchange names gets nothing, ever.
5. On cancelMktData (`2`), send the `onCancel` of the market-data exchange that request id was
   answered from, if any. Send nothing for reqMarketDataType (`59`) or anything else; the real
   gateway sends nothing for the first, and the rest are not part of a quote fetch.

`ib_async` sends more than a quote fetch on connect (positions, open orders and the like). No
recording holds them, so by rule 4 they go unanswered; the Python client is expected to connect
with `readonly=True` and its startup fetch off (`python/src/optionality/ibkr.py`).

## What an expectation says

```jsonc
{
  "conversation": "link-down",
  "provenance": "constructed",                     // the recording's kind, repeated
  "client": "typescript/src/vendors/ibkr/client.ts",
  "config": { "clientId": 31419, "connectTimeoutMs": 1000, "requestTimeoutMs": 1000, "quietMs": 250 },
  "ask": ["US.SPXW261218C8100000"],
  "expect": { "$throws": "IB Gateway accepted 1 request(s) and answered none of them — …" }
}
```

A recording with `later` asks gets one more field after `expect`, each later ask with what it
came to, in order; a recording without them gets none, so its expectation is unchanged:

```jsonc
  "expect": { "records": [ … ], "unknown": [] },  // the first ask: priced
  "later": [
    { "ask": ["US.SPXW261218C8100000"],
      "expect": { "$throws": "IB Gateway accepted 1 market-data request(s) and answered none of them — …" } }
  ]
```

`expect` is the batch, `{"records": [...], "unknown": [...]}` under the service's field names, or
`{"$throws": message}` — the golden cases' tag. A message that would name the stub's port, which
the OS picks, names `<port>` instead. Every reply is delivered at once, so the batch is what the
client makes of the gateway's **whole** answer; where that differs from what it made of the live
one, the recording's provenance says so (`normal-with-greeks`: the live client missed the greeks).

The batch is what must match. Whether a second client must also reproduce a thrown message word
for word, rather than throw where this one throws, is for that client's phase to settle (ADR 0021,
phase 4).

Where it throws is the rule worth building to rather than discovering. A contract the gateway says
does not exist is `unknown`. SILENCE is a throw: when no contract that was asked for market data
sent anything back for it (a grade, a figure, greeks or an error), or, where no contract got that
far, no lookup was answered. That holds whatever the client has cached, which is what
`link-down-between-asks` is for: an empty batch there would be every watched figure missing, and as
the Provider that quarantines rules.

## Recording another

Read-only market-data requests only — contract details, market data type, market data, cancel —
on a spare client id (never the service's 31415, which the gateway would let a second connection
displace), with SPXW 20261218 C 8100 in every batch as the known-good control. A probe that gets
nothing back at all is void, not data: an outage and an absence look the same without a control.
Replace the managed account before the capture touches disk, write the provenance, add the file,
and run `make cases`.
