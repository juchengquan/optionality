import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";

import { Field, FieldLabel } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";

import type { Entry, HoldingValues } from "./api";
import { ConfirmDelete } from "./ConfirmDelete";

/** Whether there is an entry to type here at all: a rule covering WHOLE holdings, and at least one
 *  of them.
 *
 *  A rule watching part of a structure has no entry of its own — that figure would be a fraction of
 *  someone else's credit (ADR 0003) — and an unheld rule has nothing to attach one to. Exported so
 *  the box and its label cannot disagree: the labelled row used to go up around a box that rendered
 *  nothing, leaving the word "entry" beside empty space, which reads as a control that has broken.
 */
export function hasEntryToType(entry: Entry): boolean {
  return entry.scope === "all" && entry.positions.length > 0;
}

/** Threshold, mute and delete. No optimistic update on any of them: these change what the
 *  alarm engine does, and the server's answer is the only truth about that. */
export function RowActions({
  entry, onPatch, onDelete, onRename, entryCell, holdingForm,
}: {
  entry: Entry;
  onPatch: (id: string, body: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  onRename?: (id: string, name: string) => void;
  /** The entry box, passed in so it can sit among the other labelled rows rather than
   *  floating above them with no heading of its own. */
  entryCell?: React.ReactNode;
  /** The full holding form — entry, side and Opened — which only the sheet has room for. */
  holdingForm?: React.ReactNode;
}) {
  // a number, not a string: NumberField parses and formats, so the component never
  // holds a half-typed value that Number() would silently turn into NaN
  const [threshold, setThreshold] = useState<number | null>(entry.threshold);
  const [name, setName] = useState(entry.code);
  const isCombo = Boolean(entry.legs);

  return (
    <>
      <Labelled label="threshold">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (threshold !== null) onPatch(entry.id, { threshold });
          }}
        >
          <NumberField className="w-28" value={threshold} onValueChange={setThreshold} required />
          <Button type="submit" variant="outline" size="sm">set</Button>
        </form>
      </Labelled>

      {entryCell && hasEntryToType(entry) ? <Labelled label="entry">{entryCell}</Labelled> : null}

      {holdingForm ? <Labelled label="holding">{holdingForm}</Labelled> : null}

      {isCombo && onRename ? (
        <Labelled label="name">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onRename(entry.id, name);
            }}
          >
            <Input className="w-40" value={name} onChange={(e) => setName(e.target.value)} required />
            <Button type="submit" variant="outline" size="sm">rename</Button>
          </form>
        </Labelled>
      ) : null}

      {/* muting is reversible and deleting is not, so they sit apart from the edits above
          and next to each other, where the difference between them is visible */}
      <div className="flex items-center gap-2 border-t pt-3 mt-1">
        <Button variant="ghost" size="sm" onClick={() => onPatch(entry.id, { enabled: false })}>mute</Button>
        <ConfirmDelete
          name={isCombo ? entry.code : (entry.snapshot?.name ?? entry.code)}
          what={isCombo ? "combo and its alarm rule" : "alarm rule"}
          onConfirm={() => onDelete(entry.id)}
        />
      </div>
    </>
  );
}

/** One labelled row: the name on the left, the control on the right, every row aligned to
 *  the same column. In the table these boxes sat under headers; in a panel they had none. */
function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** Entry is typed straight onto a rule watching exactly one holding. Where it spans several
 *  you type the TOTAL and the unrecorded wing is derived from it — a summed credit is not
 *  something you can type. */
/** Record what a holding cost and when it was put on — the FULL form, for the sheet.
 *
 *  The inline EntryCell below stays what it is: one number, for a holding that already exists.
 *  This is the only surface that can bring a holding into being, and that is deliberate — a
 *  create needs Opened too, and a create that quietly left it null would hand back a holding with
 *  no exit schedule, which is the complaint this whole change answers. A date field will not fit
 *  a table cell under ADR 0008's column budget, so the two surfaces split by what they can hold
 *  rather than duplicating. Both call one handler, so they cannot disagree.
 */
