import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";

import { AddCombo, AddMonitor } from "./AddForms";
import { useDismissOnBack } from "./useDismissOnBack";

export type Adding = "monitor" | "combo" | null;

/** The button that starts it, sat on the heading of the table the new row will appear in.
 *
 *  It used to be a worded button in the page heading — global chrome for a control that adds to
 *  exactly ONE table. This is the same move that put each column picker on its own table's line
 *  (ADR 0008): a control belongs next to the thing it changes. Icon-only with an accessible name,
 *  like those pickers, because a table heading is a small line and two worded buttons on it would
 *  outweigh the name they sit beside.
 */
export function AddTrigger({ which, onOpen }: { which: Exclude<Adding, null>; onOpen: () => void }) {
  return (
    <Button variant="ghost" size="sm" aria-label={`add ${which}`} onClick={onOpen}>
      <Plus />
    </Button>
  );
}

/** The forms, in the same surface the row detail uses (ADR 0008).
 *
 *  They used to sit permanently below the tables — two fieldsets, about thirty controls between
 *  them, on a page whose reason for existing is the watchlist above. On a phone that is most of
 *  the scroll. The page is the watchlist; creating something is somewhere you go.
 *
 *  `which` is owned by the page now rather than by this component, because the triggers moved out
 *  to the tables and two of them cannot share a piece of state neither can see.
 */
export function AddPanel({
  which, onClose, onCreate,
}: {
  which: Adding;
  onClose: () => void;
  onCreate: (body: Record<string, unknown>) => void;
}) {
  useDismissOnBack(which !== null, onClose);

  return (
    <Sheet open={which !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{which === "combo" ? "Add combo" : "Add monitor"}</SheetTitle>
          <SheetDescription>
            {which === "combo"
              ? "Each leg is long or short; the value is their signed sum, short legs counting negative. An entry turns it into a holding on those same sides. A leg left blank is skipped."
              : "One contract, one rule. The alarm fires at the threshold exactly."}
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          {which === "combo"
            ? <AddCombo onCreate={(b) => { onCreate(b); onClose(); }} />
            : <AddMonitor onCreate={(b) => { onCreate(b); onClose(); }} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
