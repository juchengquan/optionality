/** Changing a holding from the page (#294): editing what was recorded, closing it, correcting a
 *  close, and saying what became of its Monitors. Pure, so what each form posts is decided and
 *  tested here; `HoldingActions.tsx` and `ClosedResult.tsx` only draw it.
 *
 *  Three routes, all of them the service's (ADR 0022), none new:
 *  - `PATCH /positions/{id}` takes Entry, contracts and Opened on a held holding — never its name or
 *    its legs ("a different structure is a different holding"), and never a null for any of them.
 *  - `POST /positions/{id}/close` takes the Exit and the day. The Exit is SIGNED LIKE COST TO CLOSE,
 *    which is how `/positions/values` serves `cost_to_close`, so the prefill is that figure as it
 *    stands: a long's sale is negative there and stays negative here.
 *  - the same PATCH takes `exit` and `closed_on` on a CLOSED holding, which is how a mistyped close
 *    is corrected without losing the samples a delete would take.
 */
import type { Holding, Monitor } from "../shared/api";
import { GROUPS } from "../shared/groups";

/** A number as typed: null for blank, NaN for something that is not one. */
function typed(text: string): number | null {
  const t = text.trim().replace(/^−/, "-");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** The Exit a close starts with: the served Cost to close, signed as served.
 *
 *  Rounded to six places and no further, which removes the float noise a sum of mids carries
 *  (2.35 − 1.15 is 1.2000000000000002) and nothing a quoted mid can be — a mid is at worst to the
 *  half-cent of a nickel spread, 0.0125, so the figure posted is the figure served. Blank where none
 *  was served: the close keeps a blank as unknown rather than guessing one. */
export function exitPrefill(cost: number | null): string {
  return cost === null ? "" : String(Number(cost.toFixed(6)));
}

/** Today's New York market day, or the expiry if that came first: nothing is held past one, and the
 *  service refuses a later day. ISO dates compare as text. */
export function closeDay(strikeDate: string, today: string): string {
  return strikeDate < today ? strikeDate : today;
}

export interface CloseDraft {
  /** as typed, signed like Cost to close */
  exit: string;
  /** YYYY-MM-DD, or blank to leave it to the service */
  closedOn: string;
}

type Out<T> = { body: T } | { error: string };

function exitOf(text: string): number | null | { error: string } {
  const exit = typed(text);
  return Number.isNaN(exit) ? { error: `the exit is not a number: ${text.trim()}` } : exit;
}

/** What `POST /positions/{id}/close` is sent. */
export function closeBody(d: CloseDraft): Out<{ exit: number | null; closed_on?: string }> {
  const exit = exitOf(d.exit);
  if (exit !== null && typeof exit === "object") return exit;
  return { body: d.closedOn === "" ? { exit } : { exit, closed_on: d.closedOn } };
}

/** What `PATCH /positions/{id}` is sent to correct a close: only what changed from the close AS THE
 *  SERVICE HAS IT, like `editBody`. Two forms can correct one close — the close's account and the
 *  journal's entry (#296) — and a field sent unchanged from a form opened earlier would put back
 *  what the other just corrected. A cleared Exit is a change, sent as null: blank is an answer, "I
 *  do not know what I paid", and leaving it out would keep the old Exit. */
export function correctionBody(
  served: { exit: number | null; closed_on: string }, d: CloseDraft,
): Out<{ exit?: number | null; closed_on?: string }> {
  const exit = exitOf(d.exit);
  if (exit !== null && typeof exit === "object") return exit;
  if (d.closedOn === "") return { error: "type the day it was closed" };
  const body: { exit?: number | null; closed_on?: string } = {};
  if (exit !== served.exit) body.exit = exit;
  if (d.closedOn !== served.closed_on) body.closed_on = d.closedOn;
  return Object.keys(body).length === 0 ? { error: "nothing changed" } : { body };
}

export interface EditDraft {
  entry: string;
  contracts: string;
  /** Opened, a New York market day */
  opened: string;
}

export function editDraft(h: Pick<Holding, "entry" | "contracts" | "opened_at">): EditDraft {
  return {
    entry: h.entry === null ? "" : String(h.entry),
    contracts: String(h.contracts),
    opened: h.opened_at ?? "",
  };
}

/** What `PATCH /positions/{id}` is sent: only what changed. The route takes no null for any of
 *  these, so a field cleared is refused here, in words, rather than sent and refused there. */
export function editBody(
  h: Pick<Holding, "entry" | "contracts" | "opened_at">, d: EditDraft,
): Out<{ entry?: number; contracts?: number; opened_at?: string }> {
  const body: { entry?: number; contracts?: number; opened_at?: string } = {};
  const entry = typed(d.entry);
  if (Number.isNaN(entry)) return { error: `the entry is not a number: ${d.entry.trim()}` };
  if (entry === null && h.entry !== null) return { error: "the entry cannot be cleared here — type what was taken in" };
  if (entry !== null && entry !== h.entry) body.entry = entry;
  const contracts = typed(d.contracts);
  if (contracts === null || !Number.isInteger(contracts) || contracts < 1) {
    return { error: "contracts must be a whole number, 1 or more" };
  }
  if (contracts !== h.contracts) body.contracts = contracts;
  if (d.opened === "" && h.opened_at !== null) {
    return { error: "Opened cannot be cleared here — type the New York trading day it was put on" };
  }
  if (d.opened !== "" && d.opened !== h.opened_at) body.opened_at = d.opened;
  return Object.keys(body).length === 0 ? { error: "nothing changed" } : { body };
}

/** A Monitor the page knew was watching the holding before it closed. */
export interface Watching {
  id: string;
  name: string;
}

export interface Fate {
  id: string;
  name: string;
  /** what became of it, in words */
  fate: string;
}

const reasonWords = (reason: string | null) =>
  GROUPS.find(([r]) => r === reason)?.[1] ?? "Reason not recorded";

/** What became of each Monitor, as the service now reports it: the close's own list of the rules
 *  it switched off, and `/monitors` read back AFTER the close for the rest. Nothing is inferred
 *  here — a rule handed to another holding says so because the service now links it there. */
export function fates(
  watching: Watching[], after: Monitor[], disabled: { id: string; code: string }[],
): Fate[] {
  const byId = new Map(after.map((m) => [m.id, m]));
  const off = new Set(disabled.map((m) => m.id));
  const named = [
    ...watching,
    // a rule the close switched off that the page did not know about: the service's word wins
    ...disabled.filter((d) => !watching.some((w) => w.id === d.id)).map((d) => ({ id: d.id, name: d.code })),
  ];
  return named.map(({ id, name }) => {
    const m = byId.get(id);
    if (off.has(id) || (m && !m.enabled && m.disabled_reason === "holding-closed")) {
      return { id, name, fate: "switched off — holding closed" };
    }
    if (!m) return { id, name, fate: "no longer listed by the service" };
    if (m.positions.length > 0) {
      const to = `handed to ${m.positions.map((p) => p.name).join(", ")}`;
      return { id, name, fate: m.enabled ? to : `${to}; it was already off (${reasonWords(m.disabled_reason)})` };
    }
    if (!m.enabled) return { id, name, fate: `linked to nothing; it was already off (${reasonWords(m.disabled_reason)})` };
    return { id, name, fate: "kept on, linked to no holding" };
  });
}
