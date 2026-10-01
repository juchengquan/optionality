/** Settings, read from the environment. Ported from service/settings.py (ADR 0009, phase 5).
 *
 *  Behaviour knobs live in `.env`, which mirrors `.env.example`'s structure: active lines are
 *  overrides, commented lines show defaults (CLAUDE.md). The variable names and the defaults below
 *  are therefore part of the deployment, not implementation detail — a renamed variable silently
 *  reverts a knob the owner has set.
 */

export interface Settings {
  dbPath: string;
  opendHost: string;
  opendPort: number;
  apiToken: string;
  healthcheckUrl: string;
  retryDelaySeconds: number;
  monitorIntervalSeconds: number;
  /** min gap between a monitor's telegram messages (flap protection) */
  alarmCooldownSeconds: number;
  /** reminder cadence while a breach persists; 0 disables reminders */
  alarmRepeatSeconds: number;
  /** dashboard live-region poll interval */
  uiRefreshSeconds: number;
  /** consecutive sweep failures before the degraded telegram alert */
  degradedAfterFailures: number;
  /** muted-expired monitors are auto-deleted this many days after expiry */
  expiredRetentionDays: number;
  telegramBotToken: string;
  telegramChatId: string;
  /** URL prefix when served behind a path-stripping reverse proxy, e.g. "/opt/api" */
  rootPath: string;
  /** timezone for displayed timestamps, e.g. "Asia/Singapore"; empty = host timezone */
  displayTz: string;
}

export const DEFAULTS: Settings = {
  dbPath: "data/optionality.db",
  opendHost: "127.0.0.1",
  opendPort: 11111,
  apiToken: "",
  healthcheckUrl: "",
  retryDelaySeconds: 300,
  monitorIntervalSeconds: 60,
  alarmCooldownSeconds: 120,
  alarmRepeatSeconds: 1800,
  uiRefreshSeconds: 30,
  degradedAfterFailures: 5,
  expiredRetentionDays: 7,
  telegramBotToken: "",
  telegramChatId: "",
  rootPath: "",
  displayTz: "",
};

/** Each setting and the variable it is read from. Listed once so that nothing can be read from a
 *  name the Python does not use. */
const FROM_ENV = {
  dbPath: "OPTIONALITY_DB_PATH",
  opendHost: "OPEND_HOST",
  opendPort: "OPEND_PORT",
  apiToken: "API_TOKEN",
  healthcheckUrl: "HEALTHCHECK_URL",
  retryDelaySeconds: "RETRY_DELAY_SECONDS",
  monitorIntervalSeconds: "MONITOR_INTERVAL_SECONDS",
  alarmCooldownSeconds: "ALARM_COOLDOWN_SECONDS",
  alarmRepeatSeconds: "ALARM_REPEAT_SECONDS",
  uiRefreshSeconds: "UI_REFRESH_SECONDS",
  degradedAfterFailures: "DEGRADED_AFTER_FAILURES",
  expiredRetentionDays: "EXPIRED_RETENTION_DAYS",
  telegramBotToken: "TELEGRAM_BOT_TOKEN",
  telegramChatId: "TELEGRAM_CHAT_ID",
  rootPath: "ROOT_PATH",
  displayTz: "DISPLAY_TZ",
} as const satisfies Record<keyof Settings, string>;

export function settingsFromEnv(env: Record<string, string | undefined> = process.env): Settings {
  const out = { ...DEFAULTS };
  for (const [key, variable] of Object.entries(FROM_ENV) as [keyof Settings, string][]) {
    const raw = env[variable];
    if (raw === undefined) continue;
    if (typeof DEFAULTS[key] === "number") {
      const n = Number(raw);
      // int() in the Python, which raises rather than silently using the default — a mistyped
      // MONITOR_INTERVAL_SECONDS should stop the service, not quietly sweep every 60 seconds
      if (!Number.isInteger(n)) throw new Error(`${variable} is not an integer: ${raw}`);
      (out[key] as number) = n;
    } else {
      (out[key] as string) = raw;
    }
  }
  return out;
}

/** Settings for a test, defaults everywhere the test does not care. */
export function settingsFor(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULTS, ...over };
}
