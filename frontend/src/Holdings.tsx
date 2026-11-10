import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { OpenedField } from "./OpenedField";
import { NumberField } from "@/components/ui/number-field";

import {
  closePosition, deletePosition, fetchPositions, patchPosition, positionPatchBody, type Holding,
  type Recorded,
} from "./api";
import { ConfirmDelete } from "./ConfirmDelete";
import { fmt, marketDay } from "./format";
import { PaceLine } from "./PaceLine";

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
export function Holdings({ reloadKey, rows, error, load, act }: {
  reloadKey: number;
  /** The rows App holds, or null while they have not arrived. Owned up there rather than here
   *  because the IMAGE needs them too, and the picture must not depend on whether this panel
   *  happens to be open (App.saveImage). */
  rows: Holding[] | null;
  error: string | null;
  load: () => Promise<void>;
  /** App's own runner: it awaits the write, reloads, and puts the service's words in a toast on a
   *  refusal. Both writes here ran in a bare `void (async () => {})()` with no catch, so a refused
   *  delete or patch was an unhandled rejection — no toast, no reload, the row apparently
   *  untouched. Every other mutation on the dashboard goes through this. */
  act: (fn: () => Promise<void>) => void;
}) {
  const [open, setOpen] = useState(false);
  // bumped by a close, so the closed list re-reads the holding that has just joined it
  const [closes, setCloses] = useState(0);

  // only while open, and again when the refresh button says so. Closed, this costs nothing —
  // which is the whole point of fetching on demand, and the reason saving an image asks for them
  // itself rather than this panel fetching them in case a picture is taken.
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
      {/* No `data-snapshot` hook any more: the image used to CLONE this node, which is why it
          carried holdings only while this panel was open. It renders HoldingReadout itself now
          (SnapshotView), so nothing outside reaches in here. */}
      {!open ? null : (
        <div data-testid="holdings">
          <HoldingList
            rows={rows} error={error} pending={<p className="meta">loading…</p>}
            row={(h) => (
              <HoldingRow key={h.id} holding={h} act={act}
                          onSaved={() => void load()}
                          onClosed={() => { void load(); setCloses((n) => n + 1); }} />
            )}
          />
          <ClosedHoldings reloadKey={`${reloadKey}-${closes}`} act={act} />
        </div>
      )}
    </section>
  );
}

/** What has been held and closed, with what each made (ADR 0022).
 *
 *  Its own disclosure, ASKED FOR rather than fetched with the panel: it reads stored rows and costs
 *  no market call, but nothing else on the page needs it, and a list that only grows has no place
 *  above the holdings that need watching. The result is in POINTS, as the service says it: P&L is
 *  money and needs a contract size, which only a quote carries, and a closed holding has none. */
