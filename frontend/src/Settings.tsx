import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { useCallback, useEffect, useState } from "react";

import { type Entry, type Health, type Holding, fetchHoldings } from "./api";
import { needs } from "./TopLine";
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
  open, onClose, refresh, onRefresh, sweepSeconds, quotes, health,
}: {
  open: boolean;
  onClose: () => void;
  refresh: number;
  quotes: Entry[];
  health: Health | null;
  onRefresh: (seconds: number) => void;
  sweepSeconds?: number;
}) {
  useDismissOnBack(open, onClose);

  // Holdings only while open, as the holdings list itself does: /positions/values is a LIVE batch
  // and the page polls one per poll already (ADR 0010). Opening this panel is a deliberate act, so
  // the extra call is affordable here and nowhere else — which is what lets this surface see the
  // Levels the top line cannot: a leg rule's holding, and a holding no rule watches at all.
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const load = useCallback(async () => {
    try {
      setHoldings(await fetchHoldings());
    } catch {
      setHoldings([]);   // the rest of the panel is still worth showing
    }
  }, []);
  useEffect(() => { if (open) void load(); }, [open, load]);

  const items = needs(quotes, health, holdings);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Service</SheetTitle>
          <SheetDescription>
            Where things stand, in full — including when nothing needs you, which the page says by
            staying quiet.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4 flex flex-col gap-5">
          <section data-testid="needs">
            <h3 className="text-sm font-semibold mb-1">needs you</h3>
            {items.length === 0 ? (
              <p className="meta">nothing needs you</p>
            ) : (
              <ul className="meta">
                {items.map((n) => <li key={n.kind + n.text}>{n.text}</li>)}
              </ul>
            )}
          </section>

          {/* The facts the old strip carried, all of them, all the time — including a non-empty
              queue, which is not a fault but is worth seeing: a run is executing. */}
          <section data-testid="service">
            <h3 className="text-sm font-semibold mb-1">service</h3>
            <p className="meta">
              {`OpenD ${health ? (health.opend ? "up" : "down") : "unknown"}`}
              {health ? ` · alarms ${health.monitor.alarms.label}` : ""}
              {health ? ` · queue ${health.queue_depth}` : ""}
            </p>
            {health?.monitor.last_sweep_at
              ? <p className="meta">{`last sweep ${health.monitor.last_sweep_at}`}</p>
              : null}
          </section>

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
