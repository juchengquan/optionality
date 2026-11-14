/** The sweep door's scenarios, as inputs: a world and ONE tick at its clock (ADR 0021).
 *
 *  Each names the outcomes it shows, from `outcomes.ts`, and `coverage.test.ts` checks the claim
 *  against what the tick actually did. Worlds are kept to what the outcome needs, so a file reads
 *  as one event rather than as a busy morning; where the engine's MEMORY matters — a run of failed
 *  sweeps, a figure silent for several — the earlier sweeps say so, and write nothing.
 */
import { buildSpxCode } from "optionality/domain/contract";
import type { Row, World } from "../format.ts";
import {
  BOOK, C7300, C7350, C7500, EXPIRED, P6350, P6400, PREMIUM_BOOK, at, combo, except, link, monitor, position, quote,
  sample, stored, world,
} from "./fixtures.ts";

export interface SweepInput {
  name: string;
  outcomes: string[];
  world: World;
}

/** OpenD with its websocket port shut, as the sweep sees it. */
const DOWN = "connect ECONNREFUSED 127.0.0.1:33333";

/** The short call's delta, and nothing else about it. */
const delta = (value: number) => ({ [C7300]: quote("SPXW 261218 7300C", 2.75, value) });

/** A rule already ringing, last told about `secondsAgo` before the clock. */
const ringing = (secondsAgo: number) => monitor({
  id: "mon-1", triggered: 1, last_value: 0.33,
  last_checked_at: stored(at(-15)), last_alarm_at: stored(at(-secondsAgo)),
});

/** A November condor, inside the manage-by window: 18 days left on the clock. */
const NOV = "2026-11-27";
const nov = (type: "CALL" | "PUT", strike: number) => buildSpxCode(NOV, type, strike);
const november = position({
  id: "pos-nov", name: "nov-condor", strike_date: NOV, opened_at: "2026-10-20",
});
const NOVEMBER_QUOTES = {
  [nov("CALL", 7300)]: quote("SPXW 261127 7300C", 1.25, 0.12),
  [nov("CALL", 7350)]: quote("SPXW 261127 7350C", 0.75, 0.08),
  [nov("PUT", 6400)]: quote("SPXW 261127 6400P", 2, -0.11),
  [nov("PUT", 6350)]: quote("SPXW 261127 6350P", 1.25, -0.08),
};

/** A condor on a Saturday expiry, 21 DTE on Saturday 14 November: its manage-by window opens that
 *  day, so no session has closed inside it yet (#380). */
const WEEKEND = "2026-12-05";
const weekendLeg = (type: "CALL" | "PUT", strike: number) => buildSpxCode(WEEKEND, type, strike);
const weekend = position({
  id: "pos-wkd", name: "wkd-condor", strike_date: WEEKEND, opened_at: "2026-10-20",
});
const WEEKEND_QUOTES = {
  [weekendLeg("CALL", 7300)]: quote("SPXW 261205 7300C", 1.75, 0.14),
  [weekendLeg("CALL", 7350)]: quote("SPXW 261205 7350C", 1, 0.09),
  [weekendLeg("PUT", 6400)]: quote("SPXW 261205 6400P", 2.5, -0.13),
  [weekendLeg("PUT", 6350)]: quote("SPXW 261205 6350P", 1.5, -0.09),
};

/** A contract as moomoo answers it out of hours (#380): bid 0 / ask 0, so its mapping derives NO
 *  mid (`midPrice`); the greeks and the rest of the record as before. */
const noBook = (q: Row): Row => {
  const { mid_price: _mid, ...rest } = q;
  return { ...rest, bid_price: 0, ask_price: 0 };
};
/** The whole condor out of hours. */
const NO_BOOK: Record<string, Row> = Object.fromEntries(Object.entries(BOOK).map(([c, q]) => [c, noBook(q)]));
/** 00:00:15 on Saturday 14 November in New York: out of session, moomoo quoting every option 0/0,
 *  and the November condor 13 days out — inside its manage-by window. */
