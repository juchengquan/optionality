import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";

import type { Entry } from "./api";
import { ConfirmDelete } from "./ConfirmDelete";

/** Threshold, mute and delete. No optimistic update on any of them: these change what the
 *  alarm engine does, and the server's answer is the only truth about that. */
export function RowActions({
  entry, onPatch, onDelete, onRename,
}: {
  entry: Entry;
  onPatch: (id: string, body: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  onRename?: (id: string, name: string) => void;
}) {
  // a number, not a string: NumberField parses and formats, so the component never
  // holds a half-typed value that Number() would silently turn into NaN
  const [threshold, setThreshold] = useState<number | null>(entry.threshold);
  const [name, setName] = useState(entry.code);
  const isCombo = Boolean(entry.legs);

  return (
    <>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (threshold !== null) onPatch(entry.id, { threshold });
        }}
      >
        <NumberField className="w-22" value={threshold} onValueChange={setThreshold} required />
        <Button type="submit" variant="outline" size="sm">set</Button>
      </form>
      {isCombo && onRename ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onRename(entry.id, name);
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
          <Button type="submit" variant="outline" size="sm">rename</Button>
        </form>
      ) : null}
      <Button variant="ghost" size="sm" onClick={() => onPatch(entry.id, { enabled: false })}>mute</Button>
      <ConfirmDelete
        name={isCombo ? entry.code : (entry.snapshot?.name ?? entry.code)}
        what={isCombo ? "combo and its alarm rule" : "alarm rule"}
        onConfirm={() => onDelete(entry.id)}
      />
    </>
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
