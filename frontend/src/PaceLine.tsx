import { fmt } from "./format";

/** Where a holding stands against its On-pace line, in words (ADR 0011).
 *
 *  ONE home for this wording, because it is load-bearing. CONTEXT.md's Pace gap entry says it is
 *  "said in words wherever it is shown, because 'behind' is bad while a positive P&L is good and
 *  a bare sign beside one invites reading the other" — and it was written out twice, in the row
 *  sheet and again in the holdings list, with the second copy pointing at the first in a comment.
 *  A code review found them. Two homes for a rule like this is two chances to drift.
 *
 *  BEHIND means costing MORE to buy back than time alone accounts for.
 */
export interface Pace {
  dte_at_open: number;
  on_pace: number | null;
  pace_gap: number | null;
  target: number | null;
  stop: number | null;
  manage_by_dte: number;
}

export function PaceLine({ schedule }: { schedule: Pace }) {
  return (
    <>
      <p className="meta">
        {`opened at ${schedule.dte_at_open} DTE`}
        {schedule.pace_gap === null ? null : (
          <>
            {" · "}
            <strong>
              {schedule.pace_gap > 0 ? "behind" : "ahead"}
              {` by ${Math.abs(schedule.pace_gap).toFixed(2)}`}
            </strong>
          </>
        )}
      </p>
      <p className="meta">
        {`on pace ${fmt(schedule.on_pace, "mid")} · target ${fmt(schedule.target, "mid")}`}
        {` · stop ${fmt(schedule.stop, "mid")} · manage by ${schedule.manage_by_dte} DTE`}
      </p>
    </>
  );
}
