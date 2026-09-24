import { PROTECTED, type Column } from "./columns";

interface Picker {
  table: "single" | "combo";
  label: string;
  all: Column[];
  hidden: Set<string>;
  onToggle: (table: "single" | "combo", key: string, shown: boolean) => void;
  onReset: (table: "single" | "combo") => void;
}

export function ColumnPickers({ pickers }: { pickers: Picker[] }) {
  return (
    <div id="column-pickers" className="health">
      {pickers.map(({ table, label, all, hidden, onToggle, onReset }) => (
        <details key={table}>
          <summary>{label} columns</summary>
          {all
            .filter((c) => !PROTECTED.has(c.key))
            .map((c) => (
              <label className="colpick" key={c.key}>
                <input
                  type="checkbox"
                  checked={!hidden.has(c.key)}
                  onChange={(e) => onToggle(table, c.key, e.target.checked)}
                />{" "}
                {c.label}
              </label>
            ))}
          <button onClick={() => onReset(table)}>show all</button>
        </details>
      ))}
    </div>
  );
}
