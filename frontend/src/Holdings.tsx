import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";

import { deletePosition, fetchHoldings, type Holding } from "./api";
import { ConfirmDelete } from "./ConfirmDelete";
import { DASH, fmt } from "./format";

/** What you actually HOLD, as distinct from what is watched.
 *
 *  The dashboard rendered rules only — /quotes and /monitors — so a holding no rule watches had
 *  no screen anywhere. That is not a rare corner: a contract claimed by two holdings is never
 *  adopted, because positionsHolding declines rather than guess whose credit it is, and any
 *  holding entered before its rule is in the same state. Found with a live put spread that had
 *  an entry, a P&L and a working exit schedule and appeared on nothing.
 *
 *  A LIST, not a table. The watchlist's tables earn their column machinery (ADR 0008) because
 *  they carry thirteen columns and a picker; there are a handful of holdings and no reason to
 *  reinvent the fitting here, and label-and-value blocks need no fitting at any width.
 */
export function Holdings({ reloadKey }: { reloadKey: number }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Holding[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await fetchHoldings());
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // only while open, and again when the refresh button says so. Closed, this costs nothing —
  // which is the whole point of fetching on demand.
  useEffect(() => {
    if (open) void load();
  }, [open, reloadKey, load]);

  return (
    <section>
      <h2>
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {`${open ? "▾" : "▸"} holdings`}
        </Button>
      </h2>
      {!open ? null : (
        <div data-testid="holdings">
          {error !== null ? <p className="meta">{error}</p> : null}
          {rows === null ? <p className="meta">loading…</p>
            : rows.length === 0 ? <p className="meta">Nothing held.</p>
              : rows.map((h) => <HoldingRow key={h.id} holding={h} onSaved={load} />)}
        </div>
      )}
    </section>
  );
}

function HoldingRow({ holding, onSaved }: { holding: Holding; onSaved: () => void }) {
  const s = holding.schedule;
  return (
    <div data-testid={`holding-${holding.id}`} className="border-t py-3">
      <p>
        <strong>{holding.name}</strong>
        {` · ${holding.legs.map((l) => `${l.side === "sold" ? "-" : "+"}${l.option_type[0]}${l.strike}`).join(" ")}`}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums sm:grid-cols-4">
        {([
          ["entry", fmt(holding.entry, "mid")],
          ["cost to close", fmt(holding.cost_to_close, "mid")],
          ["P&L", holding.pnl === null ? DASH : String(holding.pnl)],
          ["dte", String(holding.dte)],
        ] as [string, string][]).map(([label, value]) => (
          <div key={label}>
            <dt className="meta">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {/* The same words the row sheet uses, for the same reason: BEHIND means costing more than
          time alone accounts for, and a bare signed gap beside a P&L — where positive is good —
          reads backwards (RowDetail.tsx:89). */}
      {s === null ? (
        <p className="meta">no opened date, so no exit schedule — set one below</p>
      ) : (
        <>
          <p className="meta">
            {`opened at ${s.dte_at_open} DTE`}
            {s.pace_gap === null ? null : (
              <>
                {" · "}
                <strong>
                  {s.pace_gap > 0 ? "behind" : "ahead"}
                  {` by ${Math.abs(s.pace_gap).toFixed(2)}`}
                </strong>
              </>
            )}
          </p>
          <p className="meta">
            {`on pace ${fmt(s.on_pace, "mid")} · target ${fmt(s.target, "mid")}`}
            {` · stop ${fmt(s.stop, "mid")} · manage by ${s.manage_by_dte} DTE`}
          </p>
        </>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <HoldingEdit holding={holding} onSaved={onSaved} />
        {/* Guarded like a rule delete, and for a stronger reason: a rule can be MUTED instead and
            unmuted with one click, and a holding cannot. Entry and Opened could be typed again;
            the samples could not, since IV and vega are only knowable on the day they were
            observed — for the live condor they are the only vol history that exists. */}
        <ConfirmDelete
          name={holding.name}
          what="holding"
          description={
            <>
              This removes the holding for good, with its entry, its opened date and its recorded
              history — the daily cost to close and the per-leg volatility and vega, which no
              later sweep can rebuild. The alarm rules are kept; they stop knowing what they were
              watching.
            </>
          }
          onConfirm={() => { void (async () => { await deletePosition(holding.id); onSaved(); })(); }}
        />
      </div>
    </div>
  );
}

/** Entry and Opened, on the holding they belong to.
 *
 *  This is the row #113 pointed at and that did not exist: told that an entry "is set on that
 *  holding's own row", the owner had nowhere to go for a holding no rule watched. A plain patch
 *  by id — the holding is already identified, so there is nothing here to derive.
 */
function HoldingEdit({ holding, onSaved }: { holding: Holding; onSaved: () => void }) {
  const [value, setValue] = useState<number | null>(holding.entry);
  const [openedAt, setOpenedAt] = useState(holding.opened_at ?? "");

  // `min-w-0` is load-bearing, not decoration. This form sits inside a flex row beside the delete
  // button, and a flex item's default `min-width: auto` refuses to shrink below its content — so
  // the form measured 312px inside a 296px container at 320px and pushed the page sideways. The
  // browser test caught it. With min-w-0 the fields shrink as they did before it was nested.
  //
  // No flex-wrap here, though: it reads like the obvious guard against these controls being
  // squeezed, and it is inert. The row never wraps because the fields shrink first — at 320px the
  // entry field goes 96px -> 81px and the date 160px -> 159px, both still above the minimums the
  // browser test asserts. Below 320px is untested and unclaimed. A mutation sweep found removing
  // the class changed nothing, the same finding as the shrink-0 and flex-1 in AddForms.tsx.
  return (
    <form
      className="mt-2 flex min-w-0 items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value === null) return;
        const body: Record<string, unknown> = { entry: value };
        // omitted rather than nulled: PositionPatch takes no null, and "leave it alone" is the
        // right meaning for a field nobody filled in
        if (openedAt !== "") body.opened_at = openedAt;
        void (async () => {
          const { patchPosition } = await import("./api");
          await patchPosition(holding.id, body);
          onSaved();
        })();
      }}
    >
      <Field className="w-24">
        <FieldLabel htmlFor={`p-entry-${holding.id}`}>entry</FieldLabel>
        <NumberField id={`p-entry-${holding.id}`} value={value} onValueChange={setValue} />
      </Field>
      <Field className="w-40">
        <FieldLabel htmlFor={`p-opened-${holding.id}`}>opened</FieldLabel>
        <Input id={`p-opened-${holding.id}`} type="date" value={openedAt}
               onChange={(e) => setOpenedAt(e.target.value)} />
      </Field>
      <Button type="submit" variant="outline" size="sm">set</Button>
    </form>
  );
}
