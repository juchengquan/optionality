import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";

import type { Entry } from "./api";
import { ConfirmDelete } from "./ConfirmDelete";

/** Threshold, mute and delete. No optimistic update on any of them: these change what the
 *  alarm engine does, and the server's answer is the only truth about that. */
export function RowActions({
  entry, onPatch, onDelete, onRename, entryCell,
}: {
  entry: Entry;
  onPatch: (id: string, body: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  onRename?: (id: string, name: string) => void;
  /** The entry box, passed in so it can sit among the other labelled rows rather than
   *  floating above them with no heading of its own. */
  entryCell?: React.ReactNode;
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

      {entryCell ? <Labelled label="entry">{entryCell}</Labelled> : null}

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
export function EntryCell({
  entry, onEntry, onTotal,
}: {
  entry: Entry;
  onEntry: (positionId: string, value: number) => void;
  onTotal: (monitorId: string, value: number) => void;
}) {
  const whole = entry.scope === "all" ? entry.positions : [];
  const single = whole.length === 1 ? whole[0] : undefined;
  const spanning = whole.length > 1;
  const [value, setValue] = useState<number | null>(entry.entry);

  if (!single && !spanning) return null;
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