const SATURDAY_MIDNIGHT = "2026-11-14T05:00:15.000Z";
/** 20:30 on Monday 9 November in New York: after the close, and moomoo quoting every option 0/0. */
const EVENING = "2026-11-10T01:30:00.000Z";

/** Earlier sweeps a cadence apart, the last of them `before` seconds ahead of the clock. */
const earlier = (downs: (string | null)[], cadence = 15, before = cadence) =>
  downs.map((down, i) => ({ at: at(-(before + (downs.length - 1 - i) * cadence)), down }));

/** The day's sample exactly as this book's quotes would write it — so a tick finds nothing to
 *  change. Kept in step with BOOK by the "sample-recorded" scenario, which writes the same row. */
const todays = sample({
  position_id: "pos-1", observed_on: "2026-11-09", dte: 39, cost_to_close: 3.25,
  legs_iv: { [C7300]: 14.5, [C7350]: 14.5, [P6400]: 19.25, [P6350]: 20 },
  legs_vega: { [C7300]: 4.25, [C7350]: 4.25, [P6400]: 4.25, [P6350]: 4.25 },
  legs_delta: { [C7300]: 0.21, [C7350]: 0.15, [P6400]: -0.18, [P6350]: -0.12 },
  // the batch's contract size, recorded with the row since migration 0013 (#380)
  contract_size: 100,
});

