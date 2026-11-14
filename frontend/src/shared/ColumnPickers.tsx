import { SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** The desk book's column choices, shown beside its heading (ADR 0008, ADR 0023).
 *
 *  A control belongs next to the thing it changes: the old page's two pickers sat in a row above
 *  its tables, which put a per-table control in the page's global chrome. The trigger keeps the
 *  accessible name "<label> columns" even though it draws an icon: that name is how the control is
 *  found by anyone not looking at it.
 */
export function ColumnPicker({
  label, all, hidden, onToggle, onReset,
}: {
  label: string;
  /** exactly the columns ticking would draw: the desk passes what its fit offers, or hides, and
   *  never the pinned name column */
  all: readonly { key: string; label: string }[];
  hidden: Set<string>;
  onToggle: (key: string, shown: boolean) => void;
  onReset: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" aria-label={`${label} columns`}>
            <SlidersHorizontal />
          </Button>
        }
      />
      {/* the poll must not land while this is open: which columns are OFFERED comes from the
          measured fit, so a reload can reflow this very list under the pointer (poll.ts) */}
      <PopoverContent data-poll="hold">
        <div role="group" aria-label={`${label} columns`} className="flex flex-col gap-2">
          {all.map((c) => (
            <label className="flex items-center gap-2 cursor-pointer" key={c.key}>
              <Checkbox
                checked={!hidden.has(c.key)}
                onCheckedChange={(shown) => onToggle(c.key, shown)}
              />
              {c.label}
            </label>
          ))}
          <Button variant="ghost" size="sm" onClick={onReset}>
            show all
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
