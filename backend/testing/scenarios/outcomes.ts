/** What one tick of the sweep can DO, stated — the sweep door's equivalent of `/openapi.json`'s
 *  endpoint list and the bot's "/" menu, which the other two doors read from the service itself.
 *  The engine has no such self-description, so this list is written by hand, and it is held to the
 *  engine two ways (`coverage.test.ts`):
 *
 *  - every DECISION the engine takes is named by some outcome here. A decision is a function the
 *    engine imports from `domain/` (ADR 0017 put every decision there) or one it exports for a
 *    sweep's batch (`engine/positions.ts`); anything it imports that is arithmetic rather than a
 *    decision is on `NOT_A_DECISION`, with its reason. A new import is therefore either a new
 *    outcome or a sentence saying why not — never silence.
 *  - every `disabled_reason` the engine writes appears in some scenario's rows, so a new kind of
 *    quarantine cannot arrive without a tick that shows it.
 *
 *  Derived by reading `engine/sweeper.ts`, `engine/health.ts` and `engine/positions.ts` branch by
 *  branch: every path that writes a row, sends a message, or deliberately does neither. Two paths
 *  are left out because no WORLD can reach them, only a fault injected beneath one: a row whose
 *  write SQLite refuses mid-sweep (`sweeper.test.ts` uses a trigger), and a rule muted while the
 *  sweep's own fetch is in flight (a race). Their suites keep them.
 *
 *  `shows` is how a scenario claiming the outcome must look, and is checked against every claim —
 *  a scenario cannot cover an outcome by saying so.
 */
import { inSampleHours, marketDate } from "optionality/domain/expiry";
import { monitorLegCodes, type Monitor } from "optionality/domain/monitor";
import { settingsFromEnv } from "../../src/env.ts";
import type { Change, Row, SweepScenario } from "./format.ts";

export interface Outcome {
  name: string;
  /** the engine's decision this exercises, or null for the engine's own control flow */
  decision: string | null;
  shows(s: SweepScenario): boolean;
}

const messages = (s: SweepScenario) => s.expect.messages;
const said = (s: SweepScenario, pattern: RegExp) => messages(s).some((m) => pattern.test(m));
const quiet = (s: SweepScenario) => messages(s).length === 0;
const changes = (s: SweepScenario, table: "monitors" | "positions"): Change[] =>
  s.expect.rows[table]?.changed ?? [];
const moved = (s: SweepScenario, column: string, to?: unknown) =>
  changes(s, "monitors").some((c) => column in c.to && (to === undefined || c.to[column] === to));
const untouched = (s: SweepScenario) => Object.keys(s.expect.rows).length === 0;
const asked = (s: SweepScenario) => Object.keys(s.expect.calls).length > 0;
const combos = (s: SweepScenario) => s.world.tables.monitors.filter((m: Row) => m.legs !== null);
/** Every code the tick asked for came back priced: a sample could have been written. */
const priced = (s: SweepScenario) => asked(s) && Object.values(s.expect.calls)
  .every((batches) => batches.every((codes) => codes.every((c) => c in s.world.provider.quotes)));
const NEW_YORK_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
/** Whether a code the tick asked for came back with no mid: no two-sided quote (#380). */
const bookless = (s: SweepScenario, code: string): boolean => {
  const q = s.world.provider.quotes[code];
  return q !== undefined && (q.mid_price === null || q.mid_price === undefined);
};
/** Whether the tick asked for a code that came back with no two-sided quote. */
const askedBookless = (s: SweepScenario) => Object.values(s.expect.calls)
  .some((batches) => batches.some((codes) => codes.some((c) => bookless(s, c))));
/** The world's enabled price rules whose every leg came back, one or more with no book. */
const heldRules = (s: SweepScenario): Row[] => s.world.tables.monitors.filter((m: Row) => {
  if (!m.enabled || m.field !== "mid_price") return false;
  const legs = typeof m.legs === "string" ? JSON.parse(m.legs) as unknown : m.legs;
  const codes = monitorLegCodes({ ...(m as unknown as Monitor), legs: legs as Monitor["legs"] });
  return codes.every((c) => c in s.world.provider.quotes) && codes.some((c) => bookless(s, c));
});

/** Whether a stored row was observed before its own day's 09:30 open: a fill from overnight marks. */
const provisional = (r: Row | undefined): boolean => {
  if (r === undefined || r.observed_at === null) return false;
  const stamp = String(r.observed_at);
  const at = new Date(`${stamp.slice(0, 10)}T${stamp.slice(11, 23)}Z`);
  const part = Object.fromEntries(NEW_YORK_CLOCK.formatToParts(at).map((p) => [p.type, p.value]));
  return Number(part.hour) * 60 + Number(part.minute) < 9 * 60 + 30;
};
/** Whether the clock is before 09:30 in New York, the open. */
const beforeOpen = (s: SweepScenario): boolean => {
  const part = Object.fromEntries(NEW_YORK_CLOCK.formatToParts(new Date(s.world.clock))
    .map((p) => [p.type, p.value]));
  return Number(part.hour) * 60 + Number(part.minute) < 9 * 60 + 30;
};
/** The stored row for the clock's market day, if the world holds one. */
const dayRow = (s: SweepScenario): Row | undefined => s.world.tables.position_samples
  .find((r: Row) => r.observed_on === marketDate(new Date(s.world.clock)));

