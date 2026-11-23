# IB Gateway conversations

What IB Gateway says to a read-only quote fetch, and since ADR 0030 to a read of the account, one
conversation per file, written down once so that two clients can be held to the same answers (ADR
0021, Decision 7): the TypeScript's own socket client, and the Python's, built on `ib_async`. Each
client is handed the same recording through a stub gateway and asked for the same codes, or the
same account; each must produce the same quote batch, or the same account answer.

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
| `not-subscribed` | recorded 2026-11-10 | the control, then INDU as a stream: resolved, then refused with 354 |
| `index-in-the-session` | recorded 2026-11-10 | the control, then SPX and VIX as streams: every figure in one burst, then SPX's updates; and both as snapshots, which carry only empty prices |
| `link-down` | constructed | farm-broken notices against -1, then silence (observed 2026-11-08) |
| `link-down-between-asks` | constructed | normal-with-greeks' answer, then on a second ask its market data is silent, behind a cached contract id (observed 2026-11-08) |
| `unentitled-account` | constructed | a normal session, then silence (observed 2026-11-08) |
| `feed-held-elsewhere` | constructed | a normal session, then silence (observed 2026-11-09) |
| `never-answers` | constructed | the control answers; a second contract's lookup never does |
| `no-prices` | constructed | the normal answer with bid and ask sent as -1 |
| `client-id-in-use` | constructed | startApi refused with 326 against -1 |
| `session-never-starts` | constructed | the greeting, then nothing |
| `account-stocks-and-options` | constructed | a live account: stocks in USD (NASDAQ, NYSE) and HKD (SEHK), a long call and a short put with realised P&L, cash in SGD, the P&L and exchange rates under `$LEDGER-`; then the download end, and 2100 after the unsubscribe |
| `account-paper` | constructed | a paper account (`DU`): totals and one short option, then the download end, and 2100 after the unsubscribe |
| `account-several` | constructed | two managed accounts, each with its own subscription: a read naming neither refused, one naming the second answered, one naming an account not on the login refused |
| `account-never-ends` | constructed | account values and a holding, and no download end; 2100 after the unsubscribe the deadline sends |

The four account conversations are CONSTRUCTED, and every one always will be: the repository is
public, and nothing of the owner's account is committed (ADR 0030). `recordings.ts` refuses a
conversation with `accountReads` or a `reqAccountUpdates` exchange whose provenance says
`recorded`. They are laid out field for field as `ibapi` 9.81 encodes reqAccountUpdates and reads
its five answers at protocol 157, and that layout was CHECKED against a capture of the live gateway
on 2026-11-23, run with the owner's go-ahead on a client id that is not the service's; the capture
stayed on the owner's machine and none of its values is here. The LAYOUT it settled, which the
files follow: the greeting, then managedAccounts, nextValidId and notices 2104, 2106 and 2158;
every account value (NetLiquidation and TotalCashValue plain in the base code beside their `-S`
rows; the P&L only as `$LEDGER-UnrealizedPnL` and `$LEDGER-RealizedPnL` and the rates as
`$LEDGER-ExchangeRate`, for BASE and each currency), then the portfolio with the update time
(`HH:MM`) between its rows, then the download end; a stock's row with strike `0`, right `0`,
expiry and multiplier empty, an option's with a whole-number strike, multiplier `100` and exchange
`CBOE`; and exactly one message after each unsubscribe, error 2100 against -1, kept as the
exchange's `onCancel`. The symbols, contract ids,
quantities, prices, totals, exchange rates and clock times are invented, and the accounts
placeholders.

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
  // "accountReads": [{"wanted": null}],         // optional: account reads after the asks (ADR 0030)
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
- `sent` is what the recording session sent, for the reader — and for one field a stub matches
  on: a market-data request's field 17, `"1"` for a snapshot and `"0"` for a stream (rule 3).
- `atMs` is when each reply arrived after its request, in milliseconds, where it was measured.
  A replay of the corpus ignores it. It is kept as evidence — the model's greeks arrived 0.3 to
  1.7 seconds after the book in the captures of 2026-11-09, and the snapshot end after about
  eleven — and a stub told to PACE sends each reply at its `atMs`, scaled, for a client test whose
  claim is when something arrives (`fake.ts`' and `fake_gateway.py`'s `pace`).
- `onCancel` (market data only) is what the gateway said to `cancelMktData` for that request,
  sent after every recorded reply. For a snapshot that had ended, or a request it had refused, it
  is error 300; for a running stream, nothing. A cancel sent before a snapshot's end got no reply
  at all, and nothing after it (measured 2026-11-10) — which is what a pacing stub does (rule 5).
- `replies: []` is a request the gateway accepted and never answered. That is not the same as a
  request no exchange names, though a stub treats both alike: neither gets a reply.
- `accountReads` (optional, ADR 0030) is account reads, each naming the account it `wanted` or
  `null` for none, made in turn by the SAME client after `ask` and `later`. A conversation that only
  reads the account has `"ask": []`; one must do at least one or the other. Its exchanges are
  `"request": "reqAccountUpdates"`, with the `account` the subscribe names in place of a
  `contract`, `sent` that subscribe (`["6", "2", "1", <account>]`), its replies, and `onCancel` what
  the gateway said to the unsubscribe. The account messages carry the account and no request id, so
  there is no `$reqId` in them.
