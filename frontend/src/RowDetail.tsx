import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";

import type { Entry } from "./api";
import { useDismissOnBack } from "./useDismissOnBack";
import { COMBO_COLUMNS, PROTECTED, SINGLE_COLUMNS } from "./columns";
import { alarmText, legSummary } from "./format";
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
  const columns = (isCombo ? COMBO_COLUMNS : SINGLE_COLUMNS).filter(
    (c) => !PROTECTED.has(c.key) && c.key !== "alarm" && c.key !== "entry",
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{isCombo ? entry.code : (entry.snapshot?.name ?? entry.code)}</SheetTitle>
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