export function HoldingForm({ entry, onHolding }: {
  entry: Entry;
  onHolding: (row: Entry, values: HoldingValues) => void;
}) {
  const whole = entry.scope === "all" ? entry.positions : [];
  const [value, setValue] = useState<number | null>(entry.entry);
  const [openedAt, setOpenedAt] = useState("");
  // a lone contract has no signs to read a side from, so it has to be asked — exactly as the
  // add-monitor form asks. A combo's sides come from its legs.
  const [side, setSide] = useState("sold");
  const isCombo = Array.isArray(entry.legs);

  // Nothing to add for a rule spanning several holdings: the split credit is what EntryCell
  // already sends, there is nothing to create, and two Positions put on different days have no
  // single Opened — which is the same reason they get no schedule. Rendering anyway duplicated
  // EntryCell's box, down to its placeholder.
  if (whole.length > 1) return null;

  // A rule covering PART of a holding has no entry of its own — that figure is a fraction of
  // someone else's credit. Offering the form here posted a Position named after the rule and hit
  // the one already there, so this says where the entry actually lives rather than leaving a
  // blank space that invites the attempt again.
  if (whole.length === 0 && entry.positions.length > 0) {
    return (
      <p className="meta">
        {"part of "}
        {entry.positions.map((p) => p.name).join(", ")}
        {" — its entry and opened date are set on that holding's own row"}
      </p>
    );
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value === null) return;
        onHolding(entry, {
          entry: value,
          side: isCombo ? undefined : side,
          opened_at: openedAt === "" ? null : openedAt,
        });
      }}
    >
      <Field className="w-24">
        <FieldLabel htmlFor={`h-entry-${entry.id}`}>entry</FieldLabel>
        <NumberField id={`h-entry-${entry.id}`} value={value} onValueChange={setValue} />
      </Field>
      {isCombo || whole.length > 0 ? null : (
        <Field className="w-24">
          <FieldLabel htmlFor={`h-side-${entry.id}`}>side</FieldLabel>
          <NativeSelect id={`h-side-${entry.id}`} value={side}
                        onChange={(e) => setSide(e.target.value)}>
            <option value="sold">sold</option><option value="bought">bought</option>
          </NativeSelect>
        </Field>
      )}
      <Field className="w-40">
          {/* The only control in this app that sets Opened. Nothing set it before, so every
              schedule on screen got its date through the API by hand. Left BLANK rather than
              defaulting to today: a date nobody chose, under a figure as load-bearing as
              on-pace, is the guess ADR 0011 refuses — and it is wrong for exactly the trades
              most likely to be recorded late. */}
          <FieldLabel htmlFor={`h-opened-${entry.id}`}>opened</FieldLabel>
        <Input id={`h-opened-${entry.id}`} type="date" value={openedAt}
               onChange={(e) => setOpenedAt(e.target.value)} />
      </Field>
      <Button type="submit" variant="outline" size="sm">record</Button>
    </form>
  );
}

export function EntryCell({
  entry, onEntry, onTotal,
}: {
  entry: Entry;
  onEntry: (positionId: string, value: number) => void;
  onTotal: (monitorId: string, value: number) => void;
}) {
  const whole = entry.scope === "all" ? entry.positions : [];
  const single = whole.length === 1 ? whole[0] : undefined;
  const [value, setValue] = useState<number | null>(entry.entry);

  // the same predicate the labelled wrapper reads, so one of them cannot render without the other
  if (!hasEntryToType(entry)) return null;
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value === null) return;
        if (single) onEntry(single.id, value);
        else onTotal(entry.id, value);
      }}
    >
      <NumberField
        className="w-22"
        value={value}
        onValueChange={setValue}
        placeholder={single ? "entry" : "total"}
        required
      />
      <Button type="submit" variant="outline" size="sm">set</Button>
    </form>
  );
}
