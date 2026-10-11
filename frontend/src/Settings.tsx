import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";

import { useDismissOnBack } from "./useDismissOnBack";

/** unchanged when this moved out of App.tsx — the options are the owner's, not mine */
export const REFRESH_PRESETS = [5, 10, 15, 30, 60, 120];

/** Viewer preferences, which is currently one preference.
 *
 *  It sat on the page until now, in the line that reports freshness. That line is worth reading
 *  every time you look at the screen; how often the screen polls is a thing you set once. So the
 *  cadence moved in here and the freshness stayed out there.
 *
 *  Deliberately NOT in here: the service's own status. If OpenD is down or the alarm engine has
 *  stalled, every figure on the page is suspect and the bell may be silent — that is exactly when
 *  it must not be a click away. It stays on the page, and shows only when it has something to say.
 *
 *  Also not in here: the column pickers. Each one belongs beside the table it governs (ADR 0008),
 *  and collecting them into a settings panel would need sub-headings to explain which table each
 *  section meant, which is the sign that the grouping is wrong.
 */
export function Settings({
  open, onClose, refresh, onRefresh, sweepSeconds,
}: {
  open: boolean;
  onClose: () => void;
  refresh: number;
  onRefresh: (seconds: number) => void;
  sweepSeconds?: number;
}) {
  useDismissOnBack(open, onClose);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>
            Kept in this browser, not on the service — these are yours, not the watchlist's.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          <Field>
            <FieldLabel htmlFor="s-refresh">refresh every</FieldLabel>
            <NativeSelect
              id="s-refresh"
              aria-label="refresh every"
              value={refresh}
              onChange={(e) => onRefresh(Number(e.target.value))}
            >
              {REFRESH_PRESETS.map((n) => <option key={n} value={n}>{n}s</option>)}
            </NativeSelect>
            <FieldDescription>
              How soon a new figure reaches this screen. The service decides how fresh the figures
              are{sweepSeconds ? ` — it sweeps every ${sweepSeconds}s` : ""}; this only decides how
              often the screen asks. Each poll is a live call, so faster is not free (ADR 0010).
            </FieldDescription>
          </Field>
        </div>
      </SheetContent>
    </Sheet>
  );
}
