import type { Holding } from "../shared/api";
import type { Mode } from "./mode";

/** A holding's Levels as its chip says them, on every surface that draws one (#354).
 *
 *  In REVIEW the needs-you line says nothing of a holding's Levels: it uses only what is polled
 *  (ADR 0012), and REVIEW values the holdings once on entering it rather than polling them. The
 *  chip is drawn from that one valuation, so it says which one — "at stop · as valued at 21:04" —
 *  and the two cannot read as a disagreement (the owner's decision (b), ADR 0023). In LIVE the
 *  line and the chip read the same poll, and the chip carries no time.
 *
 *  ONE function for the words, so the desk's row, its inspector, the phone's page and sheet, the
 *  saved picture and the desk's fitting, which counts the chip's characters, say the same thing. */
export type Level = "stop" | "target" | "manage";

export const LEVEL_WORDS: Record<Level, string> = {
  stop: "at stop", target: "at target", manage: "manage-by",
};

/** "21:04": the wall clock the service wrote on a valuation (`fetched_at`, rendered in DISPLAY_TZ
 *  as `2026-11-12 21:04:37+08:00`), read as written — the zone the owner reads every time the
 *  service states — or null where the stamp says no time. To the minute: a chip is short. */
export function valuedClock(served: string | null | undefined): string | null {
  const m = /^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/.exec(served ?? "");
  return m ? m[1]! : null;
}

export function levelWords(level: Level, holding: Holding, mode: Mode): string {
  const words = LEVEL_WORDS[level];
  if (mode === "live") return words;
  const at = valuedClock(holding.fetched_at);
  // a valuation with no time on it is still not live, and is said to be as last valued
  return `${words} · ${at ? `as valued at ${at}` : "as last valued"}`;
}