export const SWEEP: readonly SweepInput[] = [
  // --- one rule, one reading ----------------------------------------------------------------
  {
    name: "a breach crosses its threshold and says so",
    outcomes: ["alarm-fires"],
    world: world({
      tables: { monitors: [monitor({ id: "mon-1" })] }, provider: { quotes: delta(0.34) },
    }),
  },
  {
    // abs compares magnitudes, so a put's negative delta fires against a positive threshold
    name: "a put's negative delta breaches an absolute threshold",
    outcomes: ["alarm-fires"],
    world: world({
      tables: { monitors: [monitor({ id: "mon-1", option_type: "PUT", strike: 6400, threshold: 0.2 })] },
      provider: { quotes: { [P6400]: quote("SPXW 261218 6400P", 4.5, -0.22) } },
    }),
  },
  {
    name: "a breach that ends says so",
    outcomes: ["alarm-clears"],
    world: world({ tables: { monitors: [ringing(600)] }, provider: { quotes: delta(0.27) } }),
  },
  {
    name: "inside the cooldown the bell flips and the message waits",
    outcomes: ["alarm-cooldown-holds-the-message"],
    world: world({ tables: { monitors: [ringing(60)] }, provider: { quotes: delta(0.27) } }),
  },
  {
    name: "a breach that persists is repeated on its cadence",
    outcomes: ["alarm-reminds"],
    world: world({ tables: { monitors: [ringing(1800)] }, provider: { quotes: delta(0.36) } }),
  },
  {
    name: "a breach that persists inside its cadence only records the reading",
    outcomes: ["alarm-steady"],
    world: world({ tables: { monitors: [ringing(600)] }, provider: { quotes: delta(0.36) } }),
  },
  {
    // nothing configured counts as delivered: the bell rings in the database and on no phone
    name: "with Telegram not configured a breach is recorded and nobody is told",
    outcomes: ["telegram-not-configured"],
    world: world({
      settings: { TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" },
      tables: { monitors: [monitor({ id: "mon-1" })] },
      provider: { quotes: delta(0.34) },
    }),
  },

  // --- combos -------------------------------------------------------------------------------
  {
    name: "a combo is the signed sum of its legs from one call",
    outcomes: ["combo-is-a-signed-sum"],
    world: world({ tables: { monitors: [combo({ id: "mon-2" })] }, provider: { quotes: BOOK } }),
  },
  {
    // a quantity per leg (#351): a call butterfly's middle sold twice over, its value 2.75 − 2 × 1.75
    // + 0.5 = −0.25, so a rule on its size at or below 0.3 rings — counted once a leg, it would read 1.5
    name: "a butterfly's value counts its middle leg twice",
    outcomes: ["alarm-fires", "combo-is-a-signed-sum"],
    world: world({
      tables: { monitors: [combo({
        id: "mon-fly", code: "dec-fly", threshold: 0.3, direction: "below",
        legs: [
          { sign: 1, option_type: "CALL", strike: 7300 }, { sign: -1, option_type: "CALL", strike: 7350, qty: 2 },
          { sign: 1, option_type: "CALL", strike: 7500 },
        ],
      })] },
      provider: { quotes: { ...BOOK, [C7500]: quote("SPXW 261218 7500C", 0.5, 0.06) } },
    }),
  },
  {
    name: "a combo with a leg unpriced is not evaluated at all",
    outcomes: ["combo-skipped-for-a-missing-leg", "silence-counted"],
    world: world({
      tables: { monitors: [combo({ id: "mon-2" })] }, provider: { quotes: except(BOOK, C7350) },
    }),
  },

  // --- a price with no book (#380): held, neither evaluated nor counted -----------------------
  {
    // a 0 is never above anything: read as a price, the evening said "back below" and the bell
    // went off until the open. Ringing at 4.5 and owed a reminder, it gets neither.
    name: "a quote with no book neither clears a ringing above rule nor reminds it",
    outcomes: ["price-rule-held-without-a-quote"],
    world: world({
      clock: EVENING,
      tables: { monitors: [combo({
        id: "mon-2", triggered: 1, last_value: -4.5,
        last_checked_at: stored(at(-15, EVENING)), last_alarm_at: stored(at(-3600, EVENING)),
      })] },
      provider: { quotes: NO_BOOK },
    }),
  },
  {
    // a 0 is below everything: read as a price, a profit target rang every evening
    name: "a quote with no book does not ring a below rule",
    outcomes: ["price-rule-held-without-a-quote"],
    world: world({
      clock: EVENING,
      tables: { monitors: [combo({ id: "mon-2", direction: "below", threshold: 0.5 })] },
      provider: { quotes: NO_BOOK },
    }),
  },
  {
    // the market's answer, not a figure that failed to arrive: counted, every price rule would be
    // quarantined minutes into every evening. With a limit of one, silence would quarantine it here.
    name: "a quote with no book is not counted toward quarantine",
    outcomes: ["price-rule-held-without-a-quote"],
    world: world({
      clock: EVENING,
      settings: { QUARANTINE_AFTER_SILENT_SWEEPS: "1" },
      tables: { monitors: [combo({ id: "mon-2" })] },
      provider: { quotes: NO_BOOK },
    }),
  },
  {
    // the open quotes one leg before the other: the short call's 2.75 against a 0 read as a spread
    // worth 2.75 and rang a rule at 2, where the spread is worth 1.00 (13 Nov's 09:25 and 09:30)
    name: "a combo with one leg quoted and the other not is not evaluated",
    outcomes: ["price-rule-held-without-a-quote"],
    world: world({
      clock: "2026-11-09T14:30:05.000Z", // 09:30:05 in New York, the first sweep of the session
      tables: { monitors: [combo({ id: "mon-2", threshold: 2 })] },
      provider: { quotes: { [C7300]: BOOK[C7300]!, [C7350]: noBook(BOOK[C7350]!) } },
    }),
  },

  // --- rules it cannot evaluate -------------------------------------------------------------
  {
    // priced, but the watched figure is not in the quote: counted, not yet quarantined
    name: "a figure that does not arrive is counted and nothing is said",
    outcomes: ["silence-counted"],
    world: world({
      tables: { monitors: [monitor({ id: "mon-1" })] },
      provider: { quotes: { [C7300]: { name: "SPXW 261218 7300C", mid_price: 2.75 } } },
    }),
  },
  {
    name: "a figure that never arrives is quarantined at the limit",
    outcomes: ["quarantined-for-a-figure-that-never-arrives"],
    world: world({
      settings: { QUARANTINE_AFTER_SILENT_SWEEPS: "3" },
      tables: { monitors: [monitor({ id: "mon-1" })] },
      provider: { quotes: { [C7300]: { name: "SPXW 261218 7300C", mid_price: 2.75 } } },
      sweeps: earlier([null, null]),
    }),
  },
  {
    // and the rest of the sweep still alarms
    name: "a contract the Provider does not know is quarantined and never deleted",
    outcomes: ["quarantined-for-an-unknown-contract", "alarm-fires"],
    world: world({
      tables: {
        monitors: [
          monitor({ id: "mon-1" }),
          monitor({ id: "mon-3", strike: 7350, threshold: 0.1 }),
        ],
      },
      provider: { quotes: except(BOOK, C7300), unknown: [C7300] },
    }),
  },
  {
    // a combo's codes are built from its strike date, so a date the service refuses is a row it
    // cannot read at all; the healthy rule beside it is still swept
    name: "a row the engine cannot read is quarantined and the rest is swept",
    outcomes: ["quarantined-for-an-unreadable-row"],
    world: world({
      tables: {
        monitors: [monitor({ id: "mon-1" }), combo({ id: "mon-2", strike_date: "not-a-date" })],
      },
      provider: { quotes: delta(0.25) },
    }),
  },
  {
    // legs that parse but are not legs are as unreadable as legs that do not parse. A cast handed
    // this one to the maths, every leg priced, with NaN for the missing sign, while the Python's
    // models refused it (#266); both backends now refuse it where the row is read
    name: "a combo whose legs parse but are not legs is quarantined and the rest is swept",
    outcomes: ["quarantined-for-an-unreadable-row"],
    world: world({
      tables: {
        monitors: [
          monitor({ id: "mon-1" }),
          combo({
            id: "mon-2",
            legs: [{ option_type: "CALL", strike: 7300 }, { sign: 1, option_type: "CALL", strike: 7350 }],
          }),
        ],
      },
      provider: { quotes: BOOK },
    }),
  },

  // --- expiry -------------------------------------------------------------------------------
  {
    name: "an expired rule is muted with a notice and no longer fetched",
    outcomes: ["expired-and-muted"],
    world: world({ tables: { monitors: [monitor({ id: "mon-1", strike_date: EXPIRED })] } }),
  },
  {
    // past its grace period while still enabled: the service was down when it expired
    name: "a rule expired past its grace period is removed with a notice",
    outcomes: ["expired-and-removed"],
    world: world({ tables: { monitors: [monitor({ id: "mon-1", strike_date: "2026-10-30" })] } }),
  },
  {
    // the links go first, or the foreign key refuses; the holding stays
    name: "a muted rule past its grace period is removed quietly with its links",
    outcomes: ["expired-and-removed-quietly"],
    world: world({
      tables: {
        positions: [position({
          id: "pos-oct", name: "oct-condor", strike_date: "2026-10-30", opened_at: null,
        })],
        monitors: [monitor({
          id: "mon-1", strike_date: "2026-10-30", enabled: 0, disabled_reason: "expired",
          scope: "leg",
        })],
        monitor_positions: [link("mon-1", "pos-oct")],
      },
    }),
  },

  // --- the Provider, over several sweeps ----------------------------------------------------
  {
    name: "one failed sweep is counted and nothing is said",
    outcomes: ["provider-down-counted"],
    world: world({ tables: { monitors: [monitor({ id: "mon-1" })] }, provider: { down: DOWN } }),
  },
  {
    name: "the fifth consecutive failure says monitoring is degraded",
    outcomes: ["degraded-notice"],
    world: world({
      tables: { monitors: [monitor({ id: "mon-1" })] },
      provider: { down: DOWN },
      sweeps: earlier([DOWN, DOWN, DOWN, DOWN]),
    }),
  },
  {
    name: "an outage still going after the repeat interval is said again with its length",
    outcomes: ["still-degraded-reminder"],
    world: world({
      tables: { monitors: [monitor({ id: "mon-1" })] },
      provider: { down: DOWN },
      // the fifth of these announced it, exactly one repeat interval before the clock
      sweeps: earlier([DOWN, DOWN, DOWN, DOWN, DOWN], 15, 1800),
    }),
  },
  {
    name: "the first sweep to work after an announced outage says it recovered",
    outcomes: ["recovered-notice"],
    world: world({
      tables: { monitors: [monitor({ id: "mon-1" })] },
      provider: { quotes: delta(0.25) },
      sweeps: earlier([DOWN, DOWN, DOWN, DOWN, DOWN]),
    }),
  },
  {
    // failures that never run five in a row, five times in fifteen minutes
    name: "a Provider that keeps dropping and recovering is called unreliable",
    outcomes: ["flapping-notice"],
    world: world({
      tables: { positions: [position({ id: "pos-1" })] },
      provider: { down: DOWN },
      sweeps: earlier([DOWN, null, DOWN, null, DOWN, null, DOWN, null], 60),
    }),
  },
  {
    // told at the fifth failure, ten minutes ago, and dropping every two minutes since: at 600s
    // it is said again, where the default 1800 would still be quiet
    name: "a Provider still dropping is called unreliable again after FLAPPING_REPEAT_SECONDS",
    outcomes: ["flapping-notice"],
    world: world({
      settings: { FLAPPING_REPEAT_SECONDS: "600" },
      tables: { positions: [position({ id: "pos-1" })] },
      provider: { down: DOWN },
      sweeps: earlier(Array.from({ length: 18 }, (_, i) => (i % 2 === 0 ? DOWN : null)), 60),
    }),
  },
  {
    // told at the end of a bout exactly half an hour ago, and dropping again now: the default
    // would say so, and 0 never does — nothing marks the end of a bout, so nothing clears the
    // stamp. No sweeps between the bouts: a success there would change nothing the engine keeps.
    name: "with FLAPPING_REPEAT_SECONDS=0 a Provider is called unreliable once and never again",
    outcomes: ["flapping-not-repeated"],
    world: world({
      settings: { FLAPPING_REPEAT_SECONDS: "0" },
      tables: { positions: [position({ id: "pos-1" })] },
      provider: { down: DOWN },
      sweeps: [
        ...earlier([DOWN, null, DOWN, null, DOWN, null, DOWN, null, DOWN], 60, 1800),
        ...earlier([DOWN, null, DOWN, null, DOWN, null, DOWN, null], 60),
      ],
    }),
  },

  // --- holdings -----------------------------------------------------------------------------
  {
    // a holding joins the batch whether or not a rule watches it
    name: "the day's sample is recorded for a holding nothing watches",
    outcomes: ["sample-recorded"],
    world: world({ tables: { positions: [position({ id: "pos-1" })] }, provider: { quotes: BOOK } }),
  },
  {
    // the index the day's row was observed against, derived from the sweep's own batch (ADR 0024)
    name: "the day's sample records SPX's price from the batch's premiums",
    outcomes: ["sample-recorded", "sample-records-spx"],
    world: world({ tables: { positions: [position({ id: "pos-1" })] }, provider: { quotes: PREMIUM_BOOK } }),
  },
  {
    // ADR 0022: closed is kept, not held — its last sample is how it ended, and nothing more is
    // written over it. With nothing else to ask about, the sweep asks nothing at all.
    name: "a closed holding is neither fetched nor sampled",
    outcomes: ["nothing-to-sweep"],
    world: world({
      tables: { positions: [position({ id: "pos-1", closed_on: "2026-11-06", exit: 1.25 })] },
      provider: { quotes: BOOK },
    }),
  },
  {
    // ...and beside one still held, only the held one joins the batch and gets the day's sample
    name: "only the holding still held is sampled beside a closed one",
    outcomes: ["sample-recorded"],
    world: world({
      tables: {
        positions: [
          position({ id: "pos-1" }),
          position({
            id: "pos-2", name: "dec-call-spread", entry: 2.5, closed_on: "2026-11-06", exit: 0.75,
            legs: [
              { side: "short", option_type: "CALL", strike: 7500 },
              { side: "long", option_type: "CALL", strike: 7550 },
            ],
          }),
        ],
      },
      provider: { quotes: BOOK },
    }),
  },
  {
    // a holding is not a rule, so one that cannot be read is not quarantined: it costs its own
    // place in the batch and its own sample, and nothing else. A cast asked for its contracts with
    // "sold" for a side (#266)
    name: "a holding whose legs parse but are not legs is left out and the rest is sampled",
    outcomes: ["sample-recorded"],
    world: world({
      tables: {
        positions: [
          position({ id: "pos-1" }),
          position({
            id: "pos-2", name: "dec-call-spread", entry: 2.5,
            legs: [
              { side: "sold", option_type: "CALL", strike: 7500 },
              { side: "long", option_type: "CALL", strike: 7550 },
            ],
          }),
        ],
      },
      provider: { quotes: BOOK },
    }),
  },
  {
    name: "the day's sample is rewritten when the mark moves",
    outcomes: ["sample-rewritten-when-it-moves"],
    world: world({
      tables: {
        positions: [position({ id: "pos-1" })], position_samples: [{ ...todays, cost_to_close: 3.5 }],
      },
      provider: { quotes: BOOK },
    }),
  },
  {
    name: "the day's sample is not rewritten when nothing moved",
    outcomes: ["sample-not-rewritten-when-unchanged"],
    world: world({
      tables: { positions: [position({ id: "pos-1" })], position_samples: [todays] },
      provider: { quotes: BOOK },
    }),
  },
  {
    // the row is the day's close: after 16:15 in New York a moved mark leaves a complete row alone,
    // which is what stops an overnight mark from becoming what the burndown calls the close. Every
    // leg is priced and the stored cost differs, so only the rule stands between this and a write.
    name: "after the close a complete row is not rewritten, however the mark moved",
    outcomes: ["complete-row-left-alone-after-hours"],
    world: world({
      clock: "2026-11-09T21:30:00.000Z", // 16:30 in New York, the same market day
      tables: {
        positions: [position({ id: "pos-1" })],
        position_samples: [{ ...todays, cost_to_close: 3.5 }],
      },
      provider: { quotes: BOOK },
    }),
  },
  {
    // recorded in the Singapore morning, which is New York's evening after the close: the holding
    // has no row for the day yet, so it gets one now, dated the market day it was put on
    name: "a holding recorded after the close gets its first sample that evening",
    outcomes: ["day-filled-after-hours", "sample-recorded"],
    world: world({
      clock: "2026-11-10T01:30:00.000Z", // 20:30 on Monday 9 November in New York
      tables: { positions: [position({ id: "pos-1", opened_at: "2026-11-09" })] },
      provider: { quotes: BOOK },
    }),
  },
  {
    // a session missed whole — a reboot waiting at the FileVault login, OpenD waiting for one — is
    // filled that evening rather than left as a hole the vol chain cannot cross
    name: "a day whose session was missed is filled after hours",
    outcomes: ["day-filled-after-hours", "sample-recorded"],
    world: world({
      clock: "2026-11-10T01:30:00.000Z", // 20:30 on Monday 9 November in New York
      tables: {
        positions: [position({ id: "pos-1" })],
        position_samples: [{ ...todays, observed_on: "2026-11-08", dte: 40 }],
      },
      provider: { quotes: BOOK },
    }),
  },
  {
    // the first sweep after midnight filled the day from overnight marks; the session was then
    // missed; the service is back at 20:30 and the evening's reading replaces that fill
    name: "a midnight fill is replaced by the evening's reading after a missed session",
    outcomes: ["provisional-row-replaced-after-hours", "sample-rewritten-when-it-moves"],
    world: world({
      clock: "2026-11-10T01:30:00.000Z", // 20:30 on Monday 9 November in New York
      tables: {
        positions: [position({ id: "pos-1" })],
        // filled at 00:05 that day, from marks that have moved since
        position_samples: [{ ...todays, cost_to_close: 3.5, observed_at: "2026-11-09 05:05:00.000000" }],
      },
      provider: { quotes: BOOK },
    }),
  },
  {
    // a Saturday: filled just after midnight, and nothing has moved since — but the row is restamped
    // in the hours, so it reads as that day's close carried forward rather than an overnight mark
    name: "a weekend's midnight fill is restamped in the hours though nothing moved",
    outcomes: ["provisional-row-restamped-in-hours"],
    world: world({
      clock: "2026-11-07T16:00:00.000Z", // 11:00 on Saturday 7 November in New York
      tables: {
        positions: [position({ id: "pos-1" })],
        position_samples: [
          { ...todays, observed_on: "2026-11-07", dte: 41, observed_at: "2026-11-07 05:05:00.000000" },
        ],
      },
      provider: { quotes: BOOK },
    }),
  },
  {
    // before the open only a missing row is filled: the midnight fill stands, though the overnight
    // marks have moved since
    name: "before the open a row already filled is left alone",
    outcomes: ["row-left-alone-before-the-open"],
    world: world({
      clock: "2026-11-09T10:00:00.000Z", // 05:00 on Monday 9 November in New York
      tables: {
        positions: [position({ id: "pos-1" })],
        position_samples: [{ ...todays, cost_to_close: 3.5, observed_at: "2026-11-09 05:05:00.000000" }],
      },
      provider: { quotes: BOOK },
    }),
  },
  {
    // settled at 20:30, so a mark that moves before midnight does not reach it
    name: "a row settled after the close is left alone up to midnight",
    outcomes: ["complete-row-left-alone-after-hours"],
    world: world({
      clock: "2026-11-10T04:59:00.000Z", // 23:59 on Monday 9 November in New York
      tables: {
        positions: [position({ id: "pos-1" })],
        position_samples: [{ ...todays, cost_to_close: 3.5, observed_at: "2026-11-10 01:30:00.000000" }],
      },
      provider: { quotes: BOOK },
    }),
  },
  {
    // the feed withheld the vegas all session: the evening's sweep has them, and completes the row
    name: "a day's row without its vegas is completed after hours",
    outcomes: ["incomplete-row-completed-after-hours", "sample-rewritten-when-it-moves"],
    world: world({
      clock: "2026-11-10T01:30:00.000Z", // 20:30 on Monday 9 November in New York
      tables: {
        positions: [position({ id: "pos-1" })],
        position_samples: [{ ...todays, legs_vega: null }],
      },
      provider: { quotes: BOOK },
    }),
  },
  {
    // out of hours no leg has a book, so there is no Cost to close — but the vol is served, and the
    // chain needs the day: kept with its readings and an EMPTY cost, never a 0.00 (#380)
    name: "a day with no book is kept for its vol with an empty cost",
    outcomes: ["sample-kept-with-an-empty-cost", "day-filled-after-hours", "sample-recorded"],
    world: world({
      clock: EVENING,
      tables: { positions: [position({ id: "pos-1", opened_at: "2026-11-09" })] },
      provider: { quotes: NO_BOOK },
    }),
  },
  {
    // in the hours a row is rewritten whenever its figures move, and the open quotes one leg before
    // another: a costless reading must not blank the day's price (#380)
    name: "an empty cost never replaces the day's stored cost",
    outcomes: ["stored-cost-kept-from-an-empty-one"],
    world: world({
      tables: { positions: [position({ id: "pos-1" })], position_samples: [todays] },
      provider: { quotes: { ...BOOK, [C7350]: noBook(BOOK[C7350]!) } },
    }),
  },
  {
    name: "no sample is recorded while a leg is unpriced",
    outcomes: ["sample-skipped-for-an-unpriced-leg"],
    world: world({
      tables: { positions: [position({ id: "pos-1" })] }, provider: { quotes: except(BOOK, P6350) },
    }),
  },
  {
    name: "a holding inside its manage-by window is announced once with its pace",
    outcomes: ["manage-by-notice", "sample-recorded"],
    world: world({ tables: { positions: [november] }, provider: { quotes: NOVEMBER_QUOTES } }),
  },
  {
    // undelivered, so not stamped: owed to the next sweep rather than lost for ever. Priced, so it
    // is Telegram that holds it here and not the want of a cost (#380, below)
    name: "a manage-by notice Telegram did not take is owed rather than stamped",
    outcomes: ["manage-by-notice-undelivered-is-owed"],
    world: world({ telegram: "down", tables: { positions: [november] }, provider: { quotes: NOVEMBER_QUOTES } }),
  },
  {
    // #380: first inside the window out of hours — the window opened today, Saturday — with every leg
    // 0/0 and no close yet: the notice goes once, so it waits for a cost rather than going without one
    // for good. Not sent, not stamped
    name: "a manage-by notice waits for a cost rather than going without one",
    outcomes: ["manage-by-notice-held-without-a-cost", "sample-kept-with-an-empty-cost"],
    world: world({
      clock: SATURDAY_MIDNIGHT,
      tables: { positions: [weekend] },
      provider: { quotes: Object.fromEntries(Object.entries(WEEKEND_QUOTES).map(([c, q]) => [c, noBook(q)])) },
    }),
  },
  {
    // ...but not for ever: the November condor entered its window on Friday the 6th, and whole
    // sessions have closed since with no price and no close. Waiting will not bring one, so it goes
    // without its "now" line, as before #380, and is stamped
    name: "a manage-by notice still without a cost after a whole session goes without one",
    outcomes: ["manage-by-notice-without-a-cost-after-a-session", "sample-kept-with-an-empty-cost"],
    world: world({
      clock: SATURDAY_MIDNIGHT,
      tables: { positions: [november] },
      provider: { quotes: Object.fromEntries(Object.entries(NOVEMBER_QUOTES).map(([c, q]) => [c, noBook(q)])) },
    }),
  },
  {
    // ...and out of hours with a close stored, the notice says that close's cost, its day, and its
    // pace at that close's own DTE
    name: "out of hours a manage-by notice is valued from the latest close",
    outcomes: ["manage-by-notice-from-the-close"],
    world: world({
      clock: SATURDAY_MIDNIGHT,
      tables: {
        positions: [november],
        position_samples: [
          sample({
            position_id: "pos-nov", observed_on: "2026-11-13", dte: 14, cost_to_close: 2.25,
            observed_at: "2026-11-13 21:14:59.000000", contract_size: 100,
          }),
          // Saturday's row is already filled, so this sweep writes nothing beside the notice
          sample({
            position_id: "pos-nov", observed_on: "2026-11-14", dte: 13, cost_to_close: null,
            observed_at: "2026-11-14 05:00:05.000000",
          }),
        ],
      },
      provider: { quotes: Object.fromEntries(Object.entries(NOVEMBER_QUOTES).map(([c, q]) => [c, noBook(q)])) },
    }),
  },
  {
    name: "an empty book is swept without asking the Provider anything",
    outcomes: ["nothing-to-sweep"],
    world: world(),
  },
];