- **Account ids** are placeholders and only placeholders — `DU0000000`, `DU0000001`, `U0000000`,
  `U0000001` (`recordings.ts`' `PLACEHOLDER_ACCOUNTS`): `recordings.test.ts` refuses any other,
  wherever a message carries one (managedAccounts' list, an account value's account and
  AccountCode's value, a portfolio row's, the download end's, an exchange's and its subscribe's,
  and the account a read asks for) and anywhere in the file's text.
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
   exact text. A reqMktData must also ask the way the recording did: its field 17 equal to the
   exchange's `sent[17]`, `"1"` a snapshot and `"0"` a stream. Those are two questions with two
   answers — a snapshot of SPX carries no price at all, and its stream does — so a recording of
   one never answers the other. An exchange answers every request that names it, as often as
   asked — unless the file holds SEVERAL exchanges with the same `request` and `contract`. Those
   answer in turn: the first the first such request, the second the second, and the last every
   one after it. Count over the stub's life, not per connection, because what changed is the
   gateway and a client that reconnects does not undo it. A file with one exchange per request,
   which is every file but `link-down-between-asks`, is unaffected.
4. A request no exchange names gets nothing, ever.
5. On cancelMktData (`2`), send the `onCancel` of the market-data exchange that request id was
   answered from, if any. A stub told to pace that still has replies to send for that request
   sends none of them, and no `onCancel` either: a snapshot cancelled before its end got no reply
   and nothing after it. Send nothing for reqMarketDataType (`59`) or anything else; the real
   gateway sends nothing for the first, and the rest are not part of a quote fetch.

6. On reqAccountUpdates (`6`) subscribing (field 2 `"1"`), send the `replies` of the
   `reqAccountUpdates` exchange whose `account` field 3 names, as they are; one naming an account no
   exchange holds gets nothing. Stopping it (field 2 `"0"`) gets that exchange's `onCancel` (the
   2100, in every account conversation), or nothing where no exchange holds the account — and a
   stub told to pace that still has replies to send for that account sends none of them, but
   sends the `onCancel` all the same: unlike a snapshot cancelled before its end (rule 5), the live
   gateway answered every unsubscribe with exactly one 2100 (2026-11-23).

One rule is OPT-IN, for a client test and never for the corpus: told to (`oneSessionPerClientId`,
`one_session_per_client_id`), a stub answers a startApi whose client id another OPEN connection
holds with `client-id-in-use`'s `onStartApi` instead of the session's, so a client that opens a
second socket on one id is refused rather than passing unseen. Off by default, because whether
the real gateway refuses that second session or lets it displace the first in silence is
unverified (`client-id-in-use`'s provenance). Both stubs also count the startApi messages they
were sent and the connections open, and can drop every connection while staying up.

`ib_async`'s `IB.connectAsync` sends more than a quote fetch on connect: the account's positions
whatever its fetch flags say, and open and completed orders unless `readonly=True`. No recording
holds any of it, and none should — a quote fetch has nothing account-shaped in it, and the account
is read only when asked for (ADR 0030). So the Python client (`python/src/optionality/ibkr.py`)
does not connect that way: it connects `ib_async`'s `Client`, which performs the handshake and
sends nothing else, and sends exactly the TypeScript's messages after it. A stub needs no rule for
the rest, and the Python one, `python/tests/fake_gateway.py`, records every message it receives so
`test_ibkr_gateway.py` can hold the client to those five, and to reqAccountUpdates only where a
conversation reads the account. Rule 4 still answers anything a future client sends unasked: with
silence, which is what makes it visible.

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

A recording with `accountReads` gets one more field, each read with what it came to and every
account subscription the stub was sent because of it — so the two clients are held to the same
MESSAGES as well as the same answer, an unsubscribe after a deadline included:

```jsonc
  "accountReads": [
    { "wanted": null,
      "expect": { "account": "U•••••000", "paper": false, "base_currency": "USD", "updated_at": "14:32",
                  "totals": { … }, "exchange_rates": { "USD": 1, "HKD": 0.1284, … },
                  "holdings": [ … ] },
      "sent": [["6", "2", "1", "U0000000"], ["6", "2", "0", "U0000000"]] },
    { "wanted": "DU0000001",
      "expect": { "$refused": "IBKR_ACCOUNT (DU•••••001) names no account on this login, which has …" },
      "sent": [] }
  ]
```

An account read's `expect` is the answer, `{"$refused": message}` where the client refused to
choose an account (`IbkrAccountRefused` in both languages: a fact about the configuration, which
subscribes to nothing), or `{"$throws": message}` for any other failure.

`expect` is the batch, `{"records": [...], "unknown": [...]}` under the service's field names, or
`{"$throws": message}` — the golden cases' tag. A message that would name the stub's port, which
the OS picks, names `<port>` instead. Every reply is delivered at once, so the batch is what the
client makes of the gateway's **whole** answer; where that differs from what it made of the live
one, the recording's provenance says so (`index-in-the-session`: the live client finishes on
SPX's first burst, and the replay hands it three seconds of updates with it).

The batch is what must match, and for the Python client the thrown message does too, word for
word: `python/tests/test_ibkr_gateway.py` compares the whole `expect` (and each `later`) with the
golden cases' `same`, a raise included. A client that raises in the right place with other words
would be telling the owner something different about the same gateway.

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
