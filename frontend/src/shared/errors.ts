/** An error in plain words (the owner's standard of 2026-11-16, part N; ADR 0023): what failed and
 *  that it can be tried again — never the browser's "Failed to fetch" or a socket's
 *  "ECONNREFUSED" on screen. The raw text is kept for a title or a detail (`rawError`), where it is
 *  still worth having when something is wrong for longer than a retry.
 *
 *  Three kinds of failure are said plainly; anything else is the service's own refusal, already in
 *  words ("expiry 2026-12-18 is not listed"), and is said as it is, with no retry promised — a
 *  refusal does not go away by asking again.
 */

/** What a browser throws when a request never reached an answer: Chromium, Safari, Firefox. */
const UNREACHED = /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed|fetch failed)$/i;

/** A socket's own error codes, passed through a service's 502 when the Provider is down. */
const SOCKET = /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPIPE|socket hang up)\b/;

/** The page's own words for a status it got (`api.ts`'s `read`): "/quotes → 502". */
const STATUS = /^\S+ → (\d{3})$/;

/** The raw text of an error, as thrown. */
export function rawError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The error in plain words.
 *  @param again how a retry is said where one helps: "try again" by a button, "tried again at the
 *  next poll" where the page asks again by itself */
export function plainError(e: unknown, again = "try again"): string {
  const raw = rawError(e).trim();
  if (UNREACHED.test(raw) || (e instanceof TypeError && /fetch|network/i.test(raw))) {
    return `the service did not answer; ${again}`;
  }
  if (SOCKET.test(raw)) return `the provider could not be reached; ${again}`;
  const status = STATUS.exec(raw);
  if (status) {
    const code = Number(status[1]);
    return code >= 500 ? `the service failed (${code}); ${again}` : `the service refused it (${code})`;
  }
  return raw === "" ? `no answer; ${again}` : raw;
}

/** A reason the service SERVED for a dash — a row's `error`, its `spx_reason`, a holding's
 *  `valued_reason`, a Reference's `error` — in plain words where it is a socket's or a browser's
 *  noise ("moomoo call failed: connect ECONNREFUSED 127.0.0.1:33333"), and as served otherwise: the
 *  service's own reasons are already words. Null stays null. */
export function plainReason<T extends string | null | undefined>(reason: T): T | string {
  if (typeof reason !== "string") return reason;
  if (SOCKET.test(reason) || UNREACHED.test(reason.trim())) return "the provider could not be reached";
  return reason;
}