export const OUTCOMES: readonly Outcome[] = [
  {
    name: "alarm-fires",
    decision: "alarmTransition",
    shows: (s) => said(s, / (crossed ≥|fell ≤) /) && !said(s, /\(reminder\)$/)
      && moved(s, "triggered", 1) && moved(s, "last_alarm_at"),
  },
  {
    name: "alarm-clears",
    decision: "alarmTransition",
    shows: (s) => said(s, / back (below|above) /) && moved(s, "triggered", 0),
  },
  {
    // the bell stays truthful, the message waits: the flag flips and the stamp of having spoken
    // does not move
    name: "alarm-cooldown-holds-the-message",
    decision: "alarmTransition",
    shows: (s) => quiet(s) && moved(s, "triggered") && !moved(s, "last_alarm_at"),
  },
  {
    name: "alarm-reminds",
    decision: "alarmTransition",
    shows: (s) => said(s, /\(reminder\)$/) && moved(s, "last_alarm_at") && !moved(s, "triggered"),
  },
  {
    // a reading that changes nothing but the reading: no flag, no stamp, no word
    name: "alarm-steady",
    decision: "alarmTransition",
    shows: (s) => quiet(s) && moved(s, "last_value") && !moved(s, "triggered")
      && !moved(s, "last_alarm_at"),
  },
  {
    name: "combo-is-a-signed-sum",
    decision: "monitorValue",
    shows: (s) => combos(s).some((m) => changes(s, "monitors")
      .some((c) => c.key.id === m.id && typeof c.to.last_value === "number")),
  },
  {
    // NO partial sums: one leg unpriced and the combo is not evaluated at all
    name: "combo-skipped-for-a-missing-leg",
    decision: "monitorValue",
    shows: (s) => quiet(s) && asked(s) && combos(s).length > 0
      && !changes(s, "monitors").some((c) => combos(s).some((m) => m.id === c.key.id)),
  },
  {
    // a figure that did not arrive, short of the limit: counted in memory, nothing written or said
    name: "silence-counted",
    decision: "silenceVerdict",
    shows: (s) => s.world.provider.down === null && quiet(s) && asked(s) && untouched(s),
  },
  {
    // every leg came back, one with no two-sided quote (#380): the market shut or not yet quoting.
    // HELD — not evaluated, not counted toward quarantine, nothing written or said — where a 0
    // used to clear an above rule, ring a below one, and a half-quoted combo rang at the open
    name: "price-rule-held-without-a-quote",
    decision: "holdsWithoutQuote",
    shows: (s) => s.world.provider.down === null && heldRules(s).length > 0 && quiet(s) && asked(s)
      && s.expect.rows.monitors === undefined,
  },
  {
    name: "quarantined-for-a-figure-that-never-arrives",
    decision: "silenceVerdict",
    shows: (s) => moved(s, "disabled_reason", "no-figure") && said(s, /consecutive sweeps$/),
  },
  {
    name: "quarantined-for-an-unknown-contract",
    decision: "unknownContractVerdict",
    shows: (s) => moved(s, "disabled_reason", "unknown-contract") && said(s, /unknown contract/),
  },
  {
    name: "quarantined-for-an-unreadable-row",
    decision: "unreadableNotice",
    shows: (s) => moved(s, "disabled_reason", "unreadable") && said(s, /could not be read/),
  },
  {
    name: "expired-and-muted",
    decision: "expiryVerdict",
    shows: (s) => moved(s, "disabled_reason", "expired") && said(s, /muted; auto-removes/),
  },
  {
    name: "expired-and-removed",
    decision: "expiryVerdict",
    shows: (s) => (s.expect.rows.monitors?.removed ?? []).length > 0 && said(s, /— removed$/),
  },
  {
    // removed once its grace period is over, saying nothing: the mute already said it
    name: "expired-and-removed-quietly",
    decision: "expiryVerdict",
    shows: (s) => (s.expect.rows.monitors?.removed ?? []).length > 0 && quiet(s),
  },
  {
    // a failed sweep short of the threshold: counted, and nothing else
    name: "provider-down-counted",
    decision: "degradedVerdict",
    shows: (s) => s.world.provider.down !== null && quiet(s) && untouched(s),
  },
  {
    name: "degraded-notice",
    decision: "degradedVerdict",
    shows: (s) => said(s, /^⚠️ monitoring degraded: /),
  },
  {
    name: "still-degraded-reminder",
    decision: "degradedVerdict",
    shows: (s) => said(s, /^⚠️ monitoring still degraded: /),
  },
  {
    name: "recovered-notice",
    decision: "recoveredNotice",
    shows: (s) => said(s, /^✅ monitoring recovered/),
  },
  {
    name: "flapping-notice",
    decision: "flappingVerdict",
    shows: (s) => said(s, /^⚠️ monitoring unreliable: /),
  },
  {
    // FLAPPING_REPEAT_SECONDS=0 after enough earlier failures to have been told: a failing tick,
    // and not a word. The knobs are read as the world reads them, defaults included.
    name: "flapping-not-repeated",
    decision: "flappingVerdict",
    shows: (s) => {
      const knobs = settingsFromEnv(s.world.settings);
      const failed = s.world.sweeps.filter((w) => w.down !== null).length;
      return knobs.flappingRepeatSeconds === 0 && failed >= knobs.flappingAfterFailures
        && s.world.provider.down !== null && quiet(s) && untouched(s);
    },
  },
  {
    name: "sample-recorded",
    decision: "recordSamples",
    shows: (s) => (s.expect.rows.position_samples?.added ?? []).length > 0,
  },
  {
    // the index the day's row was observed against, derived from the sweep's batch (ADR 0024)
    name: "sample-records-spx",
    decision: "derivedSpx",
    shows: (s) => (s.expect.rows.position_samples?.added ?? [])
      .some((r) => typeof (r as { spx?: unknown }).spx === "number"),
  },
  {
    // the day's row converges on the latest mark
    name: "sample-rewritten-when-it-moves",
    decision: "recordSamples",
    shows: (s) => (s.expect.rows.position_samples?.changed ?? []).length > 0,
  },
  {
    // 5,760 writes a day of the same row was the bug this guards
    name: "sample-not-rewritten-when-unchanged",
    decision: "recordSamples",
    shows: (s) => s.world.tables.position_samples.length > 0 && asked(s)
      && s.expect.rows.position_samples === undefined,
  },
  {
    // after the close a COMPLETE row is the day's close, and a mark that moved since does not reach
    // it. Every leg of the holding was priced, so a write was possible and differed from the row:
    // without the hours rule this tick would have rewritten it
    name: "complete-row-left-alone-after-hours",
    decision: "takesSample",
    shows: (s) => {
      const day = dayRow(s);
      return !inSampleHours(new Date(s.world.clock)) && priced(s) && day !== undefined
        && day.legs_iv !== null && day.legs_vega !== null && s.expect.rows.position_samples === undefined;
    },
  },
  {
    // a day with no row is filled whatever the hour: a trade recorded in New York's evening, after
    // the close, and a session missed whole both leave one, and the vol chain needs every day
    name: "day-filled-after-hours",
    decision: "takesSample",
    shows: (s) => !inSampleHours(new Date(s.world.clock)) && priced(s) && dayRow(s) === undefined
      && (s.expect.rows.position_samples?.added ?? [])
        .some((r) => r.observed_on === marketDate(new Date(s.world.clock))),
  },
  {
    // the midnight fill, a missed session, and the service back after the close: the provisional
    // row is replaced by the evening's reading rather than keeping its overnight mark
    name: "provisional-row-replaced-after-hours",
    decision: "takesSample",
    shows: (s) => !inSampleHours(new Date(s.world.clock)) && provisional(dayRow(s))
      && (s.expect.rows.position_samples?.changed ?? []).length > 0,
  },
  {
    // before the open a sweep only fills a day with no row: one that already stands is not touched,
    // however the overnight marks have moved since it was taken
    name: "row-left-alone-before-the-open",
    decision: "takesSample",
    shows: (s) => beforeOpen(s) && priced(s) && dayRow(s) !== undefined
      && s.expect.rows.position_samples === undefined,
  },
  {
    // a weekend's midnight fill restamped in the hours though no figure moved, so it stops reading
    // as an overnight mark
    name: "provisional-row-restamped-in-hours",
    decision: "takesSample",
    shows: (s) => inSampleHours(new Date(s.world.clock)) && provisional(dayRow(s))
      && (s.expect.rows.position_samples?.changed ?? []).some((c) => "observed_at" in c.to),
  },
  {
    // a row the feed left without its IV or vega is completed after hours by a sweep that has both
    name: "incomplete-row-completed-after-hours",
    decision: "takesSample",
    shows: (s) => {
      const day = dayRow(s);
      return !inSampleHours(new Date(s.world.clock)) && day !== undefined
        && (day.legs_iv === null || day.legs_vega === null)
        && (s.expect.rows.position_samples?.changed ?? [])
          .some((c) => (c.to.legs_iv ?? day.legs_iv) !== null && (c.to.legs_vega ?? day.legs_vega) !== null);
    },
  },
  {
    // no leg with a book, so no Cost to close: the day is kept for its vol readings with the cost
    // EMPTY, never stored as 0.00 (#380)
    name: "sample-kept-with-an-empty-cost",
    decision: "recordSamples",
    shows: (s) => askedBookless(s) && (s.expect.rows.position_samples?.added ?? [])
      .some((r) => r.cost_to_close === null && r.legs_iv !== null),
  },
  {
    // in the hours, where a moved figure rewrites the day's row, a reading with no cost leaves the
    // stored cost where it is (#380)
    name: "stored-cost-kept-from-an-empty-one",
    decision: "takesSample",
    shows: (s) => {
      const day = dayRow(s);
      return inSampleHours(new Date(s.world.clock)) && askedBookless(s) && day !== undefined
        && typeof day.cost_to_close === "number" && s.expect.rows.position_samples === undefined;
    },
  },
  {
    // one unpriced leg and there is no observation to make
    name: "sample-skipped-for-an-unpriced-leg",
    decision: "recordSamples",
    shows: (s) => s.world.tables.positions.length > 0 && asked(s)
      && s.expect.rows.position_samples === undefined && s.world.tables.position_samples.length === 0,
  },
  {
    name: "manage-by-notice",
    decision: "noticeManageBy",
    shows: (s) => said(s, /^⏰ /)
      && changes(s, "positions").some((c) => c.to.manage_notified_at !== undefined),
  },
  {
    // undelivered, so not stamped: the next sweep tries again rather than losing it for ever
    name: "manage-by-notice-undelivered-is-owed",
    decision: "noticeManageBy",
    shows: (s) => s.world.telegram === "down" && changes(s, "positions").length === 0 && quiet(s),
  },
  {
    // #380: a holding inside its window with no Cost to close to say — out of hours, every leg 0/0,
    // no close stored — is neither announced nor stamped, so the notice is not lost its "now" line
    name: "manage-by-notice-held-without-a-cost",
    decision: "noticeManageBy",
    shows: (s) => s.world.telegram === "up" && !said(s, /^⏰ /) && changes(s, "positions").length === 0
      && s.world.tables.positions.some((p: Row) => p.opened_at !== null && p.manage_notified_at === null),
  },
  {
    // ...but the wait is bounded: a whole session closed inside the window with still no cost, so
    // it goes without its "now" line, and is stamped
    name: "manage-by-notice-without-a-cost-after-a-session",
    decision: "sessionClosedSince",
    shows: (s) => said(s, /^⏰ /) && !said(s, / · /)
      && changes(s, "positions").some((c) => c.to.manage_notified_at !== undefined),
  },
  {
    // ...and with a close stored, it is valued from that close, which it names
    name: "manage-by-notice-from-the-close",
    decision: "noticeManageBy",
    shows: (s) => said(s, /^⏰ [^]* at the \d{4}-\d{2}-\d{2} close/)
      && changes(s, "positions").some((c) => c.to.manage_notified_at !== undefined),
  },
  {
    // nothing configured counts as delivered: the rows move, nobody's phone does
    name: "telegram-not-configured",
    decision: null,
    shows: (s) => quiet(s) && !untouched(s) && !s.world.settings.TELEGRAM_BOT_TOKEN,
  },
  {
    // nothing to ask about: no call at all
    name: "nothing-to-sweep",
    decision: null,
    shows: (s) => quiet(s) && untouched(s) && !asked(s),
  },
];

/** What the engine imports that decides nothing on its own, and why it is not an outcome. */
export const NOT_A_DECISION: Readonly<Record<string, string>> = {
  alarmPolicy: "reads two knobs for alarmTransition",
  degradedPolicy: "reads two knobs for degradedVerdict",
  flappingPolicy: "reads the knobs for flappingVerdict",
  monitorLegCodes: "which codes a rule asks for; every outcome that fetches asks",
  positionLegCodes: "which codes a holding asks for; every sample outcome asks",
  daysToExpiry: "arithmetic inside recordSamples and noticeManageBy",
  marketDate: "the day recordSamples keys a sample on",
  dteAtOpen: "arithmetic inside noticeManageBy",
  onPace: "arithmetic inside noticeManageBy",
  costToClose: "arithmetic inside recordSamples and noticeManageBy",
  legReadings: "arithmetic inside recordSamples",
  contractSize: "the size recordSamples stores beside a row's cost (#380)",
  valuedTiming: "the words noticeManageBy names a close's timing in (#380), a weekend's included (#387)",
  normalizeStrikeDate: "reading the expiry noticeManageBy counts the manage-by window back from",
};
