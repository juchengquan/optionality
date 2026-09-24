import { useState } from "react";

import type { Entry } from "./api";

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
  const [threshold, setThreshold] = useState(String(entry.threshold));
  const [name, setName] = useState(entry.code);
  const isCombo = Boolean(entry.legs);

  return (
    <>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          onPatch(entry.id, { threshold: Number(threshold) });
        }}
      >
        <input type="number" step="any" value={threshold} onChange={(e) => setThreshold(e.target.value)} required />
        <button>set</button>
      </form>
      {isCombo && onRename ? (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            onRename(entry.id, name);
          }}
        >
          <input type="text" size={14} value={name} onChange={(e) => setName(e.target.value)} required />
          <button>rename</button>
        </form>
      ) : null}
      <button onClick={() => onPatch(entry.id, { enabled: false })}>mute</button>
      <button onClick={() => onDelete(entry.id)}>delete</button>
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
  const [value, setValue] = useState(entry.entry === null ? "" : String(entry.entry));

  if (!single && !spanning) return null;
  return (
    <form
      className="inline"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(value);
        if (single) onEntry(single.id, n);
        else onTotal(entry.id, n);
      }}
    >
      <input
        type="number"
        step="any"
        value={value}
        placeholder={single ? "entry" : "total"}
        onChange={(e) => setValue(e.target.value)}
        required
      />
      <button>set</button>
    </form>
  );
}
