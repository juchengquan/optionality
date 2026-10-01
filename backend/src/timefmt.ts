/** Turning stored UTC into the strings the API hands out. Ported from service/timefmt.py
 *  (ADR 0009, phase 5).
 *
 *  Storage is UTC; display converts via DISPLAY_TZ (CLAUDE.md). The format is Python's
 *  `isoformat(sep=" ", timespec="seconds")`, offset included: `2026-08-10 11:35:32+08:00`. The
 *  dashboard parses these, so the shape is part of the contract, not a presentation choice.
 *
 *  days_to_expiry lives in domain/expiry.ts instead — it is a figure about an option rather than a
 *  rendering of a timestamp, and it is the only part of this file the domain needs.
 */

import { fromSqlDatetime } from "./db/time.ts";

/** moomoo delivers market timestamps as naive strings in US Eastern exchange time. */
const MARKET_TZ = "America/New_York";

/** An empty DISPLAY_TZ means the host's own zone, which is what Python's astimezone() does. */
function zone(tzName: string): string | undefined {
  return tzName || undefined;
}

function parts(when: Date, tzName: string): Record<string, string> {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone(tzName),
    hourCycle: "h23", // not hour12:false, which renders midnight as 24 in some locales
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(when);
  return Object.fromEntries(formatted.map((p) => [p.type, p.value]));
}

/** The offset as Python writes it: +08:00, and +00:00 rather than the bare "GMT" JS gives. */
function offsetOf(p: Record<string, string>): string {
  const name = p.timeZoneName ?? "";
  const rest = name.replace(/^(GMT|UTC)/, "");
  if (rest === "") return "+00:00";
  // longOffset can give +08 or +0530 depending on the zone; Python always writes +HH:MM
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(rest);
  if (!m) return rest;
  return `${m[1]}${m[2]!.padStart(2, "0")}:${m[3] ?? "00"}`;
}

/** A stored instant as the API reports it, or null for a missing one. */
export function displayTime(when: Date | null | undefined, tzName = ""): string | null {
  if (when === null || when === undefined) return null;
  const p = parts(when, tzName);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}${offsetOf(p)}`;
}

/** The wall-clock offset of a zone at an instant, in minutes east of UTC. */
function offsetMinutes(when: Date, tzName: string): number {
  const p = parts(when, tzName);
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second),
  );
  return Math.round((asUtc - when.getTime()) / 60_000);
}

/** The wall time as a UTC instant, or null if it is not a real one.
 *
 *  Matches what Python's `fromisoformat` accepts, which is not simply "every field in range":
 *  **24:00:00 is legal** and means midnight the next day, but only with zero minutes, seconds and
 *  microseconds. 25:00, 23:60, 23:59:60 and 2026-02-30 are all rejected. Discovered against the
 *  Python rather than assumed — the first version of this took 24:00:00 for garbage and the
 *  differential said so.
 */
function isoInstant(
  y: string, mo: string, d: string, h: string, mi: string, s: string, frac: string,
): number | null {
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number);
  if (month! < 1 || month! > 12) return null;
  // day=0 of the NEXT month is the last day of this one, and that calculation cannot itself roll.
  // Checking the day by building the date and seeing whether it moved does not work: the
  // expectation you compare against has already rolled too, which let 2026-02-30 through once.
  const lastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  if (day! < 1 || day! > lastDay) return null;
  if (minute! > 59 || second! > 59) return null;
  if (hour! === 24) {
    if (minute !== 0 || second !== 0 || Number(frac) !== 0) return null;
  } else if (hour! > 23) {
    return null;
  }
  // hour 24 rolls to the next day here exactly as Python normalises it
  return Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
}

/** The instant at which a zone's clock reads the given wall time.
 *
 *  The offset has to be read at the instant in question rather than today's: these timestamps
 *  cross daylight-saving boundaries, and Eastern is four hours behind UTC in summer and five in
 *  winter. One pass is not enough — the first offset is sampled up to an offset's worth away from
 *  the true instant, so a transition inside that window gives the wrong answer — and a fixed
 *  point does not always exist.
 *
 *  When it does not, the wall time is one the clock skips: 02:30 on the morning US clocks go
 *  forward happens never. Python resolves that with PEP 495's fold=0, meaning the offset in
 *  effect BEFORE the transition. A gap only ever appears when the offset increases, so the
 *  earlier offset is the smaller one, which is the LATER of the two candidate instants.
 *
 *  An ambiguous wall time — the hour the clock repeats in autumn — needs none of this: fold=0 is
 *  the first occurrence, and that is the fixed point the first pass already finds.
 */
function instantOfWallTime(wallAsUtc: number, tzName: string): number {
  const first = wallAsUtc - offsetMinutes(new Date(wallAsUtc), tzName) * 60_000;
  if (offsetMinutes(new Date(first), tzName) * 60_000 === wallAsUtc - first) return first;
  const second = wallAsUtc - offsetMinutes(new Date(first), tzName) * 60_000;
  if (offsetMinutes(new Date(second), tzName) * 60_000 === wallAsUtc - second) return second;
  return Math.max(first, second);
}

/** moomoo's `update_time`, which arrives naive and means US Eastern exchange time.
 *
 *  Anything unparseable comes back untouched: the field carries "N/A" when a contract has not
 *  traded, and a quote with one odd field is still worth showing.
 */
export function marketTimeToDisplay(value: string, tzName = ""): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/.exec(value);
  if (!m) return value;
  const [, y, mo, d, h, mi, s, frac] = m;
  const naive = isoInstant(y!, mo!, d!, h!, mi!, s ?? "0", frac ?? "0");
  // shape alone is not enough: "2026-13-45 99:99:99" fits the pattern, and Date.UTC rolls it into
  // February 2027 rather than refusing. Python's fromisoformat raises, so the value comes back
  // untouched — the same trap build_spx_code had, caught the same way.
  if (naive === null) return value;
  return displayTime(new Date(instantOfWallTime(naive, MARKET_TZ)), tzName)!;
}

/** A stored timestamp as the API reports it. Stored text in, display string out — the two
 *  conversions always travel together, and splitting them is how a naive parse creeps in. */
export function displayStored(stored: string | null | undefined, tzName = ""): string | null {
  if (stored === null || stored === undefined) return null;
  return displayTime(fromSqlDatetime(stored), tzName);
}
