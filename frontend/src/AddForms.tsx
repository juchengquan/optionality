import { useState } from "react";

const FIELDS = [
  "option_delta", "mid_price", "option_implied_volatility",
  "option_theta", "option_vega", "option_gamma",
];
// a combo's value is a signed sum, and IV is intensive — two 20% legs are not a 40% combo
const COMBO_FIELDS = FIELDS.filter((f) => f !== "option_implied_volatility");

export function AddMonitor({ onCreate }: { onCreate: (body: Record<string, unknown>) => void }) {
  const [form, setForm] = useState({
    strike_date: "", option_type: "CALL", strike: "", field: "option_delta",
    threshold: "", direction: "above", compare: "abs",
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <fieldset>
      <legend>Add monitor</legend>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCreate({ ...form, strike: Number(form.strike), threshold: Number(form.threshold) });
        }}
      >
        <label>expiry <input type="date" value={form.strike_date} onChange={(e) => set("strike_date", e.target.value)} required /></label>
        <label>type
          <select value={form.option_type} onChange={(e) => set("option_type", e.target.value)}>
            <option>CALL</option><option>PUT</option>
          </select>
        </label>
        <label>strike <input type="number" step="any" value={form.strike} onChange={(e) => set("strike", e.target.value)} required /></label>
        <label>field
          <select value={form.field} onChange={(e) => set("field", e.target.value)}>
            {FIELDS.map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label>threshold <input type="number" step="any" value={form.threshold} onChange={(e) => set("threshold", e.target.value)} required /></label>
        <label>direction
          <select value={form.direction} onChange={(e) => set("direction", e.target.value)}>
            <option>above</option><option>below</option>
          </select>
        </label>
        <label>compare
          <select value={form.compare} onChange={(e) => set("compare", e.target.value)}>
            <option value="abs">abs</option><option value="signed">signed</option>
          </select>
        </label>
        <button>watch</button>
      </form>
    </fieldset>
  );
}

interface LegInput { sign: string; option_type: string; strike: string }
const BLANK: LegInput = { sign: "+", option_type: "CALL", strike: "" };

export function AddCombo({ onCreate }: { onCreate: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState("");
  const [strikeDate, setStrikeDate] = useState("");
  const [field, setField] = useState("mid_price");
  const [threshold, setThreshold] = useState("");
  const [direction, setDirection] = useState("above");
  const [compare, setCompare] = useState("abs");
  const [legs, setLegs] = useState<LegInput[]>(Array.from({ length: 6 }, () => ({ ...BLANK })));

  const setLeg = (i: number, patch: Partial<LegInput>) =>
    setLegs((prev) => prev.map((l, j) => (i === j ? { ...l, ...patch } : l)));

  return (
    <fieldset>
      <legend>Add combo</legend>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCreate({
            name, strike_date: strikeDate, field, direction, compare,
            threshold: Number(threshold),
            // blank rows are skipped, as on /ui
            legs: legs
              .filter((l) => l.strike.trim() !== "")
              .map((l) => ({ sign: l.sign === "+" ? 1 : -1, option_type: l.option_type, strike: Number(l.strike) })),
          });
        }}
      >
        <label>name <input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>expiry <input type="date" value={strikeDate} onChange={(e) => setStrikeDate(e.target.value)} required /></label>
        {legs.map((leg, i) => (
          <label key={i}>leg {i + 1}
            <select value={leg.sign} onChange={(e) => setLeg(i, { sign: e.target.value })}>
              <option>+</option><option>-</option>
            </select>
            <select value={leg.option_type} onChange={(e) => setLeg(i, { option_type: e.target.value })}>
              <option>CALL</option><option>PUT</option>
            </select>
            <input type="number" step="any" placeholder="strike (blank = skip)" value={leg.strike}
                   onChange={(e) => setLeg(i, { strike: e.target.value })} />
          </label>
        ))}
        <label>field
          <select value={field} onChange={(e) => setField(e.target.value)}>
            {COMBO_FIELDS.map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label>threshold <input type="number" step="any" value={threshold} onChange={(e) => setThreshold(e.target.value)} required /></label>
        <label>direction
          <select value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option>above</option><option>below</option>
          </select>
        </label>
        <label>compare
          <select value={compare} onChange={(e) => setCompare(e.target.value)}>
            <option value="abs">abs</option><option value="signed">signed</option>
          </select>
        </label>
        <button>watch combo</button>
      </form>
    </fieldset>
  );
}
