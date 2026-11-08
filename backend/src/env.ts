/** Settings, read from the environment. Ported from service/settings.py (ADR 0009, phase 5).
 *
 *  Behaviour knobs live in `.env`, which mirrors `.env.example`'s structure: active lines are
 *  overrides, commented lines show defaults (CLAUDE.md). The variable names and the defaults below
 *  are therefore part of the deployment, not implementation detail — a renamed variable silently
 *  reverts a knob the owner has set.
 */

export interface Settings {
  dbPath: string;
  /** which Provider this deployment reads market data from; one per deployment, chosen before
   *  boot (ADR 0015). provider.ts knows the names and refuses the rest. */
  provider: string;
  opendHost: string;
  /** Where IB Gateway's API socket is, for a Reference that names `ibkr` (ADR 0019).
   *
   *  Read whether or not IBKR is the Provider: a Reference may be served by a vendor the rest of
   *  the service does not use, because nothing alarms on it. Blank host turns the source off.
   *
   *  The PORT is not a set-once value — IB Gateway listens on 4001 for a live login and 4002 for
   *  paper, so switching account type moves the socket (measured 2026-11-08).
   */
  ibkrHost: string;
  ibkrPort: number;
  /** IB Gateway allows ONE connection per client id, and a second user of the same number
   *  displaces the first in silence. The ids are the owning process's port so a refusal names
   *  the culprit: 31415 the service, 31417 `make serve`, 31419 a harness. */
  ibkrClientId: number;
  /** OpenD's WEBSOCKET port. The npm client speaks nothing else — the SDK's TCP protocol has no
   *  JavaScript implementation (ADR 0009, phase 6). */
  moomooWsPort: number;
  /** OpenD's websocket key, in plaintext; the library hashes it. Gitignored, like the bot token. */
  moomooWsKey: string;
  apiToken: string;
  monitorIntervalSeconds: number;
  /** min gap between a monitor's telegram messages (flap protection) */
  alarmCooldownSeconds: number;
  /** reminder cadence while a breach persists; 0 disables reminders */
  alarmRepeatSeconds: number;
  /** dashboard live-region poll interval */
  uiRefreshSeconds: number;
  /** consecutive sweep failures before the degraded telegram alert */
  degradedAfterFailures: number;
  /** re-reminds while the sweep is still failing, so one missed notice is not the end of it.
   *  0 turns the reminder off, as it does for `alarmRepeatSeconds` (domain/degraded.ts). */
  degradedRepeatSeconds: number;
  /** How far back to look for a provider that keeps dropping and recovering, and how many failed
   *  sweeps inside that window before the owner hears about it. 0 failures turns it off.
   *
   *  Separate from `degradedAfterFailures` because they measure different things: that one is the
   *  LENGTH of a failure, this one is how OFTEN. A provider failing a third of the time for an
   *  hour never trips a consecutive count — measured on 2026-11-08, when exactly that went
   *  unnoticed by the service (domain/flapping.ts). */
  flappingWindowSeconds: number;
  flappingAfterFailures: number;
  /** consecutive sweeps a monitor's figure may fail to arrive before it is quarantined; 0 never
   *  quarantines and only warns, which is what the engine did before (#167) */
  quarantineAfterSilentSweeps: number;
  /** muted-expired monitors are auto-deleted this many days after expiry */
  expiredRetentionDays: number;
  /** exit schedule (ADR 0011): the fraction of Entry taken as profit */
  exitTakeFraction: number;
  /** exit schedule: the Cost to close, as a multiple of Entry, that ends the trade */
  exitStopMultiple: number;
  /** exit schedule: be out of a Position at or inside this DTE whatever the P&L */
  exitManageByDte: number;
  telegramBotToken: string;
  telegramChatId: string;
  /** URL prefix when served behind a path-stripping reverse proxy, e.g. "/opt/api" */
  rootPath: string;
  /** timezone for displayed timestamps, e.g. "Asia/Singapore"; empty = host timezone */
  displayTz: string;
}

export const DEFAULTS: Settings = {
  // The TypeScript service's own database. NOT `data/optionality.db`, which is the Python's and is
  // frozen at the cutover minute as the rollback (CLAUDE.md) — and `main.ts` opens and MIGRATES
  // whatever this names, at import time, with the two schemas diverged since ADR 0011. The launchd
  // plist has always set OPTIONALITY_DB_PATH, so the live service was right and every other way of
  // starting this code was quietly pointed at the rollback.
  dbPath: "data/optionality-ts.db",
  provider: "moomoo",
  opendHost: "127.0.0.1",
  ibkrHost: "",
  ibkrPort: 4001,
  ibkrClientId: 31415,
  moomooWsPort: 33333,
  moomooWsKey: "",
  apiToken: "",
  monitorIntervalSeconds: 60,
  alarmCooldownSeconds: 120,
  alarmRepeatSeconds: 1800,
  uiRefreshSeconds: 30,
  degradedAfterFailures: 5,
  degradedRepeatSeconds: 1800,
  flappingWindowSeconds: 900,
  flappingAfterFailures: 5,
  // ten sweeps, so a gap of a few seconds is never a quarantine while a figure that is simply not
  // served stops being waited for within minutes at any sweep interval
  quarantineAfterSilentSweeps: 10,
  expiredRetentionDays: 7,
  exitTakeFraction: 0.5,
  exitStopMultiple: 2,
  exitManageByDte: 21,
  telegramBotToken: "",
  telegramChatId: "",
  rootPath: "",
  displayTz: "",
};

/** Each setting and the variable it is read from. Listed once so that nothing can be read from a
 *  name the Python does not use. */
