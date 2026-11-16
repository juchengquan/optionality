/** An error in plain words (the owner's standard of 2026-11-16, part N; ADR 0023): what failed and
 *  that it can be tried again — never the browser's "Failed to fetch" or a socket's
 *  "ECONNREFUSED" as the words on screen. The raw text stays REACHABLE: every place that says one
 *  keeps what was thrown or served and draws it as a "details" disclosure beside the plain words
 *  (`ErrorWords.tsx`), which a finger and a screen reader reach as well as a pointer.
 *
 *  Three kinds of failure are said plainly; anything else is the service's own refusal, already in
 *  words ("expiry 2026-12-18 is not listed"), and is said as it is, with no retry promised — a
 *  refusal does not go away by asking again. A failure that names its vendor keeps the name:
 *  "moomoo could not be reached", never "the provider", because the References exist to tell
 *  vendors apart.
 */

/** What a browser throws when a request never reached an answer: Chromium, Safari, Firefox. */
const UNREACHED = /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed|fetch failed)$/i;

/** A socket's own error codes, passed through a service's 502 when a vendor is down. */
const SOCKET = /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPIPE|socket hang up)\b/;

/** The page's own words for a status it got (`api.ts`'s `read`): "/quotes → 502". */
const STATUS = /^\S+ → (\d{3})$/;

/** The vendors the service speaks to, by the names its messages start with ("moomoo call failed:
 *  …") and a Reference's `source` carries — the schema's `SOURCES`, which this package may not
 *  import at runtime (check-boundaries). */
const VENDORS = /\b(moomoo|ibkr|yahoo|OpenD|IB Gateway)\b/i;

/** The raw text of an error, as thrown. */
export function rawError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The vendor a raw text names, as it names it, or null. */
export function vendorOf(raw: string): string | null {
  return VENDORS.exec(raw)?.[1] ?? null;
}

/** Raw text in plain words (above).
 *  @param again how a retry is said where one helps: "try again" by a button, "tried again at the
 *  next poll" where the page asks again by itself
 *  @param vendor who failed, where the text itself does not say (a Reference's source) */
export function plainWords(raw: string, again = "try again", vendor: string | null = null): string {
  const text = raw.trim();
  if (UNREACHED.test(text)) return `the service did not answer; ${again}`;
  if (SOCKET.test(text)) return `${vendorOf(text) ?? vendor ?? "the provider"} could not be reached; ${again}`;
  const status = STATUS.exec(text);
  if (status) {
    const code = Number(status[1]);
    return code >= 500 ? `the service failed (${code}); ${again}` : `the service refused it (${code})`;
  }
  return text === "" ? `no answer; ${again}` : text;
}

/** An error in plain words: `plainWords` of what was thrown. */
export function plainError(e: unknown, again = "try again"): string {
  return plainWords(rawError(e), again);
}

/** A reason the service SERVED for a dash — a row's `error`, its `spx_reason`, a holding's
 *  `valued_reason`, a Reference's `error` — in plain words where it is a socket's or a browser's
 *  noise ("moomoo call failed: connect ECONNREFUSED 127.0.0.1:33333" → "moomoo could not be
 *  reached"), and as served otherwise: the service's own reasons are already words. No retry is
 *  promised: the next poll asks again by itself. Null stays null. */
export function plainReason<T extends string | null | undefined>(reason: T, vendor: string | null = null): T | string {
  if (typeof reason !== "string") return reason;
  if (SOCKET.test(reason) || UNREACHED.test(reason.trim())) {
    return `${vendorOf(reason) ?? vendor ?? "the provider"} could not be reached`;
  }
  return reason;
}

/** The suffix a served reason's raw text is kept under, beside it (`api.ts`' `plainReasons`). */
export const RAW = "_raw";

/** The raw text a row's served reason was, where it was made plain, or the reason itself. */
export function rawReason(row: object, key: string): string | null {
  const r = row as Record<string, unknown>;
  const raw = r[`${key}${RAW}`] ?? r[key];
  return typeof raw === "string" ? raw : null;
}
