import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { NumberField } from "@/components/ui/number-field";

const FIELDS = [
  "option_delta", "mid_price", "option_implied_volatility",
  "option_theta", "option_vega", "option_gamma",
];
// a combo's value is a signed sum, and IV is intensive — two 20% legs are not a 40% combo
const COMBO_FIELDS = FIELDS.filter((f) => f !== "option_implied_volatility");

/** These stayed NATIVE selects, styled to match the rest, rather than becoming custom
 *  listboxes. On a phone a native select opens the OS picker; a custom one cannot. The
 *  only thing given up is styling the open list, and the longest list here is six field
 *  names in plain text — there is nothing to style. See ADR 0007. */

export function AddMonitor({ onCreate }: { onCreate: (body: Record<string, unknown>) => void }) {
  const [form, setForm] = useState({
    strike_date: "", option_type: "CALL", field: "option_delta",
    direction: "above", compare: "abs",
  });
  // numbers are held as numbers: a string that Number() turns into NaN on submit is a
  // strike the service rejects, and the form had no way to notice
  const [strike, setStrike] = useState<number | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <FieldSet>
      <FieldLegend>Add monitor</FieldLegend>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (strike === null || threshold === null) return;
          onCreate({ ...form, strike, threshold });
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="m-expiry">expiry</FieldLabel>
            <Input id="m-expiry" type="date" value={form.strike_date}
                   onChange={(e) => set("strike_date", e.target.value)} required />
          </Field>
          <Field>
            <FieldLabel htmlFor="m-type">type</FieldLabel>
            <NativeSelect id="m-type" value={form.option_type}
                          onChange={(e) => set("option_type", e.target.value)}>
              <option>CALL</option><option>PUT</option>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="m-strike">strike</FieldLabel>
            <NumberField id="m-strike" value={strike} onValueChange={setStrike} required />
          </Field>
          <Field>
            <FieldLabel htmlFor="m-field">field</FieldLabel>
            <NativeSelect id="m-field" value={form.field} onChange={(e) => set("field", e.target.value)}>
              {FIELDS.map((f) => <option key={f}>{f}</option>)}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="m-threshold">threshold</FieldLabel>
            <NumberField id="m-threshold" value={threshold} onValueChange={setThreshold} required />
          </Field>
          <Field>
            <FieldLabel htmlFor="m-direction">direction</FieldLabel>
            <NativeSelect id="m-direction" value={form.direction}
                          onChange={(e) => set("direction", e.target.value)}>
              <option>above</option><option>below</option>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="m-compare">compare</FieldLabel>
            <NativeSelect id="m-compare" value={form.compare}
                          onChange={(e) => set("compare", e.target.value)}>
              <option value="abs">abs</option><option value="signed">signed</option>
            </NativeSelect>
          </Field>
          <Button type="submit">watch</Button>
        </FieldGroup>
      </form>
    </FieldSet>
  );
}

interface LegInput { sign: string; option_type: string; strike: number | null }
const BLANK: LegInput = { sign: "+", option_type: "CALL", strike: null };

export function AddCombo({ onCreate }: { onCreate: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState("");
  const [strikeDate, setStrikeDate] = useState("");
  const [field, setField] = useState("mid_price");
  const [threshold, setThreshold] = useState<number | null>(null);
  const [direction, setDirection] = useState("above");
  const [compare, setCompare] = useState("abs");
  const [legs, setLegs] = useState<LegInput[]>(Array.from({ length: 6 }, () => ({ ...BLANK })));

  const setLeg = (i: number, patch: Partial<LegInput>) =>
    setLegs((prev) => prev.map((l, j) => (i === j ? { ...l, ...patch } : l)));

  return (
    <FieldSet>
      <FieldLegend>Add combo</FieldLegend>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (threshold === null) return;
          onCreate({
            name, strike_date: strikeDate, field, direction, compare, threshold,
            // blank rows are skipped, as on /ui
            legs: legs
              .filter((l) => l.strike !== null)
              .map((l) => ({ sign: l.sign === "+" ? 1 : -1, option_type: l.option_type, strike: l.strike })),
          });
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="c-name">name</FieldLabel>
            <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field>
            <FieldLabel htmlFor="c-expiry">expiry</FieldLabel>
            <Input id="c-expiry" type="date" value={strikeDate}
                   onChange={(e) => setStrikeDate(e.target.value)} required />
          </Field>
          {legs.map((leg, i) => (
            <Field key={i} orientation="horizontal">
              <FieldLabel htmlFor={`c-leg-${i}-strike`}>leg {i + 1}</FieldLabel>
              <NativeSelect aria-label={`leg ${i + 1} sign`} value={leg.sign}
                            onChange={(e) => setLeg(i, { sign: e.target.value })}>
                <option>+</option><option>-</option>
              </NativeSelect>
              <NativeSelect aria-label={`leg ${i + 1} type`} value={leg.option_type}
                            onChange={(e) => setLeg(i, { option_type: e.target.value })}>
                <option>CALL</option><option>PUT</option>
              </NativeSelect>
              <NumberField id={`c-leg-${i}-strike`} placeholder="strike (blank = skip)"
                           value={leg.strike} onValueChange={(v) => setLeg(i, { strike: v })} />
            </Field>
          ))}
          <Field>
            <FieldLabel htmlFor="c-field">field</FieldLabel>
            <NativeSelect id="c-field" value={field} onChange={(e) => setField(e.target.value)}>
              {COMBO_FIELDS.map((f) => <option key={f}>{f}</option>)}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="c-threshold">threshold</FieldLabel>
            <NumberField id="c-threshold" value={threshold} onValueChange={setThreshold} required />
          </Field>
          <Field>
            <FieldLabel htmlFor="c-direction">direction</FieldLabel>
            <NativeSelect id="c-direction" value={direction}
                          onChange={(e) => setDirection(e.target.value)}>
              <option>above</option><option>below</option>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="c-compare">compare</FieldLabel>
            <NativeSelect id="c-compare" value={compare} onChange={(e) => setCompare(e.target.value)}>
              <option value="abs">abs</option><option value="signed">signed</option>
            </NativeSelect>
          </Field>
          <Button type="submit">watch combo</Button>
        </FieldGroup>
      </form>
    </FieldSet>
  );
}
