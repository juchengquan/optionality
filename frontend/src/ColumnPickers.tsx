import { SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { PROTECTED, type Column } from "./columns";

/** One table's column choices, shown beside that table's heading.
 *
 *  Both pickers used to sit in a row above the watchlist, which put a per-table control in
 *  the page's global chrome — and a global "settings" panel holding them would have needed
 *  sub-headings to explain which table each section governed, which is a sign the grouping
 *  is wrong. A control belongs next to the thing it changes.
 *
 *  The trigger keeps the accessible name "<table> columns" even though it now draws an icon:
 *  that name is how the control is found by anyone not looking at it.
 */
export function ColumnPicker({
  table, label, all, hidden, onToggle, onReset,
}: {
  table: "single" | "combo";
  label: string;
  all: Column[];
  hidden: Set<string>;
  onToggle: (table: "single" | "combo", key: string, shown: boolean) => void;
  onReset: (table: "single" | "combo") => void;
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
      <PopoverContent>
        <div role="group" aria-label={`${label} columns`} className="flex flex-col gap-2">
          {all
            .filter((c) => !PROTECTED.has(c.key))
            .map((c) => (
              <label className="flex items-center gap-2 cursor-pointer" key={c.key}>
                <Checkbox
                  checked={!hidden.has(c.key)}
                  onCheckedChange={(shown) => onToggle(table, c.key, shown)}
                />
                {c.label}
              </label>
            ))}
          <Button variant="ghost" size="sm" onClick={() => onReset(table)}>
            show all
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