function ClosedHoldings({ reloadKey, act }: {
  reloadKey: string;
  act: (fn: () => Promise<void>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Recorded[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // bumped by a correction or a delete here, so the list re-reads what the service now says
  const [edits, setEdits] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchPositions().then(
      (all) => {
        if (!live) return;
        // selecting, not computing: which holdings are closed is the service's own field
        setRows(all.filter((p) => p.closed_on !== null));
        setError(null);
      },
      (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { live = false; };
  }, [open, reloadKey, edits]);

  return (
    <div className="border-t pt-2">
      <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" aria-expanded={open}
              onClick={() => setOpen((o) => !o)}>
        {`${open ? "▾" : "▸"} closed`}
      </Button>
      {!open ? null : (
        <div data-testid="closed-holdings" className="tabular-nums">
          {error !== null ? <p className="meta">{error}</p>
            : rows === null ? <p className="meta">loading…</p>
            : rows.length === 0 ? <p className="meta">Nothing closed yet.</p>
            : rows.map((p) => (
              <ClosedRow key={p.id} holding={p} act={act} onSaved={() => setEdits((n) => n + 1)} />
            ))}
        </div>
      )}
    </div>
  );
}

/** The exit, with its sign said out loud.
 *
 *  Exit is the Cost to close actually got, signed the way the Cost to close column is: positive
 *  when closing cost you (a credit structure bought back), negative when it paid you (a long
 *  sold). A positive sale price typed for a long reads as a large LOSS, so the field says which
 *  way round it goes rather than leaving the sign to be guessed — and the prefill, taken from the
 *  Cost to close, already has it. */
function ExitField({ id, value, onChange }: {
  id: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>exit — the cost to close you got, per contract</FieldLabel>
      <NumberField id={id} value={value} onValueChange={onChange} />
      <FieldDescription>
        signed like the cost to close: positive when closing cost you, negative when it paid you.
        Blank if you do not know it.
      </FieldDescription>
    </Field>
  );
}

/** One closed holding: what it made, and the two things a mistyped close needs — correcting it,
 *  which keeps the history, and deleting it, for a holding that should never have been recorded. */
function ClosedRow({ holding, act, onSaved }: {
  holding: Recorded;
  act: (fn: () => Promise<void>) => void;
  onSaved: () => void;
}) {
  const [exit, setExit] = useState<number | null>(holding.exit);
  const [closedOn, setClosedOn] = useState(holding.closed_on ?? "");
  const [why, setWhy] = useState<string | null>(null);
  return (
    <div data-testid={`closed-${holding.id}`} className="border-t py-2">
      <p>
        <strong>{holding.name}</strong>
        {` · closed ${holding.closed_on} · entry ${fmt(holding.entry, "mid")} → exit ${fmt(holding.exit, "mid")} · `}
        {holding.realized_points === null
          ? <span className="meta">result unknown</span>
          : `${fmt(holding.realized_points, "mid")} pts`}
      </p>
      <form
        className="mt-2 flex min-w-0 flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          // each field sent only when it says something; a blank exit is left as it was, because
          // the service takes a number here and an exit is cleared nowhere but the close itself
          const body: Record<string, unknown> = {};
          if (exit !== null) body.exit = exit;
          if (closedOn !== "") body.closed_on = closedOn;
          if (Object.keys(body).length === 0) {
            setWhy("Type the exit or the day it closed.");
            return;
          }
          setWhy(null);
          act(async () => {
            await patchPosition(holding.id, body);
            onSaved();
          });
        }}
      >
        <Field className="w-28">
          <FieldLabel htmlFor={`c-exit-${holding.id}`}>exit</FieldLabel>
          <NumberField id={`c-exit-${holding.id}`} value={exit} onValueChange={setExit} />
        </Field>
        <Field className="w-44">
          <FieldLabel htmlFor={`c-closed-${holding.id}`}>closed on</FieldLabel>
          <Input id={`c-closed-${holding.id}`} type="date" value={closedOn}
                 onChange={(e) => setClosedOn(e.target.value)} />
        </Field>
        <Button type="submit" variant="outline" size="sm" className="pointer-coarse:min-h-11">set</Button>
        <ConfirmDelete
          name={holding.name}
          what="holding"
          description={
            <>
              This removes the closed holding for good, with its recorded history — the daily cost
              to close and the per-leg volatility and vega, which nothing can rebuild. Correcting
              the exit or the day keeps all of it.
            </>
          }
          onConfirm={() => act(async () => {
            await deletePosition(holding.id);
            onSaved();
          })}
        />
        {why ? <p className="meta w-full" role="alert">{why}</p> : null}
      </form>
    </div>
  );
}

/** Close a holding — the way off the live list that KEEPS it (ADR 0022).
 *
 *  Asked like a delete, though for a different reason: a close cannot be undone from here either,
 *  and it switches off the rules that watched the holding. The exit is prefilled from the Cost to
 *  close the panel is already showing, because that is the figure the owner most likely just paid;
 *  it can be overwritten, or cleared to leave it unknown rather than guessed. */
function CloseHolding({ holding, act, onClosed }: {
  holding: Holding;
  act: (fn: () => Promise<void>) => void;
  onClosed: () => void;
}) {
  // The day is offered, not left blank as Opened is: a close is recorded the day it happens far
  // more often than not, and a wrong one is correctable on the closed list. It is the New York
  // TRADING day, the calendar the service keys a close on — or the expiry, if that came first,
  // since nothing is held past one and the service would refuse a later day.
  const offered = () => {
    const trading = marketDay();
    return holding.strike_date < trading ? holding.strike_date : trading;
  };
  const [exit, setExit] = useState<number | null>(holding.cost_to_close);
  const [closedOn, setClosedOn] = useState(offered);
  const id = `p-exit-${holding.id}`;
  return (
    <AlertDialog onOpenChange={(open) => {
      if (open) { setExit(holding.cost_to_close); setClosedOn(offered()); }
    }}>
      {/* 44px on a touch screen, where a finger is the pointer (Apple's minimum), and the row's
          own density at a desk, where the delete beside it is 28px */}
      <AlertDialogTrigger
        render={
          <Button type="button" variant="ghost" size="sm" className="pointer-coarse:min-h-11">
            close
          </Button>
        }
      />
      {/* held off the poll for the same reason the delete question is (App.beingOperated) */}
      <AlertDialogContent data-poll="hold">
        <AlertDialogHeader>
          <AlertDialogTitle>Close {holding.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It leaves the live list and is kept, with its entry, its opened date and its recorded
            history. The alarm rules watching it are switched off, and stay listed among the muted
            rules.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ExitField id={id} value={exit} onChange={setExit} />
        <Field>
          <FieldLabel htmlFor={`p-closed-${holding.id}`}>closed on (New York day)</FieldLabel>
          <Input id={`p-closed-${holding.id}`} type="date" value={closedOn}
                 onChange={(e) => setClosedOn(e.target.value)} />
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => act(async () => {
            // a cleared day is left to the service, which takes today's (or the expiry)
            const closed = await closePosition(
              holding.id, closedOn === "" ? { exit } : { exit, closed_on: closedOn },
            );
            const off = closed.disabled_monitors.map((m) => m.code);
            toast.add({
              title: off.length === 0
                ? `closed ${holding.name}`
                : `closed ${holding.name} — switched off ${off.join(", ")}`,
              type: "success",
            });
            onClosed();
          })}>
            Close holding
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** What is held, or why it cannot be said — in that order, for both doors onto it.
 *
 *  Four states: it could not be read, it has not arrived, nothing is held, here it is. The ORDER
 *  is the load-bearing part and the reason this is one function rather than a ladder written out
 *  in the panel and again in the picture (SnapshotView).
 *
 *  The error comes FIRST, over both of the others. Over "loading…", because printing that under
 *  the reason the load failed describes a fetch that is still coming when none is. And over the
 *  rows, which a failure deliberately LEAVES in place (App.loadHoldings): this precedence is the
 *  only thing that makes a cost to close nobody can vouch for unreachable, which is why clearing
 *  the rows as well changed nothing any test could see.
 *
 *  `pending` is each door's own, because the two want different things from "not yet": the panel
 *  says loading…, and the picture shows nothing — an omitted section and an empty one look
 *  identical in a still image, and "nothing held" is a claim about the account.
 */
export function HoldingList({ rows, error, pending = null, row }: {
  rows: Holding[] | null;
  error: string | null;
  pending?: ReactNode;
  row: (holding: Holding) => ReactNode;
}) {
  if (error !== null) return <p className="meta">{error}</p>;
  if (rows === null) return pending;
  if (rows.length === 0) return <p className="meta">Nothing held.</p>;
  return rows.map(row);
}

/** One holding, as figures alone: the name, its legs, the money and the pace.
 *
 *  Exported because the IMAGE renders it too (SnapshotView). It used to clone this panel's live
 *  node instead, which had two consequences: the picture carried holdings only while the panel
 *  happened to be open — so the same button gave two different images depending on a disclosure
 *  triangle — and the clone had to strip forms and unwrap buttons by hand, because it was a copy
 *  of something built for editing. Sharing the readout keeps what the clone was good for, which
 *  is that the two cannot say different things, and drops what it was bad at.
 *
 *  `beneath` is what follows the figures in the panel and not in the picture: the sentence about
 *  a missing opened date points at controls that a picture does not have.
 */
export function HoldingReadout({ holding, beneath }: {
  holding: Holding;
  beneath?: ReactNode;
}) {
  const s = holding.schedule;
  return (
    <>
      <p>
        <strong>{holding.name}</strong>
        {` · ${holding.legs.map((l) => `${l.side === "short" ? "-" : "+"}${l.option_type[0]}${l.strike}`).join(" ")}`}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums sm:grid-cols-4">
        {([
          ["entry", fmt(holding.entry, "mid")],
          ["cost to close", fmt(holding.cost_to_close, "mid")],
          // fmt, not String: WatchlistTable prints the same figure as 8.00, and a bare 8 broke
          // the tabular-nums alignment of the grid it sits in
          ["P&L", fmt(holding.pnl, "mid")],
          ["dte", String(holding.dte)],
        ] as [string, string][]).map(([label, value]) => (
          <div key={label}>
            <dt className="meta">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {s === null ? beneath : <PaceLine schedule={s} />}
    </>
  );
}

function HoldingRow({ holding, onSaved, onClosed, act }: {
  holding: Holding;
  onSaved: () => void;
  onClosed: () => void;
  act: (fn: () => Promise<void>) => void;
}) {
  return (
    <div data-testid={`holding-${holding.id}`} className="border-t py-3">
      <HoldingReadout
        holding={holding}
        beneath={<p className="meta">no opened date, so no exit schedule — set one below</p>}
      />
      <div className="flex flex-wrap items-end gap-2">
        <HoldingEdit holding={holding} onSaved={onSaved} act={act} />
        {/* Closing comes before deleting: it is how a trade normally ends, and it keeps what
            deleting throws away (ADR 0022). Delete stays, for a holding recorded by mistake. */}
        <CloseHolding holding={holding} act={act} onClosed={onClosed} />
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
          onConfirm={() => act(async () => {
            await deletePosition(holding.id);
            onSaved();
          })}
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
function HoldingEdit({ holding, onSaved, act }: {
  holding: Holding;
  onSaved: () => void;
  act: (fn: () => Promise<void>) => void;
}) {
  const [value, setValue] = useState<number | null>(holding.entry);
  const [openedAt, setOpenedAt] = useState(holding.opened_at ?? "");
  const [why, setWhy] = useState<string | null>(null);

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
        // whatever was filled in, each omitted rather than nulled, and either field alone is
        // enough — all three rules in one place, shared with the watchlist row's own form
        // (api.positionPatchBody).
        //
        // `if (value === null) return` used to gate the whole thing on an entry, which made this
        // a silent no-op on a holding that has none — the very case the panel exists for, directly
        // under a line telling the owner to set an opened date here.
        const body = positionPatchBody({ entry: value, opened_at: openedAt });
        if (body === null) {
          // and it must SAY so. Sending nothing was already right; saying nothing was the half
          // this form still had wrong, in the same words the watchlist row uses (RowActions).
          setWhy("Type the entry or the day it was opened — a holding needs at least one.");
          return;
        }
        setWhy(null);
        act(async () => {
          await patchPosition(holding.id, body);
          onSaved();
        });
      }}
    >
      <Field className="w-24">
        <FieldLabel htmlFor={`p-entry-${holding.id}`}>entry</FieldLabel>
        <NumberField id={`p-entry-${holding.id}`} value={value} onValueChange={setValue} />
      </Field>
      <OpenedField className="w-44" id={`p-opened-${holding.id}`}
                   value={openedAt} onChange={setOpenedAt} />
      <Button type="submit" variant="outline" size="sm">set</Button>
      {why ? <p className="meta w-full" role="alert">{why}</p> : null}
    </form>
  );
}