const FROM_ENV = {
  dbPath: "OPTIONALITY_DB_PATH",
  provider: "OPTIONALITY_PROVIDER",
  opendHost: "OPEND_HOST",
  ibkrHost: "IBKR_HOST",
  ibkrPort: "IBKR_PORT",
  ibkrClientId: "IBKR_CLIENT_ID",
  moomooWsPort: "MOOMOO_WS_PORT",
  moomooWsKey: "MOOMOO_WS_KEY",
  apiToken: "API_TOKEN",
  monitorIntervalSeconds: "MONITOR_INTERVAL_SECONDS",
  alarmCooldownSeconds: "ALARM_COOLDOWN_SECONDS",
  alarmRepeatSeconds: "ALARM_REPEAT_SECONDS",
  uiRefreshSeconds: "UI_REFRESH_SECONDS",
  degradedAfterFailures: "DEGRADED_AFTER_FAILURES",
  degradedRepeatSeconds: "DEGRADED_REPEAT_SECONDS",
  flappingWindowSeconds: "FLAPPING_WINDOW_SECONDS",
  flappingAfterFailures: "FLAPPING_AFTER_FAILURES",
  quarantineAfterSilentSweeps: "QUARANTINE_AFTER_SILENT_SWEEPS",
  expiredRetentionDays: "EXPIRED_RETENTION_DAYS",
  exitTakeFraction: "EXIT_TAKE_FRACTION",
  exitStopMultiple: "EXIT_STOP_MULTIPLE",
  exitManageByDte: "EXIT_MANAGE_BY_DTE",
  telegramBotToken: "TELEGRAM_BOT_TOKEN",
  telegramChatId: "TELEGRAM_CHAT_ID",
  rootPath: "ROOT_PATH",
  displayTz: "DISPLAY_TZ",
} as const satisfies Record<keyof Settings, string>;

/** The knobs that are genuinely fractional. Everything else is a count, where a fraction is a
 *  typo — `EXIT_MANAGE_BY_DTE` is deliberately not here, because a DTE is a whole day. */
const FRACTIONAL: ReadonlySet<keyof Settings> = new Set(["exitTakeFraction", "exitStopMultiple"]);

/** Knobs that must be at least 1, because 0 is not "off" for them but broken.
 *
 *  `DEGRADED_AFTER_FAILURES=0` made `consecutiveFailures >= threshold` true on a HEALTHY sweep, so
 *  the service sent "✅ monitoring recovered" every minute for ever while the degraded alert it was
 *  meant to arm never fired at all. `MONITOR_INTERVAL_SECONDS=0` gives `setInterval(…, 0)` and a
 *  stall threshold of 0, so `/health` reads permanently stalled and every tick records a failure.
 *
 *  0 IS off for the three left out — `ALARM_REPEAT_SECONDS`, `QUARANTINE_AFTER_SILENT_SWEEPS`,
 *  `EXPIRED_RETENTION_DAYS` — which is exactly why 0 is a plausible thing to type here, and why
 *  this list has to be explicit rather than "no zeroes anywhere" (review 2026-11-01).
 */
const AT_LEAST_ONE: readonly (keyof Settings)[] = [
  "monitorIntervalSeconds", "degradedAfterFailures", "uiRefreshSeconds",
];

/** Every count is non-negative; some must be positive. Fatal, as a mistyped setting already is in
 *  this file — the service should stop rather than run on a number that cannot mean anything.
 *
 *  Both doors onto Settings go through this. For a long time only `settingsFor` did — the one the
 *  TESTS use — so the suite proved a guard the live process did not have: `settingsFromEnv` read
 *  the environment, `main.ts` served, and `DEGRADED_AFTER_FAILURES=0` was accepted by exactly the
 *  path that matters. A check that only the tests reach is worse than no check, because it reads
 *  as one.
 */
function checkSettings(settings: Settings): Settings {
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value !== "number" || Number.isNaN(value)) continue;
    const variable = FROM_ENV[key as keyof Settings] ?? key;
    if (value < 0) throw new Error(`${variable} cannot be negative: ${value}`);
    if (AT_LEAST_ONE.includes(key as keyof Settings) && value < 1) {
      throw new Error(`${variable} must be at least 1: ${value}`);
    }
  }
  return settings;
}

export function settingsFromEnv(env: Record<string, string | undefined> = process.env): Settings {
  const out = { ...DEFAULTS };
  for (const [key, variable] of Object.entries(FROM_ENV) as [keyof Settings, string][]) {
    const raw = env[variable];
    if (raw === undefined) continue;
    if (typeof DEFAULTS[key] === "number") {
      // an EMPTY value is not zero. `Number("")` is 0 and `Number.isInteger(0)` is true, so
      // `MONITOR_INTERVAL_SECONDS=` used to mean a zero interval rather than an error — every
      // numeric knob had that hole, and a knob set to nothing is a mistake, never an intent.
      if (raw.trim() === "") throw new Error(`${variable} is set to nothing`);
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${variable} is not a number: ${raw}`);
      // int() in the Python, which raises rather than silently using the default — a mistyped
      // MONITOR_INTERVAL_SECONDS should stop the service, not quietly sweep every 60 seconds.
      // The exit FRACTIONS are the exception and are genuinely fractional; a count is not.
      if (!FRACTIONAL.has(key) && !Number.isInteger(n)) {
        throw new Error(`${variable} is not an integer: ${raw}`);
      }
      (out[key] as number) = n;
    } else {
      (out[key] as string) = raw;
    }
  }
  // the same guard `settingsFor` applies, on the door the SERVICE comes through
  return checkSettings(out);
}

/** Settings for a test, defaults everywhere the test does not care. */
export function settingsFor(over: Partial<Settings> = {}): Settings {
  // checked here too: `settingsFor` is how every test builds Settings, so a knob the service would
  // refuse must not be constructible in a test either
  return checkSettings({ ...DEFAULTS, ...over });
}
