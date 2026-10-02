/** Sending one message to the owner's phone (ADR 0009, phase 6c).
 *
 *  Just `sendMessage`. The bot — long-poll, the command set, the table formatting — is phase 7 and
 *  builds on this. Ported rather than bridged because it is an HTTPS POST and nothing more; the Gmail
 *  sender stays in Python because it is SMTP with an app password.
 */

export interface TelegramConfig {
  token: string;
  chatId: string;
  /** `<pre>` with HTML parse mode, only for table replies (CLAUDE.md) */
  parseMode?: "HTML";
}

/** Send, or say why not. Throws on a refusal, because the caller decides whether a failed send is
 *  worth recording — the sweeper swallows it, a run failure records it. */
export async function sendMessage(config: TelegramConfig, text: string): Promise<void> {
  const body = new URLSearchParams({ chat_id: config.chatId, text });
  if (config.parseMode) body.set("parse_mode", config.parseMode);
  const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json()) as { ok?: boolean };
  if (!payload.ok) {
    throw new Error(`telegram sendMessage failed: ${JSON.stringify(payload)}`);
  }
}

/** A sender bound to its credentials, or one that refuses when they are not configured.
 *
 *  The token allows ONE getUpdates consumer and must never be exercised by two service instances
 *  (CLAUDE.md) — but sendMessage is not getUpdates, and this is the safe half. */
export function telegramSender(token: string, chatId: string) {
  return async (text: string): Promise<void> => {
    if (!token || !chatId) throw new Error("telegram is not configured");
    await sendMessage({ token, chatId }, text);
  };
}

/** One call to the Telegram HTTP API, for the bot.
 *
 *  The timeout is longer than the long-poll it carries: getUpdates is asked to wait 25 seconds, so a
 *  30-second request timeout would abort a healthy poll. The Python uses 35 for the same reason.
 */
export function telegramApi(token: string) {
  return async (method: string, params: Record<string, string>): Promise<unknown> => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(35_000),
    });
    const payload = (await response.json()) as { ok?: boolean; result?: unknown };
    if (!payload.ok) throw new Error(`telegram ${method} failed: ${JSON.stringify(payload)}`);
    return payload.result;
  };
}
