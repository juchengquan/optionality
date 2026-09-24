import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";

import { AddCombo, AddMonitor } from "./AddForms";

/** The add-forms, in the same surface the row detail uses (ADR 0008).
 *
 *  They used to sit permanently below the tables — two fieldsets, about thirty controls
 *  between them, on a page whose reason for existing is the watchlist above. On a phone
 *  that is most of the scroll. The page is the watchlist now; creating something is
 *  somewhere you go.
 */
export function AddPanel({ onCreate }: { onCreate: (body: Record<string, unknown>) => void }) {
  const [open, setOpen] = useState<"monitor" | "combo" | null>(null);

  return (
    <>
      <div className="flex flex-wrap gap-2 mb-6">
        <Button variant="outline" size="sm" onClick={() => setOpen("monitor")}>
          add monitor
        </Button>
        <Button variant="outline" size="sm" onClick={() => setOpen("combo")}>
          add combo
        </Button>
      </div>

      <Sheet open={open !== null} onOpenChange={(o) => { if (!o) setOpen(null); }}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{open === "combo" ? "Add combo" : "Add monitor"}</SheetTitle>
            <SheetDescription>
              {open === "combo"
                ? "Legs are signed: minus is short, plus is long. The value is their signed sum."
                : "One contract, one rule. The alarm fires at the threshold exactly."}
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            {open === "combo"
              ? <AddCombo onCreate={(b) => { onCreate(b); setOpen(null); }} />
              : <AddMonitor onCreate={(b) => { onCreate(b); setOpen(null); }} />}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
