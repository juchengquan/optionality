import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";

import type { Entry } from "./api";
import { useDismissOnBack } from "./useDismissOnBack";
import { COMBO_COLUMNS, SINGLE_COLUMNS } from "./columns";
import { alarmText, DASH, fmt, legSummary, shortContract } from "./format";
import { EntryCell, RowActions } from "./RowActions";
import { cellValue } from "./WatchlistTable";
import type { RowHandlers } from "./WatchlistTable";

/** Everything about one row, at any screen size.
 *
 *  Two problems, one surface. On a narrow screen the table cannot carry thirteen columns or
 *  a cell full of controls, and full parity says neither may simply be dropped. And on any
 *  screen the column picker hides a column for EVERY row — there has never been a way to
 *  see delta for one contract without unhiding it for all of them. This shows every figure
 *  regardless of what the table is drawing. See ADR 0008.
 */
export function RowDetail({
  entry, isCombo, handlers, open, onOpenChange,
}: {
  entry: Entry | null;
  isCombo: boolean;
  handlers: RowHandlers;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useDismissOnBack(open, () => onOpenChange(false));
  if (!entry) return null;
  // the identity is the title, the alarm is the subtitle, and entry has its own editable
  // row below — everything else is a figure. NOT filtered by PROTECTED: that set grew to
  // mean "never dropped from the table", which is the opposite of what belongs here.
  // on_pace is in the schedule block below, with the words that make it mean something — listing
  // it in the figures grid as well showed the same number twice, and showed it to rows that have
  // no schedule at all
  const shownElsewhere = new Set([isCombo ? "combo" : "contract", "alarm", "entry", "on_pace"]);
  const columns = (isCombo ? COMBO_COLUMNS : SINGLE_COLUMNS).filter(
    (c) => !shownElsewhere.has(c.key),
  );
  // null when there is no figure to explain — an Opened in the future leaves a schedule with no
  // pace, and a sum under a dash would be explaining nothing.
  //
  // Truthiness, not `=== null`: a row from before this field existed has no `schedule` key at
  // all, so the first spelling of this passed its own tests and threw on every older fixture
  // that opens this sheet.
  const schedule = entry.schedule;
  const paceSum = schedule && schedule.on_pace !== null && entry.entry !== null
    ? `${fmt(entry.entry, "mid")} × √(${entry.dte} ÷ ${schedule.dte_at_open})`
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{isCombo ? entry.code : shortContract(entry.snapshot?.name ?? entry.code)}</SheetTitle>
          <SheetDescription>
            {alarmText(entry.field, entry.direction, entry.threshold, entry.compare)}
            {entry.triggered ? " 🔔" : null}
            {isCombo && entry.legs ? ` · ${entry.strike_date} · ${legSummary(entry.legs)}` : null}
          </SheetDescription>
        </SheetHeader>

        {entry.error ? <p className="banner">{entry.error}</p> : null}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 px-4 text-sm tabular-nums">
          {columns.map((c) => (
            <div key={c.key} className="contents">
              <dt className="text-muted-foreground">{c.label}</dt>
              <dd className="text-right">{cellValue(entry, c.key, isCombo) || "—"}</dd>
            </div>
          ))}
        </dl>

        {/* The exit schedule, where there is room for words (ADR 0011).
            The column shows the on-pace LEVEL, because a bare signed gap next to a P&L — where
            positive means good — invites being read the wrong way round. Here it is spelled out:
            behind means costing MORE than it should.

            A REFERENCE and not a rule. No alarm is raised from it: being behind fires on every
            IV spike and says nothing about risk, and the shape knows nothing about spot, which is
            what actually kills a condor. The Monitors watch that. */}
        {entry.schedule ? (
          <div className="px-4 pt-3 text-sm">
            <p className="meta">
              {`opened at ${entry.schedule.dte_at_open} DTE`}
              {entry.schedule.pace_gap === null ? null : (
                <>
                  {" · "}
                  <strong>
                    {entry.schedule.pace_gap > 0 ? "behind" : "ahead"}
                    {` by ${Math.abs(entry.schedule.pace_gap).toFixed(2)}`}
                  </strong>
                </>
              )}
            </p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums">
              {([
                ["on pace", (
                  <>
                    {fmt(entry.schedule.on_pace, "mid") || DASH}
                    {/* Substituted with this row's own figures rather than written abstractly:
                        `entry × √(dte ÷ D₀)` has to be decoded, while 6.86 × √(39 ÷ 45) can be
                        read and checked by eye. Every other figure on this row is a measurement;
                        this one is a model output, so it shows its working. */}
                    {paceSum ? (
                      <div className="text-xs font-normal text-muted-foreground">{paceSum}</div>
                    ) : null}
                  </>
                )],
                ["target", fmt(entry.schedule.target, "mid")],
                ["stop", fmt(entry.schedule.stop, "mid")],
                ["target on decay alone", entry.schedule.target_dte === null
                  ? DASH : `${entry.schedule.target_dte} DTE`],
                ["manage by", `${entry.schedule.manage_by_dte} DTE`],
              ] as [string, React.ReactNode][]).map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-right">{value || DASH}</dd>
                </div>
              ))}
            </dl>
            {/* Shown only where there IS a pace figure to qualify. The two things the shape cannot
                see are named rather than implied: an IV crush hands you the profit early and a
                spike puts you behind through no fault of the position, and spot is what actually
                decides a condor. ADR 0011. */}
            {paceSum ? (
              <p className="meta mt-1">
                A shape, not a price: time value decays as √time. Assumes IV holds, and says
                nothing about where SPX is.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* The boxes sat under column headers in the table and have none here, so each
            says what it is. No close button: SheetContent draws its own, and a second one
            stretches edge to edge as a column-flex child. */}
        <div className="flex flex-col gap-4 px-4 pb-6 pt-2">
          <RowActions
            entry={entry}
            onPatch={handlers.onPatch}
            onDelete={(id) => { onOpenChange(false); handlers.onDelete(id); }}
            onRename={handlers.onRename}
            entryCell={
              <EntryCell entry={entry} onEntry={handlers.onEntry} onTotal={handlers.onTotal} />
            }
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The key the detail sheet is opened with: which row, and which table it came from —
 *  a combo and a single-leg rule can share an id space but not a column set. */
export interface DetailTarget {
  entry: Entry;
  isCombo: boolean;
}
