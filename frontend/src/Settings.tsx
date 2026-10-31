import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useEffect, useState } from "react";

import { type Entry, type Health, type Holding } from "./api";
import { type Grouping, type Signal } from "./columns";
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
 *  Deliberately NOT in here: the service's own status. If the Provider is down or the alarm engine has
 *  stalled, every figure on the page is suspect and the bell may be silent — that is exactly when
 *  it must not be a click away. It stays on the page, and shows only when it has something to say.
 *
 *  Also not in here: the column pickers. Each one belongs beside the table it governs (ADR 0008),
 *  and collecting them into a settings panel would need sub-headings to explain which table each
 *  section meant, which is the sign that the grouping is wrong.
 */
export function Settings({
  open, onClose, refresh, onRefresh, sweepSeconds, quotes, health, reading, band, onReading, onBand,
  grouping, onGrouping, holdings, holdingsError, loadHoldings,
}: {
  open: boolean;
  onClose: () => void;
  refresh: number;
  quotes: Entry[];
  health: Health | null;
  /** The page's rows, not a copy of its own. This panel had its own `fetchHoldings`, its own
   *  state and its own catch — a second copy of what `App.loadHoldings` owns, which is the very
   *  thing that made the picture and the holdings panel disagree once. "needs you" is where
   *  disagreeing matters most: it is the only surface that names a holding no rule watches. */
  holdings: Holding[] | null;
  holdingsError: string | null;
  loadHoldings: () => Promise<void>;
  reading: Signal;
  band: number;
  onReading: (signal: Signal) => void;
  onBand: (band: number) => void;
  grouping: Grouping;
  onGrouping: (grouping: Grouping) => void;
  onRefresh: (seconds: number) => void;
  sweepSeconds?: number;
}) {
  useDismissOnBack(open, onClose);

  const [bandText, setBandText] = useState(String(band));
  useEffect(() => { if (open) setBandText(String(band)); }, [open, band]);

  // Asked for only while open, as the holdings list itself does: /positions/values is a LIVE
  // batch and the page polls one per poll already (ADR 0010). Opening this panel is a deliberate
  // act, so the extra call is affordable here and nowhere else — which is what lets this surface
  // see the Levels the top line cannot: a leg rule's holding, and a holding no rule watches at
  // all. The rows it asks for land in the PAGE's state, so the one fetch serves every surface
  // that wants them.
  useEffect(() => { if (open) void loadHoldings(); }, [open, loadHoldings]);

  const items = needs(quotes, health, holdings ?? []);

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
            {/* and say so when the list cannot be complete. It fell back to NO holdings and
                said nothing, so a panel whose own description promises "in full" could quietly
                omit the one need no rule can state — a holding at its target that nothing
                watches. The needs it CAN state are still listed; only the claim of fullness is
                withdrawn. */}
            {holdingsError !== null ? (
              <p className="meta">{`the holdings could not be read, so this may be short — ${holdingsError}`}</p>
            ) : null}
            {items.length === 0 ? (
              holdingsError === null ? <p className="meta">nothing needs you</p> : null
            ) : (
              <ul className="meta">
                {items.map((n) => <li key={n.kind + n.text}>{n.text}</li>)}
              </ul>
            )}
          </section>

          {/* The facts the old strip carried, all of them, all the time. The run queue used to be
              one; it went with the run pipeline in phase 10 (ADR 0014). */}
          <section data-testid="service">
            <h3 className="text-sm font-semibold mb-1">service</h3>
            <p className="meta">
              {/* the Provider names itself (ADR 0015): this said "OpenD" whatever was behind the
                  port, and with a second Provider that would have been a lie on screen */}
              {health ? `${health.provider.name} ${health.provider.ok ? "up" : "down"}` : "provider unknown"}
              {health ? ` · alarms ${health.monitor.alarms.label}` : ""}
            </p>
            {health?.monitor.last_sweep_at
              ? <p className="meta">{`last sweep ${health.monitor.last_sweep_at}`}</p>
              : null}
          </section>

          <Field>
            <FieldLabel htmlFor="s-signal">flag on</FieldLabel>
            <NativeSelect
              id="s-signal"
              aria-label="flag on"
              value={reading}
              onChange={(e) => onReading(e.target.value === "pressure" ? "pressure" : "distance")}
            >
              <option value="distance">distance — how close to firing</option>
              <option value="pressure">pressure — close, and soon</option>
            </NativeSelect>
            <FieldDescription>
              What earns a row the second colour. <b>Distance</b> is the bar itself: one small move
              and Telegram sends, whether expiry is tomorrow or in seven weeks. <b>Pressure</b>
              weighs that by how little time is left, so 99% at 48 DTE sits quiet while 70% at 3 DTE
              does not{health ? ` — the horizon is your manage-by, ${health.settings.manage_by_dte} DTE` : ""}.
              Neither changes the bar, which is always the distance.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="s-band">flag above</FieldLabel>
            {/* The text is held here and only a VALID value is committed. Bound straight to the
                number, the field cannot be edited at all: clearing it sends "" , which is rejected,
                so React puts the old value back and every keystroke appends to it. Same reason
                NumberField exists for the threshold box. */}
            <Input
              id="s-band"
              aria-label="flag above"
              type="number"
              min={1}
              max={100}
              value={bandText}
              onChange={(e) => {
                setBandText(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value !== "" && Number.isFinite(n) && n >= 1 && n <= 100) onBand(n);
              }}
              onBlur={() => setBandText(String(band))}
            />
            <FieldDescription>
              The colour is worth having only while it stays rare. On 2026-10-17 the book read
              99/97/94/94/88/53/49, so a band of 90 put four of seven rows in it. Pressure is a
              discounted fill, so the two readings are not on one scale — switching to it without
              lowering this turns the colour off rather than moving it.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="s-group">group rows by</FieldLabel>
            <NativeSelect
              id="s-group"
              aria-label="group rows by"
              value={grouping}
              onChange={(e) => onGrouping(
                e.target.value === "type" || e.target.value === "expiry" ? e.target.value : "none",
              )}
            >
              <option value="none">nothing — one list, as the service returns it</option>
              <option value="type">calls and puts</option>
              <option value="expiry">expiry</option>
            </NativeSelect>
            <FieldDescription>
              Divides each table without re-sorting it: every group keeps the order it already had.
              <b>Calls and puts</b> puts the two wings of a structure together, calls above puts; a
              spread is grouped by its legs, and a condor, being both, gets its own heading.{" "}
              <b>Expiry</b> answers the other question a book of several asks — what is happening to
              one of them. Neither draws a heading where there is only one group to head.
            </FieldDescription>
          </Field>

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
