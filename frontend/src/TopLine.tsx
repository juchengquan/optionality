import type { Entry, Health, Holding } from "./api";
import { shortContract } from "./format";

/** The one line that says something needs you — and nothing at all when nothing does.
 *
 *  It APPEARS rather than reports: the health row it replaces worked the same way, and its own
 *  comment says why — "if the Provider is down or the alarm engine has stalled, every figure below is
 *  suspect and the bell may be silent, which is exactly when it cannot be a click away". A line
 *  that is almost always the same becomes furniture and stops being read, which fails on the one
 *  day it matters.
 *
 *  So its silence is NOT a verdict, and that is load-bearing, because this cannot see everything:
 *  a row carries a schedule only where one rule covers one whole holding (ADR 0011), and a holding
 *  no rule watches has no row here at all. Both are visible in the Service panel, which fetches on
 *  demand — the dashboard polls ONE batch per poll and ADR 0010 says that is not free. The split is
 *  by urgency, not by content: what needs you now is here, the same facts complete are there.
 */
export interface Needed {
  /** worst first, and a fault leads: it means the figures the rest of this is drawn from are
   *  stale, so it qualifies everything after it rather than queueing behind it */
  kind: "fault" | "stop" | "alarm" | "target" | "manage";
  text: string;
}

const ORDER: Needed["kind"][] = ["fault", "stop", "alarm", "target", "manage"];

/** How many are named before the line starts counting instead. A bad day must not produce a
 *  paragraph, and a count without names makes you hunt — so: names, then a count of the rest. */
const NAMED = 3;

function rowName(entry: Entry): string {
  return entry.legs ? entry.code : shortContract(entry.quote?.name ?? entry.code);
}

/** @param holdings only the Service panel passes these: a holding reached a Level whether or not a
 *  rule covers it, and the page cannot afford the extra live batch per poll (ADR 0010). Where a
 *  row already spoke for the same Position, the holding is skipped rather than said twice.
 */
export function needs(
  quotes: Entry[], health: Health | null, holdings: Holding[] = [],
): Needed[] {
  const out: Needed[] = [];

  if (health && !health.provider.ok) {
    // named, not "OpenD": which Provider is down is the first thing you want to know (ADR 0015)
    out.push({ kind: "fault", text: `${health.provider.name} down — the figures below are stale` });
  }
  if (health?.monitor.alarms.bad) {
    out.push({ kind: "fault", text: `alarms ${health.monitor.alarms.label}` });
  }
  for (const e of quotes) {
    // an unknown contract is a fault about this row: its figures are absent, not calm
    if (e.error) out.push({ kind: "fault", text: `${rowName(e)} — ${e.error}` });
    // Levels come from the service (CONTEXT.md: Level), never from a comparison made here
    if (e.schedule?.reached === "stop") out.push({ kind: "stop", text: `${rowName(e)} at stop` });
    if (e.triggered) out.push({ kind: "alarm", text: `${rowName(e)} ringing` });
    if (e.schedule?.reached === "target") {
      out.push({ kind: "target", text: `${rowName(e)} at target` });
    }
    if (e.schedule?.manage_by_due) {
      out.push({ kind: "manage", text: `${rowName(e)} at its manage-by` });
    }
  }
  const spokenFor = new Set(
    quotes.map((e) => e.schedule?.position_id).filter((id): id is string => Boolean(id)),
  );
  for (const h of holdings) {
    if (spokenFor.has(h.id)) continue;
    if (h.schedule?.reached === "stop") out.push({ kind: "stop", text: `${h.name} at stop` });
    if (h.schedule?.reached === "target") out.push({ kind: "target", text: `${h.name} at target` });
    if (h.schedule?.manage_by_due) {
      out.push({ kind: "manage", text: `${h.name} at its manage-by` });
    }
  }
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

export function TopLine({ quotes, health }: { quotes: Entry[]; health: Health | null }) {
  const items = needs(quotes, health);
  if (items.length === 0) return null;

  const named = items.slice(0, NAMED);
  const rest = items.length - named.length;
  // A target reached is GOOD news and must not be painted as bad: the worst thing in the line
  // decides its colour, and only a fault or a stop is bad. One line carries both kinds, so the
  // colour has to follow the contents rather than the component.
  const bad = items.some((n) => n.kind === "fault" || n.kind === "stop");
  return (
    <div className={bad ? "topline bad" : "topline"} role="status">
      <strong>{items.length === 1 ? "1 needs you" : `${items.length} need you`}</strong>
      {" — "}
      {named.map((n) => n.text).join(" · ")}
      {rest > 0 ? ` · +${rest} more` : null}
    </div>
  );
}
