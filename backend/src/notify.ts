/** Telling the owner, and saying whether it got through.
 *
 *  One function, extracted because three callers had grown around it: the sweep's quarantine and
 *  expiry notices, `positions.ts`'s manage-by line (which already took a parameter of exactly this
 *  shape, declared by hand), and the degraded/flapping/recovered notices that moved into
 *  `health.ts`. It was a private method on `MonitorSweeper` while all three were in one class.
 *
 *  A failed send must never stop a sweep — the sweep's job is the alarm — so this swallows the
 *  error. That makes "did it throw" useless to a caller, and the manage-by notice needs the
 *  answer: it is raised ONCE, so a stamp written after an undelivered notice loses it for ever.
 *  Hence a return value rather than a rethrow.
 *
 *  Telegram not being configured counts as DELIVERED. There is nothing to retry, and retrying
 *  every sweep would log the same line for ever — which is also what makes `make serve` quiet,
 *  since it blanks the token on purpose so a local sweep cannot message the owner's phone.
 */
import type { Settings } from "./env.ts";

/** Sending a message to the owner's phone, as the service's own modules see it. */
export type Notifier = (text: string) => Promise<boolean>;

/** The raw transport: what `bot/` provides and what a test fakes. */
export type NotifySender = (text: string) => Promise<void> | void;

export function notifier(settings: Settings, send: NotifySender): Notifier {
  return async (text: string): Promise<boolean> => {
    if (!settings.telegramBotToken || !settings.telegramChatId) {
      console.info(`telegram not configured; alarm suppressed: ${text}`);
      return true;
    }
    try {
      await send(text);
      return true;
    } catch (err) {
      console.error("telegram send failed:", err);
      return false;
    }
  };
}
