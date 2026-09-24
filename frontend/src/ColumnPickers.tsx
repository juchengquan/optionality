import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { PROTECTED, type Column } from "./columns";

interface Picker {
  table: "single" | "combo";
  label: string;
  all: Column[];
  hidden: Set<string>;
  onToggle: (table: "single" | "combo", key: string, shown: boolean) => void;
  onReset: (table: "single" | "combo") => void;
}

/** Was a <details>, which worked but managed no focus and could not be dismissed with
 *  Escape — you had to click the summary again to put it away. A popover does both.
 *
 *  The list carries an explicit role and name rather than relying on whatever the wrapper
 *  element happens to map to: <details> reported itself as a region, a popover reports a
 *  dialog, and neither is a thing a reader would call this. */
export function ColumnPickers({ pickers }: { pickers: Picker[] }) {
  return (
    <div id="column-pickers" className="health">
      {pickers.map(({ table, label, all, hidden, onToggle, onReset }) => (
        <Popover key={table}>
          <PopoverTrigger
            render={<Button variant="outline" size="sm">{label} columns</Button>}
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
      ))}
    </div>
  );
}
