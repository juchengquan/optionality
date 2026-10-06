import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet,
} from "@/components/ui/field";
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
  // The holding, if there is one. A combo derives each leg's side from the sign the user gave it;
  // a lone option has no sign and can be either side, so this asks. It has to: entry is a net
  // credit RECEIVED, so a long is stored negative, and a long recorded positive reports a P&L of
  // +1300 where +300 is right. The form owns that signing so the number typed is always what
  // moved — "paid 5.00" is 5.00 here and −5.00 in the service.
  const [side, setSide] = useState("sold");
  const [entry, setEntry] = useState<number | null>(null);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <FieldSet>
      <FieldLegend>Add monitor</FieldLegend>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (strike === null || threshold === null) return;
          onCreate({ ...form, strike, threshold, side, entry });
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
          {/* The side and the amount are ONE fact — which way the money went — so they sit on one
              row rather than becoming two independent controls that could contradict each other.
              The label on the box follows the side, so the number typed is always just what
              moved. Blank watches a strike you do not hold, which is the common case. */}
          <Field orientation="horizontal" className="*:data-[slot=field-label]:flex-none">
            <FieldLabel htmlFor="m-entry">entry</FieldLabel>
            <NativeSelect aria-label="side" value={side} onChange={(e) => setSide(e.target.value)}>
              <option value="sold">sold</option><option value="bought">bought</option>
            </NativeSelect>
            <NumberField id="m-entry" value={entry} onValueChange={setEntry}
                         placeholder={side === "sold" ? "received" : "paid"} />
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
  // null means "not held" rather than zero: a combo you only watch has no entry, and an entry
  // of 0 is a real credit of nothing. The service keeps the two apart, so the form must too.
  const [entry, setEntry] = useState<number | null>(null);
  // two to start, up to six. The fixed six were an htmx artefact -- rendering a variable
  // number of rows server-side was awkward -- and that constraint left with htmx. A
  // vertical spread is two legs and an iron condor is four, so the old form drew two to
  // four permanently empty rows, which is most of a phone screen.
  const [legs, setLegs] = useState<LegInput[]>([{ ...BLANK }, { ...BLANK }]);

  const setLeg = (i: number, patch: Partial<LegInput>) =>
    setLegs((prev) => prev.map((l, j) => (i === j ? { ...l, ...patch } : l)));
  const MAX_LEGS = 6;

  return (
    <FieldSet>
      <FieldLegend>Add combo</FieldLegend>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (threshold === null) return;
          onCreate({
            name, strike_date: strikeDate, field, direction, compare, threshold, entry,
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
          {/* A leg is four controls on one line, which the horizontal Field is not built for:
              it assumes label + ONE control and gives the label `flex-auto` — grow AND
              shrink — so the label is squeezed below the width of its own text. "leg 1"
              needs 31px and was given 20 on a phone and 30 at a desk, wrapping to "leg"/"1"
              and making every row 39px tall for a 32px control. flex-none is its text's
              width; the strike box takes what is left, which is 114px at the narrowest.
              Nothing is set on the NumberField: its class would land on the inner input,
              while the flex item is Base UI's wrapper, so it would do nothing at all. */}
          {legs.map((leg, i) => (
            <Field key={i} orientation="horizontal"
                   className="*:data-[slot=field-label]:flex-none">
              <FieldLabel htmlFor={`c-leg-${i}-strike`}>leg {i + 1}</FieldLabel>
              <NativeSelect aria-label={`leg ${i + 1} sign`} value={leg.sign}
                            onChange={(e) => setLeg(i, { sign: e.target.value })}>
                <option>+</option><option>-</option>
              </NativeSelect>
              <NativeSelect aria-label={`leg ${i + 1} type`} value={leg.option_type}
                            onChange={(e) => setLeg(i, { option_type: e.target.value })}>
                <option>CALL</option><option>PUT</option>
              </NativeSelect>
              {/* "strike (blank = skip)" wants 138px and the box has 100px of text room on a
                  phone, so the hint was never readable where it mattered; the sheet says it */}
              <NumberField id={`c-leg-${i}-strike`} placeholder="strike"
                           value={leg.strike} onValueChange={(v) => setLeg(i, { strike: v })} />
            </Field>
          ))}
          {legs.length < MAX_LEGS ? (
            <Button type="button" variant="outline" size="sm"
                    onClick={() => setLegs((prev) => [...prev, { ...BLANK }])}>
              add leg
            </Button>
          ) : null}
          {/* The one thing on this form that is not about the alarm: what you took in. The
              service records it on a HOLDING and never on the rule — a monitor warns, it does
              not record what you own — so filling this in creates both, and the row's entry and
              P&L start reading. Blank watches a structure you do not hold, which is legitimate
              and was all this form could do before. */}
          <Field>
            <FieldLabel htmlFor="c-entry">entry</FieldLabel>
            <NumberField id="c-entry" value={entry} onValueChange={setEntry} />
            <FieldDescription>
              The credit taken in — negative if the structure cost you. Blank if you are only
              watching.
            </FieldDescription>
          </Field>
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
